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
1. `POST /api/v1/series {anilistId, startChapter?}` (or Add New in the UI)
2. **Match:** the enabled sources are searched in priority order with the AniList titles (english, romaji, 2 synonyms). A result counts only if its title equals one of the series' names, ignoring case, accents and punctuation. First hit wins. No hit → state `no_match` (retried every sync, so enabling a new source can fix it), or pick one by hand with **Change Source**
3. **Wanted chapters** = numbered chapters ≥ start chapter that aren't on disk, **one per chapter number** (the first scanlation listed wins)
4. Queued in Suwayomi's downloader. Every 30 s mangarr moves finished CBZs into the library, writes `cover.jpg` + `ComicInfo.xml` for the series, clears Suwayomi's "downloaded" mark and refreshes the series' Local-source entry

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
- **Change Source** on a series does the same by hand

## Reading
- **Jellyshelf:** `GET /api/v1/series/:anilistId/chapters/:number/pages` → `{count}`, then `/pages/:n` → the image. Mangarr asks Suwayomi's Local source for the pages, so nothing unzips CBZs itself
- **Mihon over the network:** install the **Suwayomi** extension in Mihon (Browse → Extensions; it's in keiyoushi) → its settings: address `http://<server-ip>:8207` (or its VPN IP), username/password from the compose file → browse the "Suwayomi" source: every mangarr series is in the Suwayomi library, category **Mangarr**
- **Mihon offline:** sync `/mnt/hdd1/media/manga` to the phone (Syncthing, send-only from the server) into Mihon's `local/` folder → Mihon's **Local source** shows the series with cover and description

## Auth
- The UI and API need no key from **local addresses**: private ranges, Docker, NetBird (`100.64.0.0/10`), loopback. Change with `MANGARR_LOCAL_CIDRS`
- Anything else needs `X-Api-Key` (or `?apikey=`). The key is created on first start in `/config/api-key` and shown in Settings → General
- Suwayomi's port is open for Mihon, so it runs with basic auth (`AUTH_MODE=basic_auth`); mangarr sends the same credentials (`SUWAYOMI_USER` / `SUWAYOMI_PASS`)

## API (`/api/v1`)
| Route | Does |
|---|---|
| `GET /status` | version, Suwayomi reachable, last sync, API key |
| `GET /lookup?term=` | AniList manga search (`added` marks the ones already here) |
| `GET /series` · `GET /series/:id` | series with `chaptersOnDisk`, `chaptersMissing`, `latestChapter`, `state` (`ok`/`no_match`/`error`/`matching`), `sourceName` |
| `POST /series` `{anilistId, startChapter?}` | add (201) |
| `PATCH /series/:id` `{monitored?, startChapter?, sourceId?+mangaId?}` | edit; `sourceId` + `mangaId` = change source |
| `DELETE /series/:id?deleteFiles=true` | remove (the folder too if asked) |
| `POST /series/:id/refresh` | check that series now |
| `GET /series/:id/candidates` | search results on every enabled source, for Change Source |
| `GET /series/:id/chapters` | `{number, name, file, onDisk, imported}` |
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
| `src/server.ts` | HTTP routes, auth, static UI, start-up + timers |
| `src/sync.ts` | add/delete, matching, wanted chapters, import (moving files), fallback |
| `src/suwayomi.ts` | Suwayomi GraphQL calls (names checked against v2.4) |
| `src/anilist.ts` | AniList queries |
| `src/lib.ts` | pure helpers (title matching, wanted-chapter pick, file names), tested in `lib.test.ts` |
| `src/db.ts` | config from env, SQLite (`/config/mangarr.db`), API key, log buffer |
| `public/` | the UI: `index.html`, `app.js` (plain JS, hash routes), `style.css` |

## Known limits
- Unnumbered chapters (Suwayomi number `-1`: oneshots, extras) are skipped
- Matching needs an exact title match, so a source that names a series differently needs **Change Source** once
- Only chapter-list errors trigger the fallback. A source that silently stops getting new chapters doesn't
- Suwayomi's download folders (`/data/downloads/manga/mangas/<source>/<title>/`) stay behind empty after the files are moved

## Planned
- **AniList reading progress (in Jellyshelf):** the Jellyshelf reader sets the AniList chapter progress when a chapter is finished, and gets a "Continue reading" row. Mangarr needs nothing new for it
