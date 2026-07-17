import assert from "node:assert/strict";
import test from "node:test";
import { publishTweet } from "../src/bsky.js";
import { SyncDatabase } from "../src/db.js";

test("posts long text as a reply chain and maps the first chunk", async () => {
  const calls = [];
  const agent = {
    post: async (record) => {
      calls.push(record);
      const number = calls.length;
      return { uri: `at://post/${number}`, cid: `cid-${number}` };
    },
  };
  const tweet = {
    id: "9001",
    text: "threadword ".repeat(70).trim(),
    created_at: "2026-07-16T12:34:56.000Z",
    media: [],
    urls: [],
  };
  const database = new SyncDatabase(":memory:");
  try {
    const result = await publishTweet(
      agent,
      tweet,
      { kind: "original" },
      "100",
      database,
      { sleep: async () => {} },
    );
    database.setPost(tweet.id, result);

    assert.ok(calls.length > 1);
    assert.equal("reply" in calls[0], false);
    assert.deepEqual(calls[1].reply, {
      root: { uri: "at://post/1", cid: "cid-1" },
      parent: { uri: "at://post/1", cid: "cid-1" },
    });
    if (calls.length > 2) {
      assert.deepEqual(calls[2].reply, {
        root: { uri: "at://post/1", cid: "cid-1" },
        parent: { uri: "at://post/2", cid: "cid-2" },
      });
    }
    assert.equal(
      calls.every((record) => record.createdAt === tweet.created_at),
      true,
    );
    const mapping = database.getPost(tweet.id);
    assert.equal(mapping.bsky_uri, "at://post/1");
    assert.equal(mapping.bsky_cid, "cid-1");
    assert.equal(mapping.bsky_root_uri, "at://post/1");
    assert.equal(mapping.bsky_root_cid, "cid-1");
  } finally {
    database.close();
  }
});

test("logs every long dry-run chunk without posting", async () => {
  const logs = [];
  const agent = {
    post: async () => assert.fail("post should not be called"),
  };
  const tweet = {
    id: "9002",
    text: "dryrunword ".repeat(70).trim(),
    created_at: "2026-07-16T12:34:56.000Z",
    media: [],
    urls: [],
  };

  await publishTweet(
    agent,
    tweet,
    { kind: "original" },
    "100",
    { getPost: () => undefined },
    { dryRun: true, logger: (message) => logs.push(message) },
  );

  assert.ok(logs.length > 1);
  assert.equal(logs.every((line) => !line.includes("\n")), true);
  assert.equal(logs.every((line) => line.includes("dry run chunk")), true);
});

test("keeps a self-reply thread on the mapped root", async () => {
  const calls = [];
  const agent = {
    post: async (record) => {
      calls.push(record);
      const number = calls.length;
      return { uri: `at://chunk/${number}`, cid: `chunk-cid-${number}` };
    },
  };
  const parent = {
    bsky_uri: "at://parent/post",
    bsky_cid: "parent-cid",
    bsky_root_uri: "at://root/post",
    bsky_root_cid: "root-cid",
  };
  const database = {
    getPost: (tweetId) => (tweetId === "8000" ? parent : undefined),
  };
  const tweet = {
    id: "9003",
    text: "replythreadword ".repeat(60).trim(),
    created_at: "2026-07-16T12:34:56.000Z",
    in_reply_to_status_id: "8000",
    media: [],
    urls: [],
  };

  const result = await publishTweet(
    agent,
    tweet,
    { kind: "self_reply" },
    "100",
    database,
    { sleep: async () => {} },
  );

  assert.deepEqual(calls[0].reply, {
    root: { uri: "at://root/post", cid: "root-cid" },
    parent: { uri: "at://parent/post", cid: "parent-cid" },
  });
  assert.deepEqual(calls[1].reply, {
    root: { uri: "at://root/post", cid: "root-cid" },
    parent: { uri: "at://chunk/1", cid: "chunk-cid-1" },
  });
  assert.equal(result.uri, "at://chunk/1");
  assert.equal(result.rootUri, "at://root/post");
});
