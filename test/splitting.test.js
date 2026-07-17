import assert from "node:assert/strict";
import test from "node:test";
import { graphemeLength, splitTextForBsky } from "../src/text.js";

test("splits long text at whitespace boundaries within the thread limit", () => {
  const source = "word ".repeat(80).trim();
  const chunks = splitTextForBsky(source);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => graphemeLength(chunk) <= 295), true);
  assert.equal(chunks.every((chunk) => !/^\s|\s$/u.test(chunk)), true);
  assert.equal(chunks.join(" "), source);
});

test("hard-splits a single token at grapheme boundaries", () => {
  const source = "😀".repeat(601);
  const chunks = splitTextForBsky(source);
  assert.deepEqual(chunks.map(graphemeLength), [295, 295, 11]);
  assert.equal(chunks.join(""), source);
});

test("keeps text at the single-post limit as one unchanged chunk", () => {
  const source = "😀".repeat(300);
  assert.deepEqual(splitTextForBsky(source), [source]);
});
