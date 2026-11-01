import { copyFile, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import * as anilist from "./anilist.ts";
import * as suwa from "./suwayomi.ts";
import { allSeries, chaptersOf, config, db, enabledSources, getSeries, log, patchSeries, type Series } from "./db.ts";
import { bestMatch, chapterFile, latestNumbered, loose, numberChapters, pickWanted, safeFolder, inRanges, mergeRanges, rangesLabel, type Range } from "./lib.ts";

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const titlesOf = (s: Series) => JSON.parse(s.titles) as string[];

export const status = { lastSync: 0, syncing: false };

/**
 * One thing at a time per series: a sync still reading the old source must not write its chapters after a source
 * change (or a second sync) has moved on. Each call waits for the one before it on the same series.
 */
const busy = new Map<number, Promise<unknown>>();
function serial<T>(anilistId: number, fn: () => Promise<T>): Promise<T> {
  const run = (busy.get(anilistId) ?? Promise.resolve()).catch(() => {}).then(fn);
  busy.set(anilistId, run);
  void run.catch(() => {}).finally(() => busy.get(anilistId) === run && busy.delete(anilistId));
  return run;
}

/** Add a series by AniList id. Matching and the first download happen in the background. */
export async function addSeries(anilistId: number, ranges: Range[] = [[0, null]]) {
  if (getSeries(anilistId)) throw new HttpError(409, "Series already added");
  const m = await anilist.manga(anilistId);
  if (!m) throw new HttpError(404, "Not on AniList");
  const title = anilist.displayTitle(m);
  let folder = safeFolder(title);
  if (db.prepare("SELECT 1 FROM series WHERE folder = ?").get(folder)) folder = `${folder} (${anilistId})`;
  db.prepare(
    `INSERT INTO series (anilist_id, title, titles, cover, banner, description, author, genres, year, anilist_status, total, folder, ranges)
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
    JSON.stringify(mergeRanges(ranges)),
  );
  log(`Added ${title} (AniList ${anilistId}), ${rangesLabel(mergeRanges(ranges))}`);
  void syncSeries(anilistId).catch((e) => log(`${title}: ${e.message}`));
  return getSeries(anilistId)!;
}

export const deleteSeries = (anilistId: number, deleteFiles: boolean) => serial(anilistId, () => removeSeries(anilistId, deleteFiles));

async function removeSeries(anilistId: number, deleteFiles: boolean) {
  const s = getSeries(anilistId);
  if (!s) throw new HttpError(404, "No such series");
  const queued = chaptersOf(anilistId).filter((c) => !c.file && c.remote_chapter_id).map((c) => c.remote_chapter_id!);
  await Promise.resolve(suwa.dequeue(queued)).catch(() => {});
  if (s.remote_id) await clearLeftovers(s.remote_id);
  if (s.local_id) await suwa.removeFromLibrary(s.local_id);
  db.prepare("DELETE FROM series WHERE anilist_id = ?").run(anilistId);
  if (deleteFiles) await rm(libraryPath(s.folder), { recursive: true, force: true });
  log(`Removed ${s.title}${deleteFiles ? " and its files" : ""}`);
}

/** A folder inside the library root, refusing anything that would point outside it. */
export function libraryPath(folder: string) {
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
      // A source can list a title with no chapters (MangaDex does for licensed series, and says so with an error): keep looking.
      if (hit && !(await suwa.fetchChapters(hit.id).catch(() => [])).length) {
        log(`${s.title}: ${src.name} has it but lists no chapters, trying the next source`);
        break;
      }
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
  if (!getSeries(anilistId)) throw new HttpError(404, "No such series");
  await serial(anilistId, () => switchSource(anilistId, sourceId, remoteId));
  void syncSeries(anilistId).catch((e) => log(`${getSeries(anilistId)?.title}: ${e.message}`));
}

async function switchSource(anilistId: number, sourceId: string, remoteId: number, why?: string) {
  const s = getSeries(anilistId);
  if (!s) return;
  const pending = chaptersOf(anilistId).filter((c) => !c.file && c.remote_chapter_id).map((c) => c.remote_chapter_id!);
  await Promise.resolve(suwa.dequeue(pending)).catch(() => {});
  // What already finished downloading is kept (imported); anything else the old source left behind goes.
  await importDownloaded();
  if (s.remote_id && s.remote_id !== remoteId) await clearLeftovers(s.remote_id);
  db.prepare("DELETE FROM chapters WHERE anilist_id = ? AND file IS NULL").run(anilistId);
  patchSeries(anilistId, { source_id: sourceId, remote_id: remoteId, state: "ok", error: null, error_since: null });
  log(`${s.title}: source changed${why ? ` (${why})` : " by hand"}`);
}

/** Delete chapters Suwayomi downloaded for a manga that mangarr no longer wants, and its then-empty folders. */
async function clearLeftovers(remoteId: number) {
  const ids = await suwa.leftoverDownloads(remoteId).catch(() => []);
  if (ids.length) await Promise.resolve(suwa.forgetDownloads(ids)).catch(() => {});
  const info = await suwa.mangaInfo(remoteId).catch(() => null);
  if (info) await removeEmptyDownloadDir(info.sourceName, info.title);
}

/** Empty folders left in Suwayomi's download folder. Only while nothing is downloading, so none is about to be used. */
async function sweepDownloadDirs() {
  if ((await suwa.queue()).queue.length) return;
  const base = join(config.downloads, "mangas");
  for (const src of await readdir(base).catch(() => [])) {
    for (const title of await readdir(join(base, src)).catch(() => [])) await rmdir(join(base, src, title)).catch(() => {});
    await rmdir(join(base, src)).catch(() => {});
  }
}

/** <downloads>/mangas/<source>/<title> (and <source>) once nothing is left in them. rmdir refuses non-empty folders. */
async function removeEmptyDownloadDir(source: string, title: string) {
  const base = join(config.downloads, "mangas");
  const srcDir = (await readdir(base).catch(() => [])).find((d) => loose(d) === loose(source));
  if (!srcDir) return;
  const titleDir = (await readdir(join(base, srcDir)).catch(() => [])).find((d) => loose(d) === loose(title));
  if (titleDir) await rmdir(join(base, srcDir, titleDir)).catch(() => {});
  await rmdir(join(base, srcDir)).catch(() => {});
}

/** Check one series: match if needed, list chapters, queue the wanted ones. */
export const syncSeries = (anilistId: number): Promise<void> => serial(anilistId, () => checkSeries(anilistId));

async function checkSeries(anilistId: number): Promise<void> {
  let s = getSeries(anilistId);
  if (!s || !s.monitored) return;
  if (!s.remote_id) {
    if (!(await match(s))) return;
    s = getSeries(anilistId)!;
  }
  let remote;
  try {
    remote = await suwa.fetchChapters(s.remote_id!);
    if (!remote.length) throw new Error("No chapters found");
  } catch (e) {
    // The source still has the title but no chapters any more (taken down, licensed): move on now, not in a day.
    if (/no chapters found/i.test((e as Error).message)) {
      const name = (db.prepare("SELECT name FROM sources WHERE id = ?").get(s.source_id) as { name: string } | undefined)?.name ?? s.source_id;
      log(`${s.title}: ${name} lists no chapters any more, trying the next source`);
      db.prepare("DELETE FROM chapters WHERE anilist_id = ? AND file IS NULL").run(anilistId);
      if (await match(s, new Set([s.source_id!]))) return checkSeries(anilistId);
      return;
    }
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
  if (await behindOtherSources(s, remote)) return checkSeries(anilistId);
  const have = chaptersOf(anilistId);
  const onDisk = new Set(have.filter((c) => c.file).map((c) => c.number));
  const known = new Map(have.filter((c) => c.remote_chapter_id && c.source_id === s.source_id).map((c) => [c.remote_chapter_id!, c.number]));
  const ranges: Range[] = JSON.parse(s.ranges);
  const wanted = pickWanted(numberChapters(remote, known), onDisk, ranges);
  const upsert = db.prepare(
    `INSERT INTO chapters (anilist_id, number, name, source_id, remote_chapter_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (anilist_id, number) DO UPDATE SET name = excluded.name, source_id = excluded.source_id, remote_chapter_id = excluded.remote_chapter_id
     WHERE file IS NULL`,
  );
  for (const c of wanted) upsert.run(anilistId, c.number, c.name, s.source_id, c.id);
  // Wanted rows outside ranges that have since been narrowed.
  const unwant = db.prepare("DELETE FROM chapters WHERE anilist_id = ? AND number = ? AND file IS NULL");
  for (const c of have) if (!c.file && !inRanges(c.number, ranges)) unwant.run(anilistId, c.number);
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
    await sweepDownloadDirs().catch(() => {});
    status.lastSync = Date.now();
  } finally {
    status.syncing = false;
  }
}

const COMPARE_EVERY = 2 * DAY;

/**
 * A source can quietly stop getting new chapters without erroring. Every couple of days, a series that's still
 * coming out (or a finished one we don't have every chapter of) is compared against the other enabled sources;
 * if one has a newer chapter, the series moves there. True when it moved.
 */
async function behindOtherSources(s: Series, remote: suwa.RemoteChapter[]) {
  const ours = latestNumbered(remote);
  const incomplete = s.anilist_status !== "FINISHED" || (s.total !== null && ours < s.total);
  if (!incomplete || now() - (s.compared_at ?? s.added_at) < COMPARE_EVERY) return false;
  patchSeries(s.anilist_id, { compared_at: now() });
  const titles = titlesOf(s);
  let best: { src: { id: string; name: string }; mangaId: number; latest: number } | null = null;
  for (const src of enabledSources()) {
    if (src.id === s.source_id) continue;
    for (const q of titles.slice(0, 2)) {
      const hit = await suwa.search(src.id, q).then((r) => bestMatch(r, titles)).catch(() => null);
      if (!hit) continue;
      const latest = latestNumbered(await suwa.fetchChapters(hit.id).catch(() => []));
      if (latest > ours && latest > (best?.latest ?? -1)) best = { src, mangaId: hit.id, latest };
      break;
    }
  }
  if (!best) return false;
  const ourName = enabledSources().find((x) => x.id === s.source_id)?.name ?? "the current source";
  await switchSource(s.anilist_id, best.src.id, best.mangaId, `${ourName} stops at ${ours}, ${best.src.name} has ${best.latest}`);
  return true;
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
    const folders = new Map<number, { source: string; title: string }>();
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
        // Upsert: a source change may have cleared the wanted row while this was downloading.
        db.prepare(
          `INSERT INTO chapters (anilist_id, number, name, file, imported_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (anilist_id, number) DO UPDATE SET file = excluded.file, imported_at = excluded.imported_at`,
        ).run(s.anilist_id, row.number, c.name, file, now());
        log(`${s.title}: imported ${file}`);
        touched.add(s.anilist_id);
        folders.set(s.anilist_id, { source: c.manga.source?.displayName ?? "", title: c.manga.title });
      } catch (e) {
        log(`${s.title}: import of chapter ${row.number} failed: ${(e as Error).message}`);
      }
    }
    for (const id of touched) {
      const s = getSeries(id)!;
      // Everything wanted is in: Suwayomi's (now empty) download folder for it can go.
      const waiting = db.prepare("SELECT 1 FROM chapters WHERE anilist_id = ? AND file IS NULL LIMIT 1").get(id);
      const dir = folders.get(id);
      if (!waiting && dir) await removeEmptyDownloadDir(dir.source, dir.title);
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
  headers?: Record<string, string>;
  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
