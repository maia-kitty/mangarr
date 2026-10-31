import { test } from "node:test";
import assert from "node:assert/strict";
import { bestMatch, chapterFile, loose, pickWanted, safeFolder } from "./lib.ts";

test("bestMatch ignores case, punctuation and accents, and doesn't take near misses", () => {
  const results = [{ title: "Fire Punch Side Story" }, { title: "FIRE PUNCH" }];
  assert.equal(bestMatch(results, ["Fire Punch"])?.title, "FIRE PUNCH");
  assert.equal(bestMatch([{ title: "Frieren - Beyond Journey's End" }], ["Frieren: Beyond Journey’s End"])?.title, "Frieren - Beyond Journey's End");
  assert.equal(bestMatch([{ title: "Pokemon Adventures" }], ["Pokémon Adventures"])?.title, "Pokemon Adventures");
  assert.equal(bestMatch([{ title: "Fire Punch Side Story" }], ["Fire Punch"]), null);
});

test("pickWanted: start chapter, on-disk, duplicates across scanlators, decimals, unnumbered", () => {
  const ch = (chapterNumber: number, scanlator = "A") => ({ chapterNumber, scanlator });
  const remote = [ch(1), ch(2), ch(2, "B"), ch(2.5), ch(3), ch(-1), ch(4)];
  const got = pickWanted(remote, new Set([3]), 2);
  assert.deepEqual(got, [ch(2), ch(2.5), ch(4)]);
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
