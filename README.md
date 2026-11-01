<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icon-mono-white.svg">
    <img src="assets/icon-mono.svg" alt="Mangarr" width="96">
  </picture>
</p>

<h1 align="center">Mangarr</h1>

<p align="center">
  Sonarr for manga: add a series once, and every chapter (and every new one) lands in your library,<br>
  from the same sources <b>Mihon</b> uses.
</p>

> [!NOTE]
> **This is a personal, vibe-coded project.** I built it for my own home server, almost entirely by steering an AI
> coding assistant (Claude) rather than writing the code by hand. I decided what it should do, tried it, and kept
> asking for changes until it behaved; I did not review every line myself. What that means for you:
>
> - **It's tested on my setup, not yours.** One Debian server, Suwayomi-Server v2.4, a handful of English sources
>   (MangaPill, Weeb Central, MangaDex, Asura Scans, MangaFire, Toonily, Flame Comics). Other sources, languages and
>   Suwayomi versions may behave differently.
> - **It's built for a home network.** The web UI has a login (with brute-force lockout), but there's no HTTPS of its
>   own and it hasn't been audited. Keep it on your LAN or VPN, or behind a reverse proxy with HTTPS.
> - **Sources change all the time.** The extensions scrape third-party websites; when a site changes or disappears, a
>   series can stop updating until the extension is fixed or you switch it to another source.
> - **Expect rough edges and breaking changes** without warning or migration paths. Issues and ideas are welcome, but
>   I can't promise support. Keep backups of `/config` if you care about your settings.
> - **What you download is up to you.** Mangarr doesn't host, provide or endorse any content; it only automates the
>   extensions you choose to install. Check what's legal where you live, and support the authors when you can.

Mangarr manages the series; [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server) (a headless Mihon, in a
second container) runs the extensions. The extensions are Android code from
[keiyoushi](https://github.com/keiyoushi/extensions-source), so something Mihon-shaped has to run them, and Suwayomi
already does that well. Mangarr adds what it doesn't have: knowing a series by its AniList entry, picking and falling
back between sources, "start from chapter N", and a clean library folder.

## Features

- **Series:** poster grid or table with chapter counts per series, monitored on/off, edit the start chapter, change
  source, delete (optionally with its files). Looks and works like Sonarr/Radarr.
- **Add New:** search AniList and add a manga, optionally "from chapter N" (say, where the anime ends).
- **Sources:** install extensions from the keiyoushi list (the same ones Mihon offers) and put them in priority order.
  A new series goes to the first source that has the exact title with chapters in it.
- **Every kind of chapter:** decimal chapters (12.5), unnumbered extras (numbered after the chapter before them:
  12.01, 12.02…) and oneshots (chapter 1). The same chapter from two scanlators is downloaded once.
- **Fallback:** a source that keeps failing for a day, stops listing chapters, or quietly falls behind the others
  (checked every couple of days) is swapped for one that has the series. Chapters already on disk are never
  downloaded twice.
- **Clean library:** `<Series>/<Series> - Ch. 012.cbz` plus `cover.jpg` and `ComicInfo.xml`, moved (not copied) in
  from the download folder. Readable by Mihon's Local source, Suwayomi, Komga/Kavita-style readers and
  [Jellyshelf](https://github.com/maia-kitty/Jellyshelf).
- **Reading on your phone:** over the network through Mihon's Suwayomi extension (every series is in the Suwayomi
  library), or offline by syncing the library folder into Mihon's `local/` folder.
- **Activity, Wanted, System:** download queue with progress, recent imports, missing chapters, status and logs.
- **API** (`/api/v1`) for front ends. [Jellyshelf](https://github.com/maia-kitty/Jellyshelf) uses it to request
  manga, show what's downloaded, read chapters in its own reader and keep your AniList reading progress.

## How it works

```
Jellyshelf ──► Mangarr :8206 ──► Suwayomi :8207 ──► keiyoushi sources
browser ─────►     │                  │
                   ▼                  ▼
  /data/media/manga/<Series>/<Series> - Ch. 012.cbz ◄── moved ── /data/downloads/manga
```

1. You add a series by its AniList entry. Mangarr searches your sources in priority order with its titles (English,
   romaji, synonyms) and takes the first exact match.
2. Every 30 minutes it asks the source for the chapter list and queues whatever is missing (from the start chapter on)
   in Suwayomi's downloader.
3. Finished chapters are moved into the library and Suwayomi's Local source is refreshed, so Mihon and Jellyshelf see
   them straight away.

Details (matching, numbering, fallback rules, the folder layout, Mihon setup and the full API):
[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Getting started

```sh
git clone https://github.com/maia-kitty/mangarr.git mangarr
cp mangarr/compose.example.yaml compose.yaml   # set the paths and the Suwayomi password
docker compose up -d --build                   # → http://localhost:8206
```

Both containers must see the media disk at the **same path** (`/data` in the example): Suwayomi downloads into
`/data/downloads/manga`, Mangarr moves the files to `/data/media/manga`. On one filesystem that move is instant and
there's only ever one copy.

Then in the UI:

1. **Settings → Sources:** install one or two extensions (MangaPill and Weeb Central are a good start) and order them.
2. **Add New:** search for a manga and add it.
3. Watch it in **Activity**; the chapters show up on the series page as they land.

If a source sits behind Cloudflare and starts failing, point `FLARESOLVERR_URL` at a
[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) or [Byparr](https://github.com/ThePhaseless/Byparr)
instance; Mangarr turns it on in Suwayomi. None of the sources above needed it in my testing.

### Data and access

All of Mangarr's state lives in `/config`: the SQLite database (`mangarr.db`), the API key (`api-key`, also shown
in Settings → General) and the login (`auth.json`). Suwayomi keeps its own data (installed extensions, its library) in
its own volume.

The first time you open the web UI it asks you to set a username and password (only from a local address: private
ranges, Docker, `100.64.0.0/10` for Tailscale/NetBird, loopback; change the list with `MANGARR_LOCAL_CIDRS`). Like
Sonarr, **Authentication required** can be *Enabled* (always log in) or *Disabled for local addresses*. Change the
login or log out in Settings → General. Forgot the password? Delete `/config/auth.json`, restart, and set a new one.
Jellyshelf and scripts don't log in: they send `X-Api-Key`. Suwayomi's port is open for Mihon,
so run it with basic auth (`AUTH_MODE=basic_auth`) and give Mangarr the same login (`SUWAYOMI_USER`/`SUWAYOMI_PASS`).

The container runs as 1000:1000 (`user:` in the compose file).

## Development

Node 24+ and no runtime dependencies: plain `node:http`, `node:sqlite`, `fetch`, and TypeScript run directly by Node.
The UI is plain HTML/JS/CSS in `public/`, no build step.

- `npm install`: only TypeScript and Node's types, for the typecheck
- `npm test`: unit tests (title matching, chapter numbering, which chapters to download, file names)
- `npm run typecheck`
- `npm run dev`: runs against a Suwayomi on `127.0.0.1:4567` that sees `./dev/` at the same path
- `MANGARR_NO_JOBS=1` turns off the background sync, for poking at the API

## Credits

Mangarr is mostly glue. It wouldn't be possible without these projects:

- [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server): runs the extensions, downloads, serves pages.
- [Mihon](https://mihon.app) and the [keiyoushi extensions](https://github.com/keiyoushi/extensions-source): the
  sources, and everyone who keeps them working.
- [Sonarr](https://sonarr.tv) and [Radarr](https://radarr.video): the look and the idea.
- [AniList](https://anilist.co): series info, covers and titles.
- [Kaizoku](https://github.com/oae/kaizoku): an earlier take on the same idea.

Not affiliated with any of them.

## License

[MIT](LICENSE). Do whatever you like with it.
