import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, isIPv4 } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import * as anilist from "./anilist.ts";
import * as suwa from "./suwayomi.ts";
import * as auth from "./auth.ts";
import { allSeries, apiKey, chaptersOf, config, db, enabledSources, getSeries, log, patchSeries, recentLog, type Series } from "./db.ts";
import { mergeRanges, numberChapters, type Range } from "./lib.ts";
import { addSeries, candidates, changeSource, deleteSeries, HttpError, importDownloaded, libraryPath, status, syncAll, syncSeries } from "./sync.ts";

const VERSION = "0.1.0";

// ---------- auth: the API key, a login session, or (until a login is set, or if it allows it) a local address ----------
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
function allowed(req: IncomingMessage) {
  if (keyOk(req)) return true;
  const login = auth.getLogin();
  if (!login || login.localBypass) if (isLocal(req.socket.remoteAddress)) return true;
  return !!auth.sessionUser(auth.cookieToken(req.headers.cookie));
}
/** A request from another site's page (cross-site request forgery): browsers always send Origin on those. */
function foreign(req: IncomingMessage) {
  const o = req.headers.origin;
  if (!o || req.method === "GET" || req.method === "HEAD") return false;
  try {
    return new URL(o).host !== req.headers.host;
  } catch {
    return true;
  }
}
function setSession(req: IncomingMessage, res: ServerResponse, token: string | null) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${auth.COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? auth.SESSION_DAYS * 86400 : 0}${secure}`,
  );
}
/** Count a password try against this address; throws 429 while it's locked out. Returns a function to report the result. */
async function guarded(req: IncomingMessage, check: () => Promise<boolean>) {
  const addr = req.socket.remoteAddress;
  const wait = auth.lockedFor(addr);
  if (wait) throw new HttpError(429, `Too many wrong passwords, try again in ${wait} s`, { "Retry-After": String(wait) });
  auth.attempt(addr);
  let ok: boolean;
  try {
    ok = await check();
  } catch (e) {
    if (e instanceof auth.Busy) throw new HttpError(429, e.message, { "Retry-After": "1" });
    throw e;
  }
  if (ok) auth.succeeded(addr);
  else log(`Wrong password from ${addr}${auth.lockedFor(addr) ? `, locked out for ${auth.lockedFor(addr)} s` : ""}`);
  return ok;
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
/** `{from, to}`: chapters `from` to `to`; `to` null (or absent) keeps following new ones. */
const rangeParam = (v: unknown): Range => {
  const r = (v ?? {}) as { from?: unknown; to?: unknown };
  const from = Number(r.from ?? 0);
  const to = r.to === null || r.to === undefined ? null : Number(r.to);
  if (typeof v !== "object" || !Number.isFinite(from) || from < 0 || (to !== null && !(Number.isFinite(to) && to >= from)))
    throw new HttpError(400, "A range is {from, to}: from ≥ 0, to ≥ from or null");
  return [from, to];
};
const rangesParam = (v: unknown) => {
  if (!Array.isArray(v) || !v.length || v.length > 100) throw new HttpError(400, "ranges must be a list of 1–100 {from, to}");
  return mergeRanges(v.map(rangeParam));
};
const rangesOf = (s: Series): Range[] => JSON.parse(s.ranges);
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
    ranges: rangesOf(s).map(([from, to]) => ({ from, to })),
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

// ---------- login routes (reachable without being logged in) ----------
async function authRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<unknown> {
  const login = auth.getLogin();
  const token = auth.cookieToken(req.headers.cookie);
  if (path === "/api/v1/auth" && req.method === "GET") {
    const ok = allowed(req);
    return {
      configured: !!login,
      allowed: ok,
      // A local address that needs no login still sees the username (for Settings), but has no session to log out of.
      username: ok ? (login?.username ?? null) : null,
      loggedIn: !!auth.sessionUser(token),
      localBypass: ok ? (login?.localBypass ?? null) : null,
      local: isLocal(req.socket.remoteAddress),
    };
  }
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const b = await readBody(req);
  if (path === "/api/v1/auth/login") {
    if (!login) throw new HttpError(409, "No login set up yet");
    if (!(await guarded(req, () => auth.verify(b.username, b.password)))) throw new HttpError(401, "Wrong username or password");
    setSession(req, res, auth.newSession(login.username));
    log(`${login.username} logged in from ${req.socket.remoteAddress}`);
    return { ok: true };
  }
  if (path === "/api/v1/auth/logout") {
    auth.endSession(token);
    setSession(req, res, null);
    return { ok: true };
  }
  if (path === "/api/v1/auth/setup") {
    if (login) throw new HttpError(409, "A login is already set; change it in Settings → General");
    // Whoever reaches it first would own it: only from a local address, or with the API key.
    if (!isLocal(req.socket.remoteAddress) && !keyOk(req)) throw new HttpError(403, "Set up the login from a local address (or with the API key)");
    const why = auth.invalid(b.username, b.password);
    if (why) throw new HttpError(400, why);
    const username = (b.username as string).trim();
    auth.saveLogin({ username, hash: await auth.hashPassword(b.password as string), localBypass: b.localBypass === true });
    setSession(req, res, auth.newSession(username));
    log(`Login set up for ${username}`);
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

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
// Change the login: always needs the current password, even from a local address that needs no login.
route("PUT", "/auth", async (req, res) => {
  const login = auth.getLogin();
  if (!login) throw new HttpError(409, "No login set up yet");
  const b = await readBody(req);
  if (typeof b.currentPassword !== "string" || !(await guarded(req, () => auth.verify(login.username, b.currentPassword))))
    throw new HttpError(401, "Current password is wrong");
  const username = b.username === undefined ? login.username : b.username;
  const password = b.newPassword === undefined || b.newPassword === "" ? null : b.newPassword;
  if (b.localBypass !== undefined && typeof b.localBypass !== "boolean") throw new HttpError(400, "localBypass must be true or false");
  const why = auth.invalid(username, password ?? "x".repeat(auth.PASSWORD_MIN));
  if (why) throw new HttpError(400, why);
  const next = {
    username: (username as string).trim(),
    hash: password === null ? login.hash : await auth.hashPassword(password as string),
    localBypass: (b.localBypass as boolean | undefined) ?? login.localBypass,
  };
  auth.saveLogin(next);
  // New username or password: every other browser has to log in again; this one stays in.
  if (next.username !== login.username || password !== null) {
    auth.endAllSessions();
    setSession(req, res, auth.newSession(next.username));
    log(`Login changed for ${next.username}, other sessions logged out`);
  }
  return { ok: true };
});

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
  const s = await addSeries(intParam(b.anilistId, "anilistId"), b.ranges === undefined ? [[0, null]] : rangesParam(b.ranges));
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
  // ranges: replace them all; addRange: one more, joined with the ones it overlaps.
  const ranges = b.ranges !== undefined ? rangesParam(b.ranges) : b.addRange !== undefined ? mergeRanges([...rangesOf(s), rangeParam(b.addRange)]) : null;
  if (ranges) patchSeries(s.anilist_id, { ranges: JSON.stringify(ranges) });
  if (b.monitored !== undefined || ranges)
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
/**
 * The series' chapters: on disk and wanted. With ?all=true also the ones the source has that weren't asked for
 * (outside the wanted ranges), as `wanted: false`, from the chapter list Suwayomi already has (no request to the source).
 */
route("GET", "/series/:id/chapters", async (_q, _r, [id], url) => {
  const s = mustSeries(id);
  const rows = chaptersOf(s.anilist_id);
  const out = rows.map((c) => ({
    number: c.number,
    name: c.name,
    file: c.file,
    onDisk: !!c.file,
    wanted: true,
    imported: c.imported_at ? c.imported_at * 1000 : null,
    remoteChapterId: c.remote_chapter_id,
  }));
  if (url.searchParams.get("all") !== "true" || !s.remote_id) return out;
  const have = new Set(rows.map((c) => c.number));
  const known = new Map(rows.filter((c) => c.remote_chapter_id && c.source_id === s.source_id).map((c) => [c.remote_chapter_id!, c.number]));
  const remote = numberChapters(await suwa.knownChapters(s.remote_id).catch(() => []), known);
  const extra = new Map<number, (typeof out)[number]>();
  for (const c of remote) {
    if (have.has(c.number) || extra.has(c.number)) continue;
    extra.set(c.number, { number: c.number, name: c.name, file: null, onDisk: false, wanted: false, imported: null, remoteChapterId: c.id });
  }
  return [...out, ...extra.values()].sort((a, b) => a.number - b.number);
});
/** A chapter's CBZ as it is on disk: what the Android app downloads to read offline. */
route("GET", "/series/:id/chapters/:n/file", async (_q, res, [id, n]) => {
  const s = mustSeries(id);
  const c = chaptersOf(s.anilist_id).find((c) => c.number === Number(n) && c.file);
  const path = c && join(libraryPath(s.folder), c.file!);
  const st = path && (await stat(path).catch(() => null));
  if (!path || !st) throw new HttpError(404, "Chapter isn't on disk");
  res.writeHead(200, { "Content-Type": "application/vnd.comicbook+zip", "Content-Length": st.size, "Cache-Control": "private, no-store" });
  createReadStream(path).pipe(res);
});
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
route("GET", "/sources/installed", async () =>
  // "all" extensions (MangaDex) register one source per language: only offer the configured ones.
  (await suwa.sources()).filter((s) => config.langs.includes("all") || config.langs.includes(s.lang) || s.lang === "all"),
);
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
  res.writeHead(200, { "Content-Type": `${TYPES[name.split(".").pop()!]}; charset=utf-8`, "Cache-Control": "no-cache", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
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
    if (foreign(req)) return json(res, 403, { error: "Cross-site request refused" });
    if (url.pathname.startsWith("/api/v1/auth/") || (url.pathname === "/api/v1/auth" && req.method === "GET"))
      return json(res, 200, await authRoute(req, res, url.pathname));
    if (!allowed(req)) return json(res, 401, { error: auth.getLogin() ? "Log in, or send the API key (X-Api-Key)" : "API key required (X-Api-Key)", login: !!auth.getLogin() });
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
    if (e instanceof HttpError && e.headers) for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
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
