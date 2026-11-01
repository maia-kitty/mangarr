import { test } from "node:test";
import assert from "node:assert/strict";
import { bestMatch, chapterFile, loose, mergeRanges, numberChapters, pickWanted, rangesLabel, safeFolder } from "./lib.ts";

test("bestMatch ignores case, punctuation and accents, and doesn't take near misses", () => {
  const results = [{ title: "Fire Punch Side Story" }, { title: "FIRE PUNCH" }];
  assert.equal(bestMatch(results, ["Fire Punch"])?.title, "FIRE PUNCH");
  assert.equal(bestMatch([{ title: "Frieren - Beyond Journey's End" }], ["Frieren: Beyond Journey’s End"])?.title, "Frieren - Beyond Journey's End");
  assert.equal(bestMatch([{ title: "Pokemon Adventures" }], ["Pokémon Adventures"])?.title, "Pokemon Adventures");
  assert.equal(bestMatch([{ title: "Fire Punch Side Story" }], ["Fire Punch"]), null);
});

test("pickWanted: start chapter, on-disk, duplicates across scanlators, decimals", () => {
  const ch = (number: number, scanlator = "A") => ({ number, scanlator });
  const remote = [ch(1), ch(2), ch(2, "B"), ch(2.5), ch(3), ch(4)];
  const got = pickWanted(remote, new Set([3]), [[2, null]]);
  assert.deepEqual(got, [ch(2), ch(2.5), ch(4)]);
  // Up to an end chapter: its extras (2.5) are in, the next chapter isn't.
  assert.deepEqual(pickWanted(remote, new Set(), [[1, 2.5]]), [ch(1), ch(2), ch(2.5)]);
  assert.deepEqual(pickWanted(remote, new Set(), [[2, 2]]), [ch(2)]);
  // Separate ranges: nothing in the gap.
  assert.deepEqual(pickWanted(remote, new Set(), [[1, 1], [4, null]]), [ch(1), ch(4)]);
});

test("mergeRanges joins overlaps only, rangesLabel reads them", () => {
  assert.deepEqual(mergeRanges([[50, 60], [1, 10]]), [[1, 10], [50, 60]]);
  assert.deepEqual(mergeRanges([[1, 10], [5, 20], [20, 25]]), [[1, 25]]);
  assert.deepEqual(mergeRanges([[53, null], [1, 10], [60, 70]]), [[1, 10], [53, null]]);
  assert.deepEqual(mergeRanges([[1, 10], [3, null]]), [[1, null]]);
  assert.deepEqual(mergeRanges([[10, 11], [11.5, 12]]), [[10, 11], [11.5, 12]]);
  assert.equal(rangesLabel([[0, 10], [50, 60], [7, 7], [100, null]]), "1–10, 50–60, 7, from 100");
  assert.equal(rangesLabel([[0, null]]), "every chapter");
});

const nums = (list: [number, number][]) => numberChapters(list.map(([chapterNumber, sourceOrder]) => ({ chapterNumber, sourceOrder }))).map((c) => c.number);

test("numberChapters: extras take the number after the chapter before them", () => {
  // order: 1, extra, 2, 2.5, extra, extra, 3
  assert.deepEqual(nums([[1, 1], [-1, 2], [2, 3], [2.5, 4], [-1, 5], [-1, 6], [3, 7]]), [1, 1.01, 2, 2.5, 2.51, 2.52, 3]);
});

test("numberChapters: reads newest-first lists in reading order, avoids real numbers", () => {
  // newest first: 3, extra, 2, 1.01 (a real one), 1  → reading order 1, 1.01, 2, extra, 3
  assert.deepEqual(nums([[3, 1], [-1, 2], [2, 3], [1.01, 4], [1, 5]]), [1, 1.01, 2, 2.01, 3]);
  assert.deepEqual(nums([[1, 1], [-1, 2], [1.01, 3]]), [1, 1.02, 1.01]);
});

test("numberChapters: the same extra from two scanlators shares a number", () => {
  const got = numberChapters([
    { chapterNumber: 5, sourceOrder: 1, name: "Chapter 5" },
    { chapterNumber: -1, sourceOrder: 2, name: "Extra" },
    { chapterNumber: -1, sourceOrder: 3, name: "Extra" },
    { chapterNumber: -1, sourceOrder: 4, name: "Omake" },
  ]).map((c) => c.number);
  assert.deepEqual(got, [5, 5.01, 5.01, 5.02]);
});

test("numberChapters: an extra keeps the number it was given, even when a new one appears before it", () => {
  const ch = (id: number, chapterNumber: number, sourceOrder: number) => ({ id, chapterNumber, sourceOrder });
  const first = numberChapters([ch(1, 1, 1), ch(3, -1, 2), ch(4, 2, 3)]).map((c) => c.number);
  assert.deepEqual(first, [1, 1.01, 2]);
  // Later a new extra (id 2) shows up before the known one (id 3): id 3 stays 1.01, the newcomer takes the next free number.
  const later = numberChapters([ch(1, 1, 1), ch(2, -1, 2), ch(3, -1, 3), ch(4, 2, 4)], new Map([[3, 1.01]])).map((c) => c.number);
  assert.deepEqual(later, [1, 1.02, 1.01, 2]);
});

test("numberChapters: an extra before chapter 1, and a oneshot with no numbers at all", () => {
  assert.deepEqual(nums([[-1, 1], [1, 2]]), [0.01, 1]);
  assert.deepEqual(nums([[-1, 1]]), [1]);
  assert.deepEqual(nums([[-1, 1], [-1, 2]]), [1, 2]);
  const twoScans = numberChapters([{ chapterNumber: -1, sourceOrder: 1, name: "Oneshot" }, { chapterNumber: -1, sourceOrder: 2, name: "Oneshot" }]);
  assert.deepEqual(twoScans.map((c) => c.number), [1, 1]);
});

test("chapterFile pads the whole part and keeps decimals", () => {
  assert.equal(chapterFile("Fire Punch", 7), "Fire Punch - Ch. 007.cbz");
  assert.equal(chapterFile("Fire Punch", 12.5), "Fire Punch - Ch. 012.5.cbz");
  assert.equal(chapterFile("One Piece", 1100), "One Piece - Ch. 1100.cbz");
});

test("safeFolder never yields a path", () => {
  assert.equal(safeFolder("Re:Zero / Part 2"), "Re Zero Part 2");
  assert.equal(safeFolder("../.."), "Untitled");
  assert.equal(safeFolder("..hidden.."), "hidden");
  assert.ok(!safeFolder('a\\b*c?"d<e>f|g').match(/[\\/*?"<>|]/));
});

test("loose matches Suwayomi's sanitised file names", () => {
  assert.equal(loose("Chapter 12: The End?"), loose("Chapter 12_ The End_"));
});
