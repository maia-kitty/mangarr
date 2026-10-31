# Mangarr

Sonarr for manga. You add a series (by its AniList entry), Mangarr finds it on your sources, downloads every chapter (or every chapter from N on), keeps checking for new ones and files them into a clean library folder that Mihon, Suwayomi and [Jellyshelf](https://github.com/maia-kitty/Jellyshelf) can all read.

Sources are the same extensions Mihon uses ([keiyoushi](https://github.com/keiyoushi/extensions-source)). They're Android code, so Mangarr runs them through [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server), a headless Mihon, in a second container.

- **Series**: poster grid / table, chapter counts, monitored on/off, edit the start chapter, change source, delete (optionally with files)
- **Add New**: search AniList, optionally "start from chapter N" (e.g. where the anime ends)
- **Sources**: install extensions from keiyoushi, order them by priority. A new series takes the first source with an exact title match
- **Fallback**: a source that keeps failing for a day gets swapped for the next one. Chapters already on disk are never downloaded twice
- **Activity / Wanted / System**: download queue, imports, missing chapters, status and logs
- **API** (`/api/v1`) for Jellyshelf. Needs no key from local addresses (LAN, Docker, NetBird), like the rest of the arr stack; anything else sends `X-Api-Key`

How it works, the folder layout, reading on Mihon and the API: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Run
```sh
git clone <this repo> mangarr
cp mangarr/compose.example.yaml compose.yaml   # edit paths + password
docker compose up -d --build
```
Open `http://<server>:8206` → Settings → Sources → install one or two extensions (e.g. MangaPill, Weeb Central) → Add New.

## Develop
Node 24+, no runtime dependencies (plain `node:http`, `node:sqlite`, TypeScript run directly).
```sh
npm install            # only typescript + @types/node, for the typecheck
npm test               # node --test
npm run typecheck
npm run dev            # needs a Suwayomi on 127.0.0.1:4567 that sees ./dev/ at the same path
```

## Planned
- **AniList reading progress from Jellyshelf**: Jellyshelf's reader marks chapters read on AniList, plus "Continue reading". That lives in Jellyshelf, not here
- Unnumbered chapters (oneshots/extras with no chapter number) are skipped for now
