// Suwayomi-Server GraphQL client. Names checked against Suwayomi v2.4 (introspection, 2026-10-31).
import { config, log } from "./db.ts";

const auth: Record<string, string> = config.suwayomiUser
  ? { Authorization: `Basic ${Buffer.from(`${config.suwayomiUser}:${config.suwayomiPass}`).toString("base64")}` }
  : {};

export async function gql<T>(query: string, variables: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(`${config.suwayomiUrl}/api/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...auth },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Suwayomi HTTP ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`Suwayomi: ${body.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  return body.data as T;
}

/** Raw GET against Suwayomi (thumbnails, page images). Path comes from Suwayomi itself. */
export const suwayomiGet = (path: string) =>
  fetch(`${config.suwayomiUrl}${path}`, { headers: auth, signal: AbortSignal.timeout(60_000) });

export interface RemoteManga {
  id: number;
  title: string;
  url: string;
  thumbnailUrl: string | null;
}
export interface RemoteChapter {
  id: number;
  chapterNumber: number;
  sourceOrder: number;
  name: string;
  scanlator: string | null;
  isDownloaded: boolean;
}
export interface SuwaSource {
  id: string;
  name: string;
  lang: string;
  displayName: string;
  iconUrl: string;
}
export interface Extension {
  pkgName: string;
  name: string;
  lang: string;
  iconUrl: string;
  isInstalled: boolean;
  isNsfw?: boolean;
  contentWarning?: string;
}

export const LOCAL_SOURCE = "0";
const CATEGORY = "Mangarr";

/** Settings mangarr relies on. Run at start-up; safe to repeat. */
export async function setup() {
  await gql(
    `mutation ($s: PartialSettingsTypeInput!) { setSettings(input: { settings: $s }) { clientMutationId } }`,
    {
      s: {
        downloadAsCbz: true,
        autoDownloadNewChapters: false, // mangarr decides what gets downloaded
        downloadsPath: config.downloads,
        localSourcePath: config.library,
        ...(config.flareSolverrUrl ? { flareSolverrEnabled: true, flareSolverrUrl: config.flareSolverrUrl } : {}),
      },
    },
  );
  const { extensionStores } = await gql<{ extensionStores: { nodes: { indexUrl: string }[] } }>(
    `{ extensionStores { nodes { indexUrl } } }`,
  );
  if (!extensionStores.nodes.some((s) => s.indexUrl === config.extensionStore))
    await gql(`mutation ($u: String!) { addExtensionStore(input: { indexUrl: $u }) { clientMutationId } }`, {
      u: config.extensionStore,
    });
  await categoryId();
}

let catId: number | null = null;
async function categoryId() {
  if (catId) return catId;
  const { categories } = await gql<{ categories: { nodes: { id: number; name: string }[] } }>(`{ categories { nodes { id name } } }`);
  catId = categories.nodes.find((c) => c.name === CATEGORY)?.id ?? null;
  if (!catId) {
    const r = await gql<{ createCategory: { category: { id: number } } }>(
      `mutation ($n: String!) { createCategory(input: { name: $n }) { category { id } } }`,
      { n: CATEGORY },
    );
    catId = r.createCategory.category.id;
  }
  return catId;
}

export const version = async () =>
  (await gql<{ aboutServer: { version: string } }>(`{ aboutServer { version } }`, {}, 5000)).aboutServer.version;

export async function search(sourceId: string, query: string) {
  const r = await gql<{ fetchSourceManga: { mangas: RemoteManga[] } }>(
    `mutation ($s: LongString!, $q: String) { fetchSourceManga(input: { source: $s, type: SEARCH, query: $q, page: 1 }) { mangas { id title url thumbnailUrl } } }`,
    { s: sourceId, q: query },
  );
  return r.fetchSourceManga.mangas;
}

/** Asks the source for the current chapter list. */
export async function fetchChapters(mangaId: number) {
  const r = await gql<{ fetchMangaAndChapters: { chapters: RemoteChapter[] } }>(
    `mutation ($id: Int!) { fetchMangaAndChapters(input: { id: $id, fetchManga: false, fetchChapters: true }) { chapters { id chapterNumber sourceOrder name scanlator isDownloaded } } }`,
    { id: mangaId },
  );
  return r.fetchMangaAndChapters.chapters;
}

/** Chapters as Suwayomi already knows them (no request to the source). */
export async function knownChapters(mangaId: number) {
  const r = await gql<{ chapters: { nodes: RemoteChapter[] } }>(
    `query ($id: Int!) { chapters(condition: { mangaId: $id }) { nodes { id chapterNumber sourceOrder name scanlator isDownloaded } } }`,
    { id: mangaId },
  );
  return r.chapters.nodes;
}

export async function chaptersById(ids: number[]) {
  if (!ids.length) return [];
  const r = await gql<{ chapters: { nodes: (RemoteChapter & { mangaId: number; manga: { title: string; source: { displayName: string } | null } })[] } }>(
    `query ($ids: [Int!]) { chapters(filter: { id: { in: $ids } }) { nodes { id mangaId chapterNumber sourceOrder name scanlator isDownloaded manga { title source { displayName } } } } }`,
    { ids },
  );
  return r.chapters.nodes;
}

export const enqueue = (ids: number[]) =>
  ids.length && gql(`mutation ($ids: [Int!]!) { enqueueChapterDownloads(input: { ids: $ids }) { clientMutationId } }`, { ids });
export const dequeue = (ids: number[]) =>
  ids.length && gql(`mutation ($ids: [Int!]!) { dequeueChapterDownloads(input: { ids: $ids }) { clientMutationId } }`, { ids });
/** Clears Suwayomi's "downloaded" mark (the file has already been moved into the library). */
export const forgetDownloads = (ids: number[]) =>
  ids.length && gql(`mutation ($ids: [Int!]!) { deleteDownloadedChapters(input: { ids: $ids }) { clientMutationId } }`, { ids });

export interface QueueItem {
  progress: number;
  state: string;
  tries: number;
  chapter: { id: number; chapterNumber: number; name: string; mangaId: number };
}
export async function queue() {
  const r = await gql<{ downloadStatus: { state: string; queue: QueueItem[] } }>(
    `{ downloadStatus { state queue { progress state tries chapter { id chapterNumber name mangaId } } } }`,
  );
  return r.downloadStatus;
}

export async function sources() {
  const r = await gql<{ sources: { nodes: SuwaSource[] } }>(`{ sources { nodes { id name lang displayName iconUrl } } }`);
  return r.sources.nodes.filter((s) => s.id !== LOCAL_SOURCE);
}

export async function extensions() {
  const r = await gql<{ fetchExtensions: { extensions: Extension[] } }>(
    `mutation { fetchExtensions(input: {}) { extensions { pkgName name lang iconUrl isInstalled contentWarning } } }`,
  );
  return r.fetchExtensions.extensions;
}

export async function installExtension(pkgName: string) {
  const r = await gql<{ updateExtension: { extension: { source: { nodes: SuwaSource[] } } } }>(
    `mutation ($p: String!) { updateExtension(input: { id: $p, patch: { install: true } }) { extension { source { nodes { id name lang displayName iconUrl } } } } }`,
    { p: pkgName },
    180_000,
  );
  return r.updateExtension.extension.source.nodes;
}

/**
 * The Local-source entry for a library folder, refreshed so it lists every file, in the Suwayomi
 * library under "Mangarr" (that's what the Mihon Suwayomi extension shows).
 */
export async function refreshLocal(folder: string, knownId: number | null) {
  let id = knownId;
  if (!id) {
    id = (await search(LOCAL_SOURCE, folder)).find((h) => h.url === folder)?.id ?? null;
    if (!id) return null;
  }
  await gql(`mutation ($id: Int!) { fetchMangaAndChapters(input: { id: $id, fetchManga: true, fetchChapters: true }) { clientMutationId } }`, { id });
  await gql(
    `mutation ($id: Int!, $c: [Int!]) {
      updateManga(input: { id: $id, patch: { inLibrary: true } }) { clientMutationId }
      updateMangaCategories(input: { id: $id, patch: { addToCategories: $c } }) { clientMutationId }
    }`,
    { id, c: [await categoryId()] },
  );
  return id;
}

export async function removeFromLibrary(id: number) {
  await gql(
    `mutation ($id: Int!, $c: [Int!]) {
      updateManga(input: { id: $id, patch: { inLibrary: false } }) { clientMutationId }
      updateMangaCategories(input: { id: $id, patch: { removeFromCategories: $c } }) { clientMutationId }
    }`,
    { id, c: [await categoryId()] },
  ).catch(
    (e) => log(`Suwayomi: couldn't remove manga ${id} from library: ${e.message}`),
  );
}

/** Page image paths (relative to Suwayomi) for a chapter. */
export async function pages(chapterId: number) {
  const r = await gql<{ fetchChapterPages: { pages: string[] } }>(
    `mutation ($id: Int!) { fetchChapterPages(input: { chapterId: $id }) { pages } }`,
    { id: chapterId },
  );
  return r.fetchChapterPages.pages;
}
