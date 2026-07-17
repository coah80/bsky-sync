import assert from "node:assert/strict";
import test from "node:test";
import {
  expandTcoUrls,
  graphemeLength,
  prepareTweetText,
  stripTrailingTcoLink,
  truncateToBskyLimit,
  unescapeHtmlEntities,
} from "../src/text.js";

test("expands t.co URLs from parsed URL entities", () => {
  assert.equal(
    expandTcoUrls("read https://t.co/abc", [
      { url: "https://t.co/abc", expanded_url: "https://example.com/story" },
    ]),
    "read https://example.com/story",
  );
});

test("strips a trailing media t.co link", () => {
  const tweet = {
    media: [{ url: "https://t.co/media" }],
    urls: [],
  };
  assert.equal(
    stripTrailingTcoLink("photo caption https://t.co/media", tweet),
    "photo caption",
  );
});

test("strips a trailing quoted-tweet t.co link", () => {
  const tweet = {
    quoting: { id: "42" },
    media: [],
    urls: [
      {
        url: "https://t.co/quote",
        expanded_url: "https://x.com/user/status/42",
      },
    ],
  };
  assert.equal(
    stripTrailingTcoLink("context https://t.co/quote", tweet),
    "context",
  );
});

test("unescapes named, decimal, and hexadecimal HTML entities", () => {
  assert.equal(
    unescapeHtmlEntities("A &amp; B &lt; C &#39;ok&#39; &#x1F600;"),
    "A & B < C 'ok' 😀",
  );
});

test("prepares tweet text in the required order", () => {
  const tweet = {
    text: "A &amp; B https://t.co/link https://t.co/media",
    urls: [
      { url: "https://t.co/link", expanded_url: "https://example.com" },
    ],
    media: [{ url: "https://t.co/media" }],
  };
  assert.equal(prepareTweetText(tweet), "A & B https://example.com");
});

test("truncates to 299 graphemes plus an ellipsis", () => {
  const source = "😀".repeat(301);
  const result = truncateToBskyLimit(source);
  assert.equal(graphemeLength(result), 300);
  assert.equal(result.endsWith("…"), true);
  assert.equal(result, `${"😀".repeat(299)}…`);
});

