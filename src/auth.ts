// Login for the web UI (Sonarr's "Forms" authentication): one user, a scrypt hash in /config/auth.json, sessions in
// sqlite. The API key keeps working for Jellyshelf and scripts.
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { config, db } from "./db.ts";

export interface Login {
  username: string;
  hash: string;
  /** Sonarr's "Authentication required: Disabled for local addresses". */
  localBypass: boolean;
}

// ---------- the login itself ----------
// Forgot the password: delete this file and restart, then set a new login from a local address.
const file = join(config.dir, "auth.json");
// A broken file throws here, so mangarr doesn't start open.
let login: Login | null = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
export const getLogin = () => login;

export function saveLogin(l: Login) {
  writeFileSync(`${file}.tmp`, JSON.stringify(l, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  login = l;
}

export const USERNAME_MAX = 64;
export const PASSWORD_MIN = 8;
// scrypt of a megabyte of password is wasted work an attacker could ask for.
export const PASSWORD_MAX = 256;
/** Why a new username/password can't be used, or null when it's fine. */
export function invalid(username: unknown, password: unknown): string | null {
  if (typeof username !== "string" || typeof password !== "string") return "username and password must be strings";
  const u = username.trim();
  if (!u || u.length > USERNAME_MAX) return `Username must be 1–${USERNAME_MAX} characters`;
  if (/[\p{Cc}]/u.test(u)) return "Username can't contain control characters";
  if ([...password].length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

// ---------- passwords ----------
// 32 MiB per hash; at most MAX_HASHING at once, so a flood of logins can't eat the server's memory.
const P: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 2 ** 20 };
const MAX_HASHING = 4;
let hashing = 0;
const kdf = (pw: string, salt: Buffer, len: number) =>
  new Promise<Buffer>((ok, no) => scrypt(pw.normalize("NFC"), salt, len, P, (e, k) => (e ? no(e) : ok(k))));

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await kdf(pw, salt, 32)).toString("base64")}`;
}
export class Busy extends Error {}
export async function checkPassword(pw: string, stored: string) {
  if (hashing >= MAX_HASHING) throw new Busy("Too many logins at once, try again");
  hashing++;
  try {
    const [, salt, hash] = stored.split("$");
    const want = Buffer.from(hash, "base64");
    return timingSafeEqual(await kdf(pw, Buffer.from(salt, "base64"), want.length), want);
  } finally {
    hashing--;
  }
}
/** Same-length, constant-time string compare (via hashes, so the length doesn't leak either). */
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** Username and password right? Always hashes, so a wrong username takes as long as a wrong password. */
export async function verify(username: unknown, password: unknown) {
  if (!login || typeof username !== "string" || typeof password !== "string" || password.length > PASSWORD_MAX) {
    // Still burn the time a real check takes.
    if (login) await checkPassword("x", login.hash).catch(() => {});
    return false;
  }
  const pwOk = await checkPassword(password, login.hash);
  return same(username.trim(), login.username) && pwOk;
}

// ---------- brute force ----------
// Per address (an IPv6 /64, since one machine owns a whole one): FREE wrong tries, then a lockout that doubles each
// time, from 30 s up to an hour. Forgotten after a day of quiet. A try counts before the password is checked, so
// parallel guesses can't slip past the limit; a right one clears the count.
export const FREE = 5;
const DAY = 86_400_000;
const fails = new Map<string, { n: number; until: number; last: number }>();

export function addressKey(addr: string | undefined) {
  if (!addr) return "?";
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  if (isIPv4(v4)) return v4;
  const [head, tail = ""] = addr.split("%")[0].toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = addr.includes("::") && tail ? tail.split(":") : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
/** Seconds this address must still wait, or 0. */
export function lockedFor(addr: string | undefined, now = Date.now()) {
  const f = fails.get(addressKey(addr));
  return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
}
/** Count a try (before checking it). */
export function attempt(addr: string | undefined, now = Date.now()) {
  const key = addressKey(addr);
  let f = fails.get(key);
  if (!f || now - f.last > DAY) f = { n: 0, until: 0, last: now };
  f.n++;
  f.last = now;
  if (f.n >= FREE) f.until = now + Math.min(30_000 * 2 ** (f.n - FREE), 3_600_000);
  fails.set(key, f);
  // Many addresses (a botnet, rotating IPv6): forget the ones that went quiet so the map can't grow forever.
  if (fails.size > 10_000) for (const [k, v] of fails) if (v.until < now && now - v.last > 3_600_000) fails.delete(k);
}
export const succeeded = (addr: string | undefined) => fails.delete(addressKey(addr));
export const resetLimits = () => fails.clear();

// ---------- sessions ----------
db.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL)");
export const COOKIE = "mangarr_session";
export const SESSION_DAYS = 30;
// Only the token's hash is stored: a copy of the database doesn't log anyone in.
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export function newSession(username: string) {
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token, username, expires) VALUES (?, ?, ?)").run(sha(token), username, Date.now() + SESSION_DAYS * DAY);
  return token;
}
/** The logged-in username for a session token, or null. */
export function sessionUser(token: string | undefined) {
  if (!login || !token || token.length > 128) return null;
  const r = db.prepare("SELECT username, expires FROM sessions WHERE token = ?").get(sha(token)) as { username: string; expires: number } | undefined;
  return r && r.expires > Date.now() && r.username === login.username ? r.username : null;
}
export const endSession = (token: string | undefined) => token && db.prepare("DELETE FROM sessions WHERE token = ?").run(sha(token));
export const endAllSessions = () => db.exec("DELETE FROM sessions");

export function cookieToken(header: string | undefined) {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
}
