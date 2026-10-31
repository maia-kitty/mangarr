import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, isIPv4 } from "node:net";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import * as anilist from "./anilist.ts";
import * as suwa from "./suwayomi.ts";
import { allSeries, apiKey, chaptersOf, config, db, enabledSources, getSeries, log, patchSeries, recentLog, type Series } from "./db.ts";
import { addSeries, candidates, changeSource, deleteSeries, HttpError, importDownloaded, status, syncAll, syncSeries } from "./sync.ts";

const VERSION = "0.1.0";

// ---------- auth: local addresses need no key, like the rest of the arr stack ----------
const local = new BlockList();
for (const cidr of config.localCidrs) {
  const [net, bits] = cidr.split("/");
  local.addSubnet(net, Number(bits), isIPv4(net) ? "ipv4" : "ipv6");
}
function isLocal(addr: string | undefined) {
  if (!addr) return false;
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return isIPv4(v4) ? local.check(v4, "ipv4") : local.check(addr, "ipv6");
}
function keyOk(req: IncomingMessage) {
  const given = Buffer.from(String(req.headers["x-api-key"] ?? new URL(req.url!, "http://x").searchParams.get("apikey") ?? ""));
  const want = Buffer.from(apiKey);
  return given.length === want.length && timingSafeEqual(given, want);
}

// ---------- helpers ----------
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, "Body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}
const intParam = (v: unknown, name: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer`);
  return n;
};
const chapterParam = (v: unknown) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "startChapter must be a number ≥ 0");
  return n;
};
async function proxy(res: ServerResponse, path: string) {
  const r = await suwa.suwayomiGet(path);
  if (!r.ok || !r.body) throw new HttpError(502, `Suwayomi answered ${r.status}`);
  res.writeHead(200, { "Content-Type": r.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "private, max-age=86400" });
  Readable.fromWeb(r.body as never).pipe(res);
}

/** A series as the API returns it: the row plus chapter counts and source name. */
function view(s: Series) {
  const c = db
    .prepare(
      `SELECT COUNT(file) AS onDisk, SUM(file IS NULL) AS missing, MAX(CASE WHEN file IS NOT NULL THEN number END) AS latest
       FROM chapters WHERE anilist_id = ?`,
    )
    .get(s.anilist_id) as { onDisk: number; missing: number | null; latest: number | null };
  const src = s.source_id ? (db.prepare("SELECT name FROM sources WHERE id = ?").get(s.source_id) as { name: string } | undefined) : undefined;
  return {
    anilistId: s.anilist_id,
    title: s.title,
    titles: JSON.parse(s.titles),
    cover: s.cover,
    banner: s.banner,
    description: s.description,
    author: s.author,
    genres: JSON.parse(s.genres ?? "[]"),
    year: s.year,
    anilistStatus: s.anilist_status,
    totalChapters: s.total,
    folder: s.folder,
    path: `${config.library}/${s.folder}`,
    startChapter: s.start_chapter,
    monitored: !!s.monitored,
    sourceId: s.source_id,
    sourceName: src?.name ?? null,
    state: s.state,
    error: s.error,
    lastChecked: s.checked_at ? s.checked_at * 1000 : null,
    added: s.added_at * 1000,
    chaptersOnDisk: c.onDisk,
    chaptersMissing: c.missing ?? 0,
    latestChapter: c.latest,
  };
}

const pageCache = new Map<string, string[]>();
async function chapterPages(s: Series, number: number) {
  const key = `${s.anilist_id}:${number}`;
  if (pageCache.has(key)) return pageCache.get(key)!;
  if (!s.local_id) throw new HttpError(404, "Nothing on disk yet");
  const ch = (await suwa.knownChapters(s.local_id)).find((c) => c.chapterNumber === number);
  if (!ch) throw new HttpError(404, "Chapter not on disk");
  const pages = await suwa.pages(ch.id);
  if (pageCache.size > 500) pageCache.clear();
  pageCache.set(key, pages);
  return pages;
}

let extCache: { at: number; list: suwa.Extension[] } | null = null;

// ---------- routes ----------
type Handler = (req: IncomingMessage, res: ServerResponse, p: string[], url: URL) => Promise<unknown>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp(`^/api/v1${path.replace(/:\w+/g, "([^/]+)")}$`), h]);

route("GET", "/status", async () => ({
  version: VERSION,
  apiKey,
  library: config.library,
  downloads: config.downloads,
  suwayomiUrl: config.suwayomiUrl,
  suwayomi: await suwa.version().then((v) => ({ ok: true, version: v }), (e) => ({ ok: false, error: e.message })),
  lastSync: status.lastSync || null,
  syncing: status.syncing,
  syncMinutes: config.syncMinutes,
}));
route("GET", "/log", async () => recentLog());

route("GET", "/lookup", async (_q, _r, _p, url) => {
  const term = url.searchParams.get("term")?.trim();
  if (!term) return [];
  const added = new Set(allSeries().map((s) => s.anilist_id));
  return (await anilist.searchManga(term)).map((m) => ({
    anilistId: m.id,
    title: anilist.displayTitle(m),
    romaji: m.title.romaji,
    cover: m.coverImage.large,
    year: m.startDate.year,
    format: m.format,
    status: m.status,
    chapters: m.chapters,
    genres: m.genres,
    description: m.description,
    added: added.has(m.id),
  }));
});

route("GET", "/series", async () => allSeries().map(view));
route("POST", "/series", async (req, res) => {
  const b = await readBody(req);
  const s = await addSeries(intParam(b.anilistId, "anilistId"), chapterParam(b.startChapter));
  res.statusCode = 201;
  return view(s);
});
const mustSeries = (id: string) => {
  const s = getSeries(intParam(id, "anilistId"));
  if (!s) throw new HttpError(404, "No such series");
  return s;
};
route("GET", "/series/:id", async (_q, _r, [id]) => view(mustSeries(id)));
route("PATCH", "/series/:id", async (req, _r, [id]) => {
  const s = mustSeries(id);
  const b = await readBody(req);
  if (b.sourceId !== undefined || b.mangaId !== undefined) {
    if (!/^\d+$/.test(String(b.sourceId))) throw new HttpError(400, "sourceId must be a source id");
    await changeSource(s.anilist_id, String(b.sourceId), intParam(b.mangaId, "mangaId"));
  }
  if (b.monitored !== undefined) patchSeries(s.anilist_id, { monitored: b.monitored ? 1 : 0 });
  if (b.startChapter !== undefined) patchSeries(s.anilist_id, { start_chapter: chapterParam(b.startChapter) });
  if (b.monitored !== undefined || b.startChapter !== undefined)
    void syncSeries(s.anilist_id).catch((e) => log(`${s.title}: ${e.message}`));
  return view(getSeries(s.anilist_id)!);
});
route("DELETE", "/series/:id", async (_q, _r, [id], url) => {
  await deleteSeries(mustSeries(id).anilist_id, url.searchParams.get("deleteFiles") === "true");
  return { ok: true };
});
route("POST", "/series/:id/refresh", async (_q, _r, [id]) => {
  const s = mustSeries(id);
  void syncSeries(s.anilist_id).catch((e) => log(`${s.title}: ${e.message}`));
  return { ok: true };
});
route("GET", "/series/:id/candidates", async (_q, _r, [id]) => candidates(mustSeries(id).anilist_id));
route("GET", "/series/:id/chapters", async (_q, _r, [id]) =>
  chaptersOf(mustSeries(id).anilist_id).map((c) => ({
    number: c.number,
    name: c.name,
    file: c.file,
    onDisk: !!c.file,
    imported: c.imported_at ? c.imported_at * 1000 : null,
    remoteChapterId: c.remote_chapter_id,
  })),
);
route("GET", "/series/:id/chapters/:n/pages", async (_q, _r, [id, n]) => ({ count: (await chapterPages(mustSeries(id), Number(n))).length }));
route("GET", "/series/:id/chapters/:n/pages/:p", async (_q, res, [id, n, p]) => {
  const pages = await chapterPages(mustSeries(id), Number(n));
  const i = Number(p);
  if (!Number.isInteger(i) || i < 0 || i >= pages.length) throw new HttpError(404, "No such page");
  await proxy(res, pages[i]);
});
route("GET", "/icon", async (_q, res, _p, url) => {
  const u = url.searchParams.get("u") ?? "";
  if (!/^\/api\/v1\/extension\/icon\/[\w.]+$/.test(u)) throw new HttpError(400, "Not an extension icon");
  await proxy(res, u);
});
route("GET", "/thumb/:mangaId", async (_q, res, [m]) => proxy(res, `/api/v1/manga/${intParam(m, "mangaId")}/thumbnail`));

route("GET", "/queue", async () => {
  const q = await suwa.queue();
  const byRemote = new Map(allSeries().map((s) => [s.remote_id, s]));
  return {
    state: q.state,
    items: q.queue.map((i) => {
      const s = byRemote.get(i.chapter.mangaId);
      return {
        anilistId: s?.anilist_id ?? null,
        title: s?.title ?? "(not from mangarr)",
        chapter: i.chapter.chapterNumber,
        name: i.chapter.name,
        progress: i.progress,
        state: i.state,
        tries: i.tries,
      };
    }),
  };
});
route("GET", "/history", async () =>
  db
    .prepare(
      `SELECT c.anilist_id AS anilistId, s.title, c.number AS chapter, c.file, c.imported_at * 1000 AS imported
       FROM chapters c JOIN series s USING (anilist_id) WHERE c.file IS NOT NULL ORDER BY c.imported_at DESC LIMIT 100`,
    )
    .all(),
);
route("GET", "/wanted", async () =>
  db
    .prepare(
      `SELECT c.anilist_id AS anilistId, s.title, c.number AS chapter, c.name, s.monitored
       FROM chapters c JOIN series s USING (anilist_id) WHERE c.file IS NULL ORDER BY s.title COLLATE NOCASE, c.number LIMIT 1000`,
    )
    .all(),
);

route("GET", "/sources", async () => enabledSources());
route("PUT", "/sources", async (req) => {
  const { ids } = await readBody(req);
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) throw new HttpError(400, "ids must be a list of source ids");
  const known = new Map((await suwa.sources()).map((s) => [s.id, s]));
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM sources");
    const ins = db.prepare("INSERT INTO sources (id, name, lang, icon, priority) VALUES (?, ?, ?, ?, ?)");
    (ids as string[]).forEach((id, i) => {
      const s = known.get(id);
      if (!s) throw new HttpError(400, `Unknown source ${id}`);
      ins.run(id, s.displayName, s.lang, s.iconUrl, i);
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return enabledSources();
});
/** Every source Suwayomi has installed, enabled or not. */
route("GET", "/sources/installed", async () => suwa.sources());
route("GET", "/extensions", async () => {
  if (!extCache || Date.now() - extCache.at > 3_600_000) extCache = { at: Date.now(), list: await suwa.extensions() };
  return extCache.list;
});
route("POST", "/extensions/install", async (req) => {
  const { pkgName } = await readBody(req);
  if (typeof pkgName !== "string" || !/^[\w.]+$/.test(pkgName)) throw new HttpError(400, "pkgName required");
  const sources = await suwa.installExtension(pkgName);
  if (!sources) throw new HttpError(404, `No extension ${pkgName} in the extension store`);
  const added = sources.filter((s) => config.langs.includes(s.lang) || config.langs.includes("all"));
  extCache = null;
  const next = (db.prepare("SELECT COALESCE(MAX(priority) + 1, 0) AS p FROM sources").get() as { p: number }).p;
  const ins = db.prepare("INSERT OR IGNORE INTO sources (id, name, lang, icon, priority) VALUES (?, ?, ?, ?, ?)");
  added.forEach((s, i) => ins.run(s.id, s.displayName, s.lang, s.iconUrl, next + i));
  log(`Installed ${pkgName}: ${added.map((s) => s.displayName).join(", ") || "no source in the configured languages"}`);
  return enabledSources();
});
route("POST", "/command/refresh", async () => {
  void syncAll().catch((e) => log(`Sync failed: ${e.message}`));
  return { ok: true };
});

// ---------- static UI ----------
const PUBLIC = new URL("../public/", import.meta.url);
const TYPES: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" };
async function serveStatic(res: ServerResponse, path: string) {
  const name = path === "/" ? "index.html" : path.slice(1);
  if (!/^[\w-]+\.(html|js|css|svg)$/.test(name)) return false;
  const body = await readFile(new URL(name, PUBLIC)).catch(() => null);
  if (!body) return false;
  res.writeHead(200, { "Content-Type": `${TYPES[name.split(".").pop()!]}; charset=utf-8`, "Cache-Control": "no-cache" });
  res.end(body);
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (!url.pathname.startsWith("/api/")) {
      if (req.method === "GET" && (await serveStatic(res, url.pathname))) return;
      return json(res, 404, { error: "Not found" });
    }
    if (!isLocal(req.socket.remoteAddress) && !keyOk(req)) return json(res, 401, { error: "API key required (X-Api-Key)" });
    for (const [method, re, h] of routes) {
      const m = req.method === method && re.exec(url.pathname);
      if (!m) continue;
      const out = await h(req, res, m.slice(1).map(decodeURIComponent), url);
      if (!res.headersSent) json(res, res.statusCode === 201 ? 201 : 200, out ?? { ok: true });
      return;
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    const code = e instanceof HttpError ? e.status : 500;
    if (code === 500) log(`${req.method} ${url.pathname}: ${(e as Error).message}`);
    if (!res.headersSent) json(res, code, { error: (e as Error).message });
    else res.destroy();
  }
});

// ---------- start ----------
server.listen(config.port, () => log(`mangarr ${VERSION} on :${config.port}, library ${config.library}`));

async function connect() {
  for (let delay = 5; ; delay = Math.min(delay * 2, 300)) {
    try {
      await suwa.setup();
      log(`Suwayomi ${await suwa.version()} ready at ${config.suwayomiUrl}`);
      return;
    } catch (e) {
      log(`Suwayomi not ready (${(e as Error).message}), retrying in ${delay}s`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
}
if (!process.env.MANGARR_NO_JOBS) {
  void connect().then(() => {
    void syncAll();
    setInterval(() => void syncAll().catch((e) => log(`Sync failed: ${e.message}`)), config.syncMinutes * 60_000);
    setInterval(() => void importDownloaded().catch((e) => log(`Import failed: ${e.message}`)), 30_000);
  });
}
