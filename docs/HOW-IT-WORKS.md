# How Mangarr works

```
Jellyshelf ──X-Api-Key──► mangarr :8206 ──GraphQL──► Suwayomi :8207 ──► keiyoushi sources
browser (UI) ───────────►      │                         │
                               ▼                         ▼
         /data/media/manga/<Series>/<Series> - Ch. 012.cbz ◄── moved ── /data/downloads/manga
                               ▲
     Suwayomi Local source = /data/media/manga ──► Mihon "Suwayomi" extension (network)
     Syncthing of the folder                    ──► Mihon Local source (offline)
```

## Roles
| Part | Does |
|---|---|
| **AniList** | identity of a series (like TVDB for Sonarr): titles, cover, description, status |
| **Suwayomi** | runs the extensions: search, chapter lists, downloads (CBZ with ComicInfo.xml inside), serves pages |
| **Mangarr** | what Suwayomi doesn't do: picks the source, decides which chapters to get, moves files into the library, falls back when a source dies, the UI and API |
| **Jellyshelf** | the frontend for everyone: browse, request, read |

## Adding a series
1. `POST /api/v1/series {anilistId, ranges?}` (or Add New in the UI)
2. **Match:** the enabled sources are searched in priority order with the AniList titles (english, romaji, 2 synonyms). A result counts only if its title equals one of the series' names, ignoring case, accents and punctuation. First hit wins. No hit → state `no_match` (retried every sync, so enabling a new source can fix it), or pick one by hand with **Change Source**
   A match whose chapter list is empty doesn't count (MangaDex lists licensed series with no chapters): the next source is tried
3. **Numbering:** decimal chapters (12.5, 139.2) keep their number. Chapters the source can't number (oneshots, extras, side stories; Suwayomi says `-1`) get the number of the chapter before them + .01 per extra: an extra after chapter 12 is `12.01`, the next `12.02`. A title with no numbered chapters at all (a oneshot) is chapter 1, 2, … The same extra from two scanlators (same name, same gap) is one chapter
4. **Wanted chapters** = chapters in the series' wanted ranges (e.g. `1–10, 50–60, 100–`; an open end keeps following new ones) that aren't on disk, **one per chapter number** (the first scanlation listed wins)
5. Queued in Suwayomi's downloader. Every 30 s mangarr moves finished CBZs into the library, writes `cover.jpg` + `ComicInfo.xml` for the series, clears Suwayomi's "downloaded" mark and refreshes the series' Local-source entry

Every 30 min (`MANGARR_SYNC_MINUTES`) each monitored series is checked again for new chapters.

## Library layout
```
/data/media/manga/
  Fire Punch/
    cover.jpg
    ComicInfo.xml            series info (Mihon/Suwayomi Local source read it)
    Fire Punch - Ch. 078.cbz each has its own ComicInfo.xml from Suwayomi
    Fire Punch - Ch. 012.5.cbz
```
- Folder = AniList English title (else romaji), made filesystem-safe. Two series with the same title: the second gets ` (<anilist id>)`
- Numbers are zero-padded to 3 digits so the files sort. Mihon/Suwayomi read the chapter number from the file name

## Sources and fallback
- **Settings → Sources**: install extensions from the keiyoushi list (the same ones Mihon offers). Sources of an "all" extension (e.g. MangaDex) are added only for the languages in `MANGARR_LANGS` (default `en`)
- The order is the priority. It only matters when a series gets matched
- **A source that fails** (chapter list errors) for over **24 h** is swapped for the next source that has the title. Chapters already on disk stay and aren't downloaded again; missing ones come from the new source
- **A source that empties out** (still has the title, no chapters any more: taken down or licensed) is swapped right away
- **A source that quietly falls behind:** every 2 days, a series still coming out (or a finished one that's missing chapters) is compared with the other enabled sources. If one has a newer chapter, the series moves there (the log says "MangaPill stops at 120, Weeb Central has 123")
- **Change Source** (by hand or automatic) first imports whatever already finished downloading, then deletes what the old source left in Suwayomi's download folder. Empty download folders are cleared after each full check
- Syncs, source changes and deletes of one series run one at a time, so a slow sync of the old source can't write its chapters after a source change
- **Cloudflare:** tested 2026-10-31 from a home connection, Asura Scans, MangaFire, Toonily and Flame Comics all worked without help (search, chapters, full downloads). If a source starts showing Cloudflare errors, set `FLARESOLVERR_URL` (e.g. a Byparr/FlareSolverr at `http://byparr:8191`); mangarr turns it on in Suwayomi
- **Change Source** on a series does the same by hand

## Reading
- **Jellyshelf:** `GET /api/v1/series/:anilistId/chapters/:number/pages` → `{count}`, then `/pages/:n` → the image. Mangarr asks Suwayomi's Local source for the pages, so nothing unzips CBZs itself
- **Mihon over the network:** install the **Suwayomi** extension in Mihon (Browse → Extensions; it's in keiyoushi) → its settings: address `http://<server-ip>:8207` (or its VPN IP), username/password from the compose file → browse the "Suwayomi" source: every mangarr series is in the Suwayomi library, category **Mangarr**
- **Mihon offline:** sync `/mnt/hdd1/media/manga` to the phone (Syncthing, send-only from the server) into Mihon's `local/` folder → Mihon's **Local source** shows the series with cover and description

## Auth
A request gets in with any of:
- **`X-Api-Key`** (or `?apikey=`): Jellyshelf, scripts. The key is created on first start in `/config/api-key` and shown in Settings → General
- **A login session** (cookie `mangarr_session`: HttpOnly, SameSite=Strict, 30 days; only its SHA-256 is stored, in the `sessions` table)
- **A local address** (private ranges, Docker, NetBird `100.64.0.0/10`, loopback; `MANGARR_LOCAL_CIDRS`), but only before a login is set up, or when *Authentication required* is *Disabled for local addresses*

The login (Sonarr's "Forms" authentication):
- One user in `/config/auth.json` (mode 600): username, scrypt hash (N=2^15, r=8, random salt), `localBypass`. A broken file stops mangarr from starting rather than leaving it open. **Forgot the password:** delete the file, restart, set a new one
- **First setup** (`POST /auth/setup`) only from a local address or with the API key, and only while there's no login. The UI won't show anything else until it's done
- **Brute force:** per address (an IPv6 /64 counts as one), 5 wrong passwords, then a lockout of 30 s that doubles on every further miss, up to 1 h; the count is forgotten after a quiet day and cleared by a right password. A try counts *before* the password is checked, so parallel guesses can't slip past, and during a lockout even the right password gets 429 + `Retry-After`. At most 4 hashes run at once (each takes 32 MiB). Wrong passwords and lockouts go to the log with the address
- A wrong username costs the same time as a wrong password (the hash always runs), and username/password compares are constant-time
- **Changing the login** (`PUT /auth`) always needs the current password (also from a local address that needs no login) and is under the same lockout. A new username or password ends every other session; this browser gets a new one
- **Cross-site requests:** non-GET requests whose `Origin` isn't this host get 403. The UI can't be put in a frame
- Behind a reverse proxy every request comes from the proxy's address, so the lockout is shared: someone guessing locks you out of the login too (sessions and the API key keep working). `X-Forwarded-For` isn't trusted, since anyone can send it. `X-Forwarded-Proto: https` adds `Secure` to the cookie
- Suwayomi's port is open for Mihon, so it runs with basic auth (`AUTH_MODE=basic_auth`); mangarr sends the same credentials (`SUWAYOMI_USER` / `SUWAYOMI_PASS`)

## API (`/api/v1`)
| Route | Does |
|---|---|
| `GET /auth` | `{configured, allowed, username, loggedIn, localBypass, local}` (no login needed) |
| `POST /auth/setup` `{username, password, localBypass?}` · `POST /auth/login` `{username, password}` · `POST /auth/logout` | no login needed; login/setup set the session cookie |
| `PUT /auth` `{currentPassword, username?, newPassword?, localBypass?}` | change the login |
| `GET /status` | version, Suwayomi reachable, last sync, API key |
| `GET /lookup?term=` | AniList manga search (`added` marks the ones already here) |
| `GET /series` · `GET /series/:id` | series with `chaptersOnDisk`, `chaptersMissing`, `latestChapter`, `state` (`ok`/`no_match`/`error`/`matching`), `sourceName` |
| `POST /series` `{anilistId, ranges?: [{from, to}]}` | add (201). Chapters `from`–`to`; `to: null` = keep following new chapters; no `ranges` = every chapter |
| `PATCH /series/:id` `{monitored?, ranges?, addRange?: {from, to}, sourceId?+mangaId?}` | edit; `ranges` replaces them all, `addRange` adds one (joined with any it overlaps); `sourceId` + `mangaId` = change source |
| `DELETE /series/:id?deleteFiles=true` | remove (the folder too if asked) |
| `POST /series/:id/refresh` | check that series now |
| `GET /series/:id/candidates` | search results on every enabled source, for Change Source |
| `GET /series/:id/chapters` | `{number, name, file, onDisk, wanted, imported}`. `?all=true` adds the chapters the source has outside the wanted ranges (`wanted: false`); `addRange` gets them |
| `GET /series/:id/chapters/:n/pages` · `/pages/:p` | page count · page image |
| `GET /queue` · `GET /history` · `GET /wanted` | downloads in progress · imports · missing chapters |
| `GET /sources` · `PUT /sources {ids}` | enabled sources in priority order · set them |
| `GET /sources/installed` · `GET /extensions` · `POST /extensions/install {pkgName}` | Suwayomi's sources · keiyoushi extension list · install |
| `POST /command/refresh` | check every series now |
| `GET /log` | recent log lines |

`:id` is always the AniList id.

## Code
| File | What |
|---|---|
| `src/server.ts` | HTTP routes, the auth gate, static UI, start-up + timers |
| `src/auth.ts` | login file, password hashing, sessions, brute-force lockout; attacked in `auth.test.ts` (a real server on a throwaway config) |
| `src/sync.ts` | add/delete, matching, wanted chapters, import (moving files), fallback |
| `src/suwayomi.ts` | Suwayomi GraphQL calls (names checked against v2.4) |
| `src/anilist.ts` | AniList queries |
| `src/lib.ts` | pure helpers (title matching, wanted-chapter pick, file names), tested in `lib.test.ts` |
| `src/db.ts` | config from env, SQLite (`/config/mangarr.db`), API key, log buffer |
| `public/` | the UI: `index.html`, `app.js` (plain JS, hash routes), `style.css` |

## Known limits
- An extra keeps the number it got first. A new extra that shows up *before* an older one in the same gap takes the next free number, so those two sort the wrong way round (nothing is downloaded twice)
- Matching needs an exact title match, so a source that names a series differently needs **Change Source** once
- The every-2-days comparison only looks at *other* sources: a second, more complete entry of the same series on the same source isn't found (Change Source can pick it)

## AniList reading progress
Lives in Jellyshelf: its reader moves your AniList progress when you reach the end of a chapter (whole chapters: 12.5 counts as 12, extras before chapter 1 as nothing), and Discover has a "Continue reading" row. Mangarr needs nothing for it.
