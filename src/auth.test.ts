// The login, attacked: a real server on a throwaway config dir, plus the brute-force counter on its own.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mangarr-auth-"));
process.env.MANGARR_CONFIG = dir;
const auth = await import("./auth.ts");

let server: ChildProcess | null = null;
let base = "";
/** Start mangarr; `local` says whether 127.0.0.1 counts as a local address. */
async function start(local: boolean) {
  server?.kill();
  const port = 30000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [new URL("./server.ts", import.meta.url).pathname], {
    env: { ...process.env, MANGARR_CONFIG: dir, MANGARR_PORT: String(port), MANGARR_NO_JOBS: "1", SUWAYOMI_URL: "http://127.0.0.1:1", MANGARR_LOCAL_CIDRS: local ? "127.0.0.0/8" : "192.0.2.0/24" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/api/v1/auth`).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server didn't start");
}
after(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

type Opts = { method?: string; body?: unknown; cookie?: string; key?: boolean; headers?: Record<string, string>; raw?: string };
async function call(path: string, o: Opts = {}) {
  const headers: Record<string, string> = { ...o.headers };
  if (o.body !== undefined || o.raw !== undefined) headers["content-type"] = "application/json";
  if (o.cookie) headers.cookie = o.cookie;
  if (o.key) headers["x-api-key"] = readFileSync(join(dir, "api-key"), "utf8").trim();
  const r = await fetch(`${base}/api/v1${path}`, { method: o.method ?? "GET", headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) });
  const cookie = r.headers.get("set-cookie");
  return { status: r.status, body: await r.json().catch(() => null), cookie: cookie?.split(";")[0] ?? null, setCookie: cookie, headers: r.headers };
}
const login = (username: string, password: string) => call("/auth/login", { method: "POST", body: { username, password } });

// ---------- the counter on its own ----------
test("lockout: five free tries, then 30 s doubling to an hour, forgotten after a quiet day", () => {
  const ip = "203.0.113.9";
  const t = 1_000_000;
  for (let i = 0; i < 4; i++) auth.attempt(ip, t);
  assert.equal(auth.lockedFor(ip, t), 0);
  auth.attempt(ip, t); // 5th
  assert.equal(auth.lockedFor(ip, t), 30);
  assert.equal(auth.lockedFor(ip, t + 30_001), 0);
  auth.attempt(ip, t + 30_001); // 6th
  assert.equal(auth.lockedFor(ip, t + 30_001), 60);
  for (let i = 0; i < 20; i++) auth.attempt(ip, t + 40_000);
  assert.equal(auth.lockedFor(ip, t + 40_000), 3600);
  auth.attempt(ip, t + 40_000 + 86_400_001); // a day later: starts over
  assert.equal(auth.lockedFor(ip, t + 40_000 + 86_400_001), 0);
  auth.succeeded(ip);
  assert.equal(auth.lockedFor(ip), 0);
});

test("addresses: IPv4-mapped is IPv4, a whole IPv6 /64 is one address", () => {
  assert.equal(auth.addressKey("::ffff:192.168.1.5"), "192.168.1.5");
  assert.equal(auth.addressKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(auth.addressKey("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(auth.addressKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(auth.addressKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(auth.addressKey("::1"), "0:0:0:0::/64");
  assert.equal(auth.addressKey(undefined), "?");
});

test("new logins: lengths, types, control characters", () => {
  assert.equal(auth.invalid("me", "12345678"), null);
  assert.match(auth.invalid("me", "1234567")!, /at least 8/);
  assert.match(auth.invalid("me", "x".repeat(257))!, /at most/);
  assert.match(auth.invalid("  ", "12345678")!, /Username/);
  assert.match(auth.invalid("a".repeat(65), "12345678")!, /Username/);
  assert.match(auth.invalid("a\nb", "12345678")!, /control/);
  assert.match(auth.invalid(["me"], "12345678")!, /strings/);
  assert.match(auth.invalid("me", 12345678)!, /strings/);
  assert.equal(auth.invalid("me", "🔒🔒🔒🔒🔒🔒🔒🔒"), null); // 8 characters, not 16 code units
});

// ---------- the server, from an address that isn't local ----------
let session = "";
before(() => start(false));

test("before setup: nothing without the API key, and setup needs it too", async () => {
  assert.equal((await call("/series")).status, 401);
  assert.deepEqual((await call("/auth")).body, { configured: false, allowed: false, username: null, loggedIn: false, localBypass: null, local: false });
  assert.equal((await call("/auth/setup", { method: "POST", body: { username: "me", password: "correct horse" } })).status, 403);
  assert.equal((await login("me", "correct horse")).status, 409);
  assert.equal((await call("/series", { key: true })).status, 200);
});

test("setup: bad input refused, then works once", async () => {
  const setup = (body: unknown, raw?: string) => call("/auth/setup", { method: "POST", key: true, body, raw });
  assert.equal((await setup({ username: "me", password: "short" })).status, 400);
  assert.equal((await setup({ username: "", password: "correct horse" })).status, 400);
  assert.equal((await setup({ username: { $ne: null }, password: "correct horse" })).status, 400);
  assert.equal((await setup(undefined, "not json")).status, 400);
  assert.equal((await setup(undefined, "[1,2]")).status, 400);
  assert.equal((await setup(undefined, `{"username":"me","password":"${"x".repeat(1_100_000)}"}`)).status, 413);
  const ok = await setup({ username: "  me  ", password: "correct horse" });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie!, /HttpOnly/);
  assert.match(ok.setCookie!, /SameSite=Strict/);
  assert.equal((await setup({ username: "evil", password: "taken over!" })).status, 409);
  const stored = readFileSync(join(dir, "auth.json"), "utf8");
  assert.ok(!stored.includes("correct horse"), "password stored in plain text");
  assert.match(stored, /"username": "me"/);
});

test("login: right password gets a session, wrong ones and lookalikes don't", async () => {
  const bad = [["me", "wrong pass"], ["ME", "correct horse"], ["me", "correct horse "], ["me", ""], ["", ""], ["me", ["correct horse"]], [undefined, undefined]];
  for (const [username, password] of bad) {
    assert.equal((await call("/auth/login", { method: "POST", body: { username, password } })).status, 401, `${username}/${password}`);
    assert.equal((await login("me", "correct horse")).status, 200); // (and resets the lockout count)
  }
  const ok = await login(" me ", "correct horse");
  assert.equal(ok.status, 200);
  session = ok.cookie!;
  assert.equal((await call("/series", { cookie: session })).status, 200);
  assert.deepEqual((await call("/auth", { cookie: session })).body, { configured: true, allowed: true, username: "me", loggedIn: true, localBypass: false, local: false });
  // The 401 tells the UI to show the login screen.
  assert.equal((await call("/series")).body.login, true);
});

test("sessions: forged, oversized, other cookies, and a copied database don't log in", async () => {
  for (const cookie of ["mangarr_session=", "mangarr_session=abc", `mangarr_session=${"A".repeat(5000)}`, "other=1", session.replace(/.$/, (c) => (c === "A" ? "B" : "A"))])
    assert.equal((await call("/series", { cookie })).status, 401, cookie.slice(0, 40));
  assert.equal((await call("/series", { cookie: `x=1; ${session}; y=2` })).status, 200);
  const { DatabaseSync } = await import("node:sqlite");
  const rows = new DatabaseSync(join(dir, "mangarr.db")).prepare("SELECT token FROM sessions").all() as { token: string }[];
  assert.ok(rows.length && rows.every((r) => !session.includes(r.token)), "raw token in the database");
  assert.equal((await call("/series", { cookie: `mangarr_session=${rows[0].token}` })).status, 401);
});

test("cross-site requests are refused even with a session", async () => {
  const evil = { origin: "http://evil.example" };
  assert.equal((await call("/command/refresh", { method: "POST", cookie: session, headers: evil })).status, 403);
  assert.equal((await call("/auth/logout", { method: "POST", cookie: session, headers: evil })).status, 403);
  assert.equal((await call("/auth/login", { method: "POST", body: { username: "me", password: "correct horse" }, headers: { origin: "null" } })).status, 403);
  assert.equal((await call("/series", { cookie: session })).status, 200, "the session survived");
});

test("change login: needs the current password, logs out other browsers", async () => {
  const other = (await login("me", "correct horse")).cookie!;
  assert.equal((await call("/auth", { method: "PUT", body: { currentPassword: "nope", newPassword: "new password!" } })).status, 401, "without a session");
  assert.equal((await call("/auth", { method: "PUT", cookie: session, body: { currentPassword: "nope", newPassword: "new password!" } })).status, 401);
  assert.equal((await call("/auth", { method: "PUT", cookie: session, body: { currentPassword: "correct horse", newPassword: "short" } })).status, 400);
  assert.equal((await call("/auth", { method: "PUT", cookie: session, body: { currentPassword: "correct horse", localBypass: "yes" } })).status, 400);
  const ch = await call("/auth", { method: "PUT", cookie: session, body: { currentPassword: "correct horse", newPassword: "new password!" } });
  assert.equal(ch.status, 200);
  assert.equal((await call("/series", { cookie: other })).status, 401, "other browser still logged in");
  assert.equal((await call("/series", { cookie: session })).status, 401, "old cookie of this browser still works");
  session = ch.cookie!;
  assert.equal((await call("/series", { cookie: session })).status, 200, "this browser got a new session");
  assert.equal((await login("me", "correct horse")).status, 401);
  assert.equal((await login("me", "new password!")).status, 200);
  // Only the bypass setting: nobody gets logged out.
  assert.equal((await call("/auth", { method: "PUT", cookie: session, body: { currentPassword: "new password!", localBypass: false } })).status, 200);
  assert.equal((await call("/series", { cookie: session })).status, 200);
});

test("logout ends the session", async () => {
  const s = (await login("me", "new password!")).cookie!;
  const out = await call("/auth/logout", { method: "POST", cookie: s });
  assert.equal(out.status, 200);
  assert.match(out.setCookie!, /Max-Age=0/);
  assert.equal((await call("/series", { cookie: s })).status, 401);
  assert.equal((await call("/auth/logout", { method: "POST" })).status, 200, "logging out twice is fine");
});

test("brute force: a burst of guesses gets five tries, then even the right password waits", async () => {
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => login("me", `guess ${i}`)));
  const wrong = burst.filter((r) => r.status === 401).length;
  const limited = burst.filter((r) => r.status === 429);
  assert.ok(wrong <= auth.FREE, `${wrong} guesses checked`);
  assert.equal(wrong + limited.length, 30);
  assert.ok(Number(limited[0].headers.get("retry-after")) > 0);
  const right = await login("me", "new password!");
  assert.equal(right.status, 429, "the right password got through a lockout");
  assert.equal(right.cookie, null);
  // Changing the password is guarded by the same lock, and the API key still works.
  assert.equal((await call("/auth", { method: "PUT", cookie: session, body: { currentPassword: "new password!" } })).status, 429);
  assert.equal((await call("/series", { key: true })).status, 200);
  assert.equal((await call("/series", { cookie: session })).status, 200, "an existing session still works");
});

// ---------- from a local address ----------
test("local addresses: login required unless 'Disabled for local addresses'", async () => {
  await start(true);
  assert.equal((await call("/series")).status, 401, "login is Enabled, so local needs it too");
  const s = (await login("me", "new password!")).cookie!;
  assert.equal((await call("/auth", { method: "PUT", cookie: s, body: { currentPassword: "new password!", localBypass: true } })).status, 200);
  assert.equal((await call("/series")).status, 200);
  assert.equal((await call("/auth")).body.username, "me");
  assert.equal((await call("/auth")).body.loggedIn, false);
});

test("forgot the password: delete auth.json, restart, set it up again from a local address", async () => {
  rmSync(join(dir, "auth.json"));
  await start(true);
  assert.equal((await call("/auth")).body.configured, false);
  assert.equal((await call("/auth/setup", { method: "POST", body: { username: "me2", password: "another one" } })).status, 200);
  assert.equal((await login("me", "new password!")).status, 401, "old login survived");
});

test("a broken auth.json stops mangarr instead of leaving it open", async () => {
  server?.kill();
  writeFileSync(join(dir, "auth.json"), "{broken");
  const port = 30000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [new URL("./server.ts", import.meta.url).pathname], {
    env: { ...process.env, MANGARR_CONFIG: dir, MANGARR_PORT: String(port), MANGARR_NO_JOBS: "1" },
    stdio: "ignore",
  });
  const code = await new Promise((r) => p.on("exit", r));
  assert.notEqual(code, 0);
});
