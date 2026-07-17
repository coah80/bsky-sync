import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyTweet } from "../src/twitter.js";

const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const ownUserId = "100";

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixtureDirectory, name), "utf8"));
}

test("classifies a plain post as original", async () => {
  assert.equal(classifyTweet(await fixture("plain.json"), ownUserId).kind, "original");
});

test("classifies a media post as original", async () => {
  assert.equal(classifyTweet(await fixture("media.json"), ownUserId).kind, "original");
});

test("classifies a mapped own quote as self_quote", async () => {
  const tweet = await fixture("self-quote.json");
  const mapping = new Map([["900", { bsky_uri: "at://did/post/one" }]]);
  assert.equal(classifyTweet(tweet, ownUserId, mapping).kind, "self_quote");
});

test("classifies an external video quote as external_quote", async () => {
  assert.equal(
    classifyTweet(await fixture("external-quote-video.json"), ownUserId).kind,
    "external_quote",
  );
});

test("classifies an external image quote as external_quote", async () => {
  assert.equal(
    classifyTweet(await fixture("external-quote-images.json"), ownUserId).kind,
    "external_quote",
  );
});

test("classifies an own reply before its other content", async () => {
  const replies = await fixture("reply.json");
  assert.equal(classifyTweet(replies.self_reply, ownUserId).kind, "self_reply");
});

test("skips a reply to another user", async () => {
  const replies = await fixture("reply.json");
  assert.deepEqual(classifyTweet(replies.other_reply, ownUserId), {
    kind: "skip",
    reason: "reply_to_other",
  });
});

test("skips a retweet", async () => {
  assert.deepEqual(classifyTweet(await fixture("retweet.json"), ownUserId), {
    kind: "skip",
    reason: "retweet",
  });
});

