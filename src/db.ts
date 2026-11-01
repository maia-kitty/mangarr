import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const env = process.env;
export const config = {
  dir: env.MANGARR_CONFIG ?? "./config",
  port: Number(env.MANGARR_PORT ?? 8206),
  /** Paths as both mangarr and Suwayomi see them: they must share the same mount. */
  library: env.MANGARR_LIBRARY ?? "/data/media/manga",
  downloads: env.MANGARR_DOWNLOADS ?? "/data/downloads/manga",
  suwayomiUrl: (env.SUWAYOMI_URL ?? "http://suwayomi:4567").replace(/\/+$/, ""),
  suwayomiUser: env.SUWAYOMI_USER ?? "",
  suwayomiPass: env.SUWAYOMI_PASS ?? "",
  flareSolverrUrl: env.FLARESOLVERR_URL ?? "",
  extensionStore: env.MANGARR_EXTENSION_STORE ?? "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
  /** Source languages added when an extension is installed ("all" extensions register one source per language). */
  langs: (env.MANGARR_LANGS ?? "en").split(",").map((s) => s.trim()),
  syncMinutes: Number(env.MANGARR_SYNC_MINUTES ?? 30),
  localCidrs: (env.MANGARR_LOCAL_CIDRS ?? "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,127.0.0.0/8,::1/128,fc00::/7")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

mkdirSync(config.dir, { recursive: true });

const keyFile = join(config.dir, "api-key");
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(16).toString("hex"), { mode: 0o600 });
export const apiKey = readFileSync(keyFile, "utf8").trim();

export const db = new DatabaseSync(join(config.dir, "mangarr.db"));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS series (
  anilist_id    INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  titles        TEXT NOT NULL,          -- json: every AniList title + synonym, used for matching
  cover         TEXT,
  banner        TEXT,
  description   TEXT,
  author        TEXT,
  genres        TEXT,                   -- json
  year          INTEGER,
  anilist_status TEXT,                  -- RELEASING, FINISHED, ...
  total         INTEGER,                -- AniList chapter count (null while releasing)
  folder        TEXT NOT NULL,
  start_chapter REAL NOT NULL DEFAULT 0,
  monitored     INTEGER NOT NULL DEFAULT 1,
  source_id     TEXT,
  remote_id     INTEGER,                -- Suwayomi manga id on source_id
  local_id      INTEGER,                -- Suwayomi Local-source manga id of the library folder
  state         TEXT NOT NULL DEFAULT 'matching', -- matching | ok | no_match | error
  error         TEXT,
  error_since   INTEGER,
  checked_at    INTEGER,
  added_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
-- One row per chapter number. file IS NULL = wanted (missing or downloading).
CREATE TABLE IF NOT EXISTS chapters (
  anilist_id    INTEGER NOT NULL REFERENCES series(anilist_id) ON DELETE CASCADE,
  number        REAL NOT NULL,
  name          TEXT,
  source_id     TEXT,
  remote_chapter_id INTEGER,
  file          TEXT,
  imported_at   INTEGER,
  PRIMARY KEY (anilist_id, number)
);
CREATE TABLE IF NOT EXISTS sources (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  lang     TEXT NOT NULL,
  icon     TEXT,
  priority INTEGER NOT NULL
);
PRAGMA foreign_keys = ON;
`);
// Columns added after the first release: ALTER the ones an older database lacks.
const has = (table: string, col: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
if (!has("series", "compared_at")) db.exec("ALTER TABLE series ADD COLUMN compared_at INTEGER"); // last check against the other sources
if (!has("series", "end_chapter")) db.exec("ALTER TABLE series ADD COLUMN end_chapter REAL"); // last chapter wanted; null = keep following new ones

export interface Series {
  anilist_id: number;
  title: string;
  titles: string;
  cover: string | null;
  banner: string | null;
  description: string | null;
  author: string | null;
  genres: string | null;
  year: number | null;
  anilist_status: string | null;
  total: number | null;
  folder: string;
  start_chapter: number;
  end_chapter: number | null;
  monitored: number;
  source_id: string | null;
  remote_id: number | null;
  local_id: number | null;
  state: string;
  error: string | null;
  error_since: number | null;
  checked_at: number | null;
  compared_at: number | null;
  added_at: number;
}
export interface Chapter {
  anilist_id: number;
  number: number;
  name: string | null;
  source_id: string | null;
  remote_chapter_id: number | null;
  file: string | null;
  imported_at: number | null;
}
export interface Source {
  id: string;
  name: string;
  lang: string;
  icon: string | null;
  priority: number;
}

export const getSeries = (id: number) => db.prepare("SELECT * FROM series WHERE anilist_id = ?").get(id) as Series | undefined;
export const allSeries = () => db.prepare("SELECT * FROM series ORDER BY title COLLATE NOCASE").all() as unknown as Series[];
export const chaptersOf = (id: number) =>
  db.prepare("SELECT * FROM chapters WHERE anilist_id = ? ORDER BY number").all(id) as unknown as Chapter[];
export const enabledSources = () => db.prepare("SELECT * FROM sources ORDER BY priority").all() as unknown as Source[];

/** Update some columns of a series. Keys are column names from the Series type, never user input. */
export function patchSeries(id: number, patch: Partial<Series>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE series SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE anilist_id = ?`).run(
    ...keys.map((k) => (patch as Record<string, string | number | null>)[k]),
    id,
  );
}

/** In-memory log for the System page. */
const logLines: string[] = [];
export function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 300) logLines.shift();
}
export const recentLog = () => [...logLines].reverse();
