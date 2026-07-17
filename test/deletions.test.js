import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { SyncDatabase } from "../src/db.js";
import { syncDeletedTweets } from "../src/deletions.js";

function addPost(database, tweetId) {
  database.setPost(tweetId, {
    uri: `at://did:example:alice/app.bsky.feed.post/${tweetId}`,
    cid: `cid-${tweetId}`,
    rootUri: `at://did:example:alice/app.bsky.feed.post/${tweetId}`,
    rootCid: `cid-${tweetId}`,
  });
}

function storedPost(database, tweetId) {
  return database.database
    .prepare("SELECT * FROM posts WHERE tweet_id = ?")
    .get(String(tweetId));
}

test("migrates a populated legacy posts table without losing data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bsky-sync-deletions-"));
  const filename = path.join(directory, "legacy.db");
  let database;
  try {
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE posts (
        tweet_id TEXT PRIMARY KEY,
        bsky_uri TEXT NOT NULL,
        bsky_cid TEXT NOT NULL,
        bsky_root_uri TEXT NOT NULL,
        bsky_root_cid TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
      INSERT INTO posts VALUES (
        '42', 'at://post/42', 'cid-42', 'at://post/42', 'cid-42',
        '2026-07-16T00:00:00.000Z'
      );
    `);
    legacy.close();

    database = new SyncDatabase(filename);
    const columns = database.database
      .pragma("table_info(posts)")
      .map((column) => column.name);
    const row = storedPost(database, "42");
    assert.equal(columns.includes("deleted_at"), true);
    assert.equal(columns.includes("missing_count"), true);
    assert.equal(row.bsky_uri, "at://post/42");
    assert.equal(row.deleted_at, null);
    assert.equal(row.missing_count, 0);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns recent live posts in numeric tweet id order and hides tombstones", () => {
  const database = new SyncDatabase(":memory:");
  try {
    addPost(database, "9");
    addPost(database, "100");
    addPost(database, "10");
    database.markDeleted("100", "2026-07-16T00:00:00.000Z");

    assert.deepEqual(
      database.getRecentLivePosts(50).map((post) => post.tweet_id),
      ["10", "9"],
    );
    assert.equal(database.getPost("100"), undefined);
  } finally {
    database.close();
  }
});

test("requires two consecutive misses and resets a tweet that reappears", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    addPost(database, "100");
    addPost(database, "101");
    let call = 0;
    const client = {
      tweets: {
        getMany: async () => {
          call += 1;
          return call === 1 ? [] : [{ id: "100" }];
        },
      },
    };
    const deletedUris = [];
    const agent = {
      deletePost: async (uri) => deletedUris.push(uri),
    };

    await syncDeletedTweets(database, client, agent);
    assert.equal(storedPost(database, "100").missing_count, 1);
    assert.equal(storedPost(database, "101").missing_count, 1);
    assert.deepEqual(deletedUris, []);

    await syncDeletedTweets(database, client, agent);
    assert.equal(storedPost(database, "100").missing_count, 0);
    assert.equal(storedPost(database, "101").missing_count, 2);
    assert.ok(storedPost(database, "101").deleted_at);
    assert.equal(database.getPost("101"), undefined);
    assert.deepEqual(deletedUris, [
      "at://did:example:alice/app.bsky.feed.post/101",
    ]);
  } finally {
    database.close();
  }
});

test("does not mutate state when Twitter getMany throws", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    addPost(database, "200");
    database.incrementMissingCount("200");
    const before = storedPost(database, "200");
    const warnings = [];
    const client = {
      tweets: {
        getMany: async () => {
          throw new Error("temporary outage");
        },
      },
    };
    const agent = {
      deletePost: async () => assert.fail("deletePost should not be called"),
    };

    await syncDeletedTweets(database, client, agent, {
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(storedPost(database, "200"), before);
    assert.equal(warnings.length, 1);
  } finally {
    database.close();
  }
});

test("does not mutate state when Twitter getMany returns a non-array", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    addPost(database, "300");
    database.incrementMissingCount("300");
    const before = storedPost(database, "300");
    const warnings = [];
    const client = {
      tweets: { getMany: async () => null },
    };
    const agent = {
      deletePost: async () => assert.fail("deletePost should not be called"),
    };

    await syncDeletedTweets(database, client, agent, {
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(storedPost(database, "300"), before);
    assert.equal(warnings.length, 1);
  } finally {
    database.close();
  }
});

test("dry run logs transitions without deleting or mutating state", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    addPost(database, "400");
    addPost(database, "401");
    database.incrementMissingCount("401");
    const before400 = storedPost(database, "400");
    const before401 = storedPost(database, "401");
    const logs = [];
    let deleteCalls = 0;
    const client = {
      tweets: { getMany: async () => [] },
    };
    const agent = {
      deletePost: async () => {
        deleteCalls += 1;
      },
    };

    await syncDeletedTweets(database, client, agent, {
      dryRun: true,
      logger: (message) => logs.push(message),
    });
    assert.equal(deleteCalls, 0);
    assert.deepEqual(storedPost(database, "400"), before400);
    assert.deepEqual(storedPost(database, "401"), before401);
    assert.equal(logs.length, 2);
  } finally {
    database.close();
  }
});

test("tombstones a missing tweet even when Bluesky deletion throws", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    addPost(database, "500");
    database.incrementMissingCount("500");
    const errors = [];
    const logs = [];
    const client = {
      tweets: { getMany: async () => [] },
    };
    const agent = {
      deletePost: async () => {
        throw new Error("post already missing");
      },
    };

    await syncDeletedTweets(database, client, agent, {
      logger: (message) => logs.push(message),
      errorLogger: (message) => errors.push(message),
    });
    assert.ok(storedPost(database, "500").deleted_at);
    assert.equal(errors.length, 1);
    assert.deepEqual(logs, [
      "[tweet 500] deleted on twitter; removed bluesky post",
    ]);
  } finally {
    database.close();
  }
});
