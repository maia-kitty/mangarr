// Pure helpers (no db, no network), covered by lib.test.ts.

/** Same normalisation as Jellyshelf's src/lib/titleMatch.ts (copied, different repo). */
export const norm = (t: string) =>
  t
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[‘’ʻ`]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();

/** The search result whose title equals one of the series' names, ignoring case/punctuation/accents. */
export function bestMatch<T extends { title: string }>(results: T[], titles: string[]): T | null {
  const wanted = new Set(titles.map(norm).filter(Boolean));
  return results.find((r) => wanted.has(norm(r.title))) ?? null;
}

/**
 * Which remote chapters to download: numbered, at or after the start chapter, not on disk yet,
 * one per chapter number (the first one listed wins, so a second scanlation isn't downloaded too).
 */
export function pickWanted<C extends { chapterNumber: number }>(remote: C[], onDisk: Set<number>, start: number): C[] {
  const seen = new Set<number>();
  return remote.filter((c) => {
    const n = c.chapterNumber;
    // shortcut: unnumbered chapters (-1: oneshots, extras) are skipped; add a name-based rule if they matter.
    if (!(n >= 0) || n < start || onDisk.has(n) || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

/** "Fire Punch - Ch. 012.5.cbz": zero-padded so files sort right, and Mihon/Suwayomi read the number from it. */
export function chapterFile(folder: string, n: number) {
  const [int, dec] = String(n).split(".");
  return `${folder} - Ch. ${int.padStart(3, "0")}${dec ? `.${dec}` : ""}.cbz`;
}

/** A title as a single safe folder name (no path separators, no characters Windows/Android choke on). */
export function safeFolder(title: string) {
  const s = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 150)
    .trim();
  return s || "Untitled";
}

/** Loose equality for matching a downloaded file name to a chapter name (Suwayomi sanitises names its own way). */
export const loose = (s: string) => s.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
