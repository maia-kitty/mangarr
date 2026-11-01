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

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Give every chapter a number. Sources report chapters they can't number (oneshots, extras, side stories) as -1:
 * those get the number of the chapter before them plus .01 per extra (an extra after chapter 12 becomes 12.01,
 * a second one 12.02), so they sort in reading order and Mihon/Suwayomi read the same number back from the file
 * name. A title with no numbered chapter at all (a oneshot) is simply 1, 2, ...
 * shortcut: a new extra inserted before an older one in the same gap shifts its number; fine for how rare that is.
 */
export function numberChapters<C extends { id?: number; chapterNumber: number; sourceOrder: number; name?: string }>(
  remote: C[],
  /** Numbers given before, by remote chapter id: an extra keeps its number even if a new one appears before it. */
  known: Map<number, number> = new Map(),
): (C & { number: number })[] {
  const ordered = [...remote].sort((a, b) => a.sourceOrder - b.sourceOrder);
  const numbered = ordered.filter((c) => c.chapterNumber >= 0);
  // Reading order: some sources list newest first.
  if (numbered.length > 1 && numbered[0].chapterNumber > numbered[numbered.length - 1].chapterNumber) ordered.reverse();
  if (!numbered.length) {
    // Two scanlations of one oneshot (same name) are one chapter.
    const byName = new Map<string, number>();
    return ordered.map((c) => {
      const key = c.name || `#${c.sourceOrder}`;
      if (!byName.has(key)) byName.set(key, byName.size + 1);
      return { ...c, number: byName.get(key)! };
    });
  }
  const taken = new Set([...numbered.map((c) => round2(c.chapterNumber)), ...known.values()]);
  let prev = 0;
  // The same extra from two scanlators (same name, same gap) gets one number, so only one is downloaded.
  let gap = new Map<string, number>();
  return ordered.map((c) => {
    if (c.chapterNumber >= 0) {
      gap = new Map();
      return { ...c, number: (prev = round2(c.chapterNumber)) };
    }
    const before = c.id !== undefined ? known.get(c.id) : undefined;
    if (before !== undefined) {
      if (c.name) gap.set(c.name, before);
      prev = Math.max(prev, before);
      return { ...c, number: before };
    }
    const same = c.name ? gap.get(c.name) : undefined;
    if (same !== undefined) return { ...c, number: same };
    let n = round2(prev + 0.01);
    while (taken.has(n)) n = round2(n + 0.01);
    taken.add(n);
    if (c.name) gap.set(c.name, n);
    prev = n;
    return { ...c, number: n };
  });
}

/** The highest real (source-numbered) chapter, or -1 when there's none. */
export const latestNumbered = (remote: { chapterNumber: number }[]) => Math.max(-1, ...remote.map((c) => c.chapterNumber));

/** Chapters `from` to `to` (both included); `to` null = every chapter after `from`, new ones too. */
export type Range = [from: number, to: number | null];
export const inRanges = (n: number, ranges: Range[]) => ranges.some(([from, to]) => n >= from && (to === null || n <= to));
/** Sorted, with overlapping ranges joined (1–10 + 5–20 = 1–20); separate ones stay separate (1–10, 50–60). */
export function mergeRanges(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && (last[1] === null || from <= last[1])) last[1] = last[1] === null || to === null ? null : Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}
/** "1–10, 50–60, from 100" */
export const rangesLabel = (ranges: Range[]) =>
  ranges.map(([from, to]) => (to === null ? (from ? `from ${from}` : "every chapter") : from === to ? `${from}` : `${from || 1}–${to}`)).join(", ");

/**
 * Which chapters to download: the ones in the wanted ranges, not on disk yet, one per chapter number (the first
 * one listed wins, so a second scanlation isn't downloaded too). Run numberChapters first.
 */
export function pickWanted<C extends { number: number }>(remote: C[], onDisk: Set<number>, ranges: Range[]): C[] {
  const seen = new Set<number>();
  return remote.filter((c) => {
    const n = c.number;
    if (!inRanges(n, ranges) || onDisk.has(n) || seen.has(n)) return false;
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
