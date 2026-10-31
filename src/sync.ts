import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import * as anilist from "./anilist.ts";
import * as suwa from "./suwayomi.ts";
import { allSeries, chaptersOf, config, db, enabledSources, getSeries, log, patchSeries, type Series } from "./db.ts";
import { bestMatch, chapterFile, loose, pickWanted, safeFolder } from "./lib.ts";

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const titlesOf = (s: Series) => JSON.parse(s.titles) as string[];

export const status = { lastSync: 0, syncing: false };

/** Add a series by AniList id. Matching and the first download happen in the background. */
export async function addSeries(anilistId: number, startChapter = 0) {
  if (getSeries(anilistId)) throw new HttpError(409, "Series already added");
  const m = await anilist.manga(anilistId);
  if (!m) throw new HttpError(404, "Not on AniList");
  const title = anilist.displayTitle(m);
  let folder = safeFolder(title);
  if (db.prepare("SELECT 1 FROM series WHERE folder = ?").get(folder)) folder = `${folder} (${anilistId})`;
  db.prepare(
    `INSERT INTO series (anilist_id, title, titles, cover, banner, description, author, genres, year, anilist_status, total, folder, start_chapter)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    anilistId,
    title,
    JSON.stringify(anilist.allTitles(m)),
    m.coverImage.extraLarge ?? m.coverImage.large,
    m.bannerImage,
    m.description,
    anilist.author(m),
    JSON.stringify(m.genres),
    m.startDate.year,
    m.status,
    m.chapters,
    folder,
    startChapter,
  );
  log(`Added ${title} (AniList ${anilistId})${startChapter ? ` from chapter ${startChapter}` : ""}`);
  void syncSeries(anilistId).catch((e) => log(`${title}: ${e.message}`));
  return getSeries(anilistId)!;
}

export async function deleteSeries(anilistId: number, deleteFiles: boolean) {
  const s = getSeries(anilistId);
  if (!s) throw new HttpError(404, "No such series");
  const queued = chaptersOf(anilistId).filter((c) => !c.file && c.remote_chapter_id).map((c) => c.remote_chapter_id!);
  await Promise.resolve(suwa.dequeue(queued)).catch(() => {});
  if (s.local_id) await suwa.removeFromLibrary(s.local_id);
  db.prepare("DELETE FROM series WHERE anilist_id = ?").run(anilistId);
  if (deleteFiles) await rm(libraryPath(s.folder), { recursive: true, force: true });
  log(`Removed ${s.title}${deleteFiles ? " and its files" : ""}`);
}

/** A folder inside the library root, refusing anything that would point outside it. */
function libraryPath(folder: string) {
  const root = resolve(config.library);
  const p = resolve(root, folder);
  if (!p.startsWith(root + sep)) throw new Error(`Refusing path outside the library: ${folder}`);
  return p;
}

/** Search the enabled sources in priority order; the first exact title match wins. */
async function match(s: Series, skip: Set<string> = new Set()) {
  const titles = titlesOf(s);
  // shortcut: only the first 4 names are searched (english, romaji, 2 synonyms); more costs a request per source each.
  const queries = titles.slice(0, 4);
  for (const src of enabledSources()) {
    if (skip.has(src.id)) continue;
    for (const q of queries) {
      const hit = await suwa.search(src.id, q).then((r) => bestMatch(r, titles)).catch((e) => {
        log(`${s.title}: search on ${src.name} failed: ${e.message}`);
        return null;
      });
      if (hit) {
        patchSeries(s.anilist_id, { source_id: src.id, remote_id: hit.id, state: "ok", error: null, error_since: null });
        log(`${s.title}: matched on ${src.name} ("${hit.title}")`);
        return true;
      }
    }
  }
  patchSeries(s.anilist_id, { state: "no_match", error: "No enabled source has this title", source_id: null, remote_id: null });
  log(`${s.title}: no match on any enabled source`);
  return false;
}

/** Every match candidate across enabled sources, for picking a source by hand. */
export async function candidates(anilistId: number) {
  const s = getSeries(anilistId);
  if (!s) throw new HttpError(404, "No such series");
  const [q] = titlesOf(s);
  const out = await Promise.all(
    enabledSources().map(async (src) => {
      const results = await suwa.search(src.id, q).catch(() => []);
      return results.slice(0, 8).map((r) => ({
        sourceId: src.id,
        sourceName: src.name,
        mangaId: r.id,
        title: r.title,
        thumbnail: r.thumbnailUrl ? `/api/v1/thumb/${r.id}` : null,
        exact: !!bestMatch([r], titlesOf(s)),
        current: s.remote_id === r.id,
      }));
    }),
  );
  return out.flat();
}

/** Point a series at another source manga. Wanted chapters are re-picked from it; files on disk stay. */
export async function changeSource(anilistId: number, sourceId: string, remoteId: number) {
  const s = getSeries(anilistId);
  if (!s) throw new HttpError(404, "No such series");
  const pending = chaptersOf(anilistId).filter((c) => !c.file && c.remote_chapter_id).map((c) => c.remote_chapter_id!);
  await Promise.resolve(suwa.dequeue(pending)).catch(() => {});
  db.prepare("DELETE FROM chapters WHERE anilist_id = ? AND file IS NULL").run(anilistId);
  patchSeries(anilistId, { source_id: sourceId, remote_id: remoteId, state: "ok", error: null, error_since: null });
  log(`${s.title}: source changed by hand`);
  void syncSeries(anilistId).catch((e) => log(`${s.title}: ${e.message}`));
}

/** Check one series: match if needed, list chapters, queue the wanted ones. */
export async function syncSeries(anilistId: number) {
  let s = getSeries(anilistId);
  if (!s || !s.monitored) return;
  if (!s.remote_id) {
    if (!(await match(s))) return;
    s = getSeries(anilistId)!;
  }
  let remote;
  try {
    remote = await suwa.fetchChapters(s.remote_id!);
  } catch (e) {
    const since = s.error_since ?? now();
    patchSeries(anilistId, { state: "error", error: (e as Error).message, error_since: since, checked_at: now() });
    log(`${s.title}: chapter list failed: ${(e as Error).message}`);
    if (now() - since > DAY) {
      log(`${s.title}: source failing for over a day, trying the next one`);
      db.prepare("DELETE FROM chapters WHERE anilist_id = ? AND file IS NULL").run(anilistId);
      await match(s, new Set([s.source_id!]));
    }
    return;
  }
  const have = chaptersOf(anilistId);
  const onDisk = new Set(have.filter((c) => c.file).map((c) => c.number));
  const wanted = pickWanted(remote, onDisk, s.start_chapter);
  const upsert = db.prepare(
    `INSERT INTO chapters (anilist_id, number, name, source_id, remote_chapter_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (anilist_id, number) DO UPDATE SET name = excluded.name, source_id = excluded.source_id, remote_chapter_id = excluded.remote_chapter_id
     WHERE file IS NULL`,
  );
  for (const c of wanted) upsert.run(anilistId, c.chapterNumber, c.name, s.source_id, c.id);
  // Wanted rows from an earlier start chapter that's since been raised.
  db.prepare("DELETE FROM chapters WHERE anilist_id = ? AND file IS NULL AND number < ?").run(anilistId, s.start_chapter);
  patchSeries(anilistId, { state: "ok", error: null, error_since: null, checked_at: now() });

  const inQueue = new Set((await suwa.queue()).queue.map((q) => q.chapter.id));
  const toQueue = wanted.filter((c) => !c.isDownloaded && !inQueue.has(c.id)).map((c) => c.id);
  if (toQueue.length) {
    await suwa.enqueue(toQueue);
    log(`${s.title}: queued ${toQueue.length} chapter${toQueue.length > 1 ? "s" : ""}`);
  }
  await importDownloaded();
}

export async function syncAll() {
  if (status.syncing) return;
  status.syncing = true;
  try {
    for (const s of allSeries()) await syncSeries(s.anilist_id).catch((e) => log(`${s.title}: ${e.message}`));
    status.lastSync = Date.now();
  } finally {
    status.syncing = false;
  }
}

let importing = false;
/** Move finished downloads into the library. Runs every 30 s and after each sync. */
export async function importDownloaded() {
  if (importing) return;
  importing = true;
  try {
    const rows = db
      .prepare("SELECT anilist_id, number, remote_chapter_id FROM chapters WHERE file IS NULL AND remote_chapter_id IS NOT NULL")
      .all() as { anilist_id: number; number: number; remote_chapter_id: number }[];
    if (!rows.length) return;
    const done = (await suwa.chaptersById(rows.map((r) => r.remote_chapter_id))).filter((c) => c.isDownloaded);
    const touched = new Set<number>();
    for (const c of done) {
      const row = rows.find((r) => r.remote_chapter_id === c.id)!;
      const s = getSeries(row.anilist_id);
      if (!s) continue;
      try {
        const src = await findDownload(c.manga.source?.displayName ?? "", c.manga.title, c.name, c.scanlator);
        if (!src) throw new Error(`downloaded file for "${c.name}" not found`);
        const dir = libraryPath(s.folder);
        await mkdir(dir, { recursive: true });
        await writeSeriesInfo(s, dir);
        const file = chapterFile(s.folder, row.number);
        await move(src, join(dir, file));
        await suwa.forgetDownloads([c.id]);
        db.prepare("UPDATE chapters SET file = ?, imported_at = ? WHERE anilist_id = ? AND number = ?").run(file, now(), s.anilist_id, row.number);
        log(`${s.title}: imported ${file}`);
        touched.add(s.anilist_id);
      } catch (e) {
        log(`${s.title}: import of chapter ${row.number} failed: ${(e as Error).message}`);
      }
    }
    for (const id of touched) {
      const s = getSeries(id)!;
      const localId = await suwa.refreshLocal(s.folder, s.local_id).catch((e) => {
        log(`${s.title}: Local source refresh failed: ${e.message}`);
        return s.local_id;
      });
      if (localId !== s.local_id) patchSeries(id, { local_id: localId });
    }
  } finally {
    importing = false;
  }
}

/** Suwayomi saves to <downloads>/mangas/<source>/<title>/[<scanlator>_]<chapter>.cbz, sanitised its own way. */
async function findDownload(source: string, title: string, chapter: string, scanlator: string | null) {
  const pick = async (dir: string, name: string) => (await readdir(dir).catch(() => [])).find((d) => loose(d) === loose(name));
  const base = join(config.downloads, "mangas");
  const srcDir = await pick(base, source);
  if (!srcDir) return null;
  const titleDir = await pick(join(base, srcDir), title);
  if (!titleDir) return null;
  const dir = join(base, srcDir, titleDir);
  const want = [loose(chapter), scanlator ? loose(`${scanlator}_${chapter}`) : ""].filter(Boolean);
  const file = (await readdir(dir)).find((f) => f.endsWith(".cbz") && want.includes(loose(f.slice(0, -4))));
  return file ? join(dir, file) : null;
}

async function move(from: string, to: string) {
  await rename(from, to).catch(async (e) => {
    if (e.code !== "EXDEV") throw e;
    // Different filesystems: copy, then remove the original only once the copy is complete.
    await copyFile(from, to);
    await rm(from);
  });
}

const xml = (s: string | null | undefined) =>
  (s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** cover.jpg + ComicInfo.xml in the series folder: what Mihon's and Suwayomi's Local source read. */
async function writeSeriesInfo(s: Series, dir: string) {
  const exists = (f: string) => stat(join(dir, f)).then(() => true, () => false);
  if (s.cover && !(await exists("cover.jpg"))) {
    const res = await fetch(s.cover, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.ok) await writeFile(join(dir, "cover.jpg"), Buffer.from(await res.arrayBuffer()));
  }
  if (!(await exists("ComicInfo.xml"))) {
    const status = { RELEASING: "Ongoing", FINISHED: "Completed", HIATUS: "On hiatus", CANCELLED: "Cancelled" }[s.anilist_status ?? ""] ?? "Unknown";
    await writeFile(
      join(dir, "ComicInfo.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<ComicInfo xmlns:ty="http://www.w3.org/2001/XMLSchema">
  <Series>${xml(s.title)}</Series>
  <Summary>${xml(s.description?.replace(/<br\s*\/?>/gi, "\n"))}</Summary>
  <Writer>${xml(s.author)}</Writer>
  <Genre>${xml((JSON.parse(s.genres ?? "[]") as string[]).join(", "))}</Genre>
  <Web>https://anilist.co/manga/${s.anilist_id}</Web>
  <ty:PublishingStatusTachiyomi>${status}</ty:PublishingStatusTachiyomi>
</ComicInfo>
`,
    );
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
