import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function defaultDatabasePath() {
  return path.join(projectRoot, "data", "sync.db");
}

export class SyncDatabase {
  constructor(filename = defaultDatabasePath()) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new Database(filename);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        tweet_id TEXT PRIMARY KEY,
        bsky_uri TEXT NOT NULL,
        bsky_cid TEXT NOT NULL,
        bsky_root_uri TEXT NOT NULL,
        bsky_root_cid TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        deleted_at TEXT,
        missing_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS failures (
        tweet_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        gave_up INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    const postColumns = new Set(
      this.database.pragma("table_info(posts)").map((column) => column.name),
    );
    if (!postColumns.has("deleted_at")) {
      this.database.exec("ALTER TABLE posts ADD COLUMN deleted_at TEXT");
    }
    if (!postColumns.has("missing_count")) {
      this.database.exec(
        "ALTER TABLE posts ADD COLUMN missing_count INTEGER NOT NULL DEFAULT 0",
      );
    }

    this.statements = {
      getPost: this.database.prepare(
        "SELECT * FROM posts WHERE tweet_id = ? AND deleted_at IS NULL",
      ),
      setPost: this.database.prepare(`
        INSERT INTO posts (
          tweet_id, bsky_uri, bsky_cid, bsky_root_uri, bsky_root_cid, synced_at
        ) VALUES (
          @tweet_id, @bsky_uri, @bsky_cid, @bsky_root_uri, @bsky_root_cid, @synced_at
        )
        ON CONFLICT(tweet_id) DO UPDATE SET
          bsky_uri = excluded.bsky_uri,
          bsky_cid = excluded.bsky_cid,
          bsky_root_uri = excluded.bsky_root_uri,
          bsky_root_cid = excluded.bsky_root_cid,
          synced_at = excluded.synced_at
      `),
      getRecentLivePosts: this.database.prepare(`
        SELECT * FROM posts
        WHERE deleted_at IS NULL
        ORDER BY CAST(tweet_id AS INTEGER) DESC
        LIMIT ?
      `),
      resetMissingCount: this.database.prepare(`
        UPDATE posts
        SET missing_count = 0
        WHERE tweet_id = ? AND deleted_at IS NULL AND missing_count != 0
      `),
      incrementMissingCount: this.database.prepare(`
        UPDATE posts
        SET missing_count = missing_count + 1
        WHERE tweet_id = ? AND deleted_at IS NULL
        RETURNING missing_count
      `),
      markDeleted: this.database.prepare(`
        UPDATE posts
        SET deleted_at = ?
        WHERE tweet_id = ? AND deleted_at IS NULL
      `),
      getMeta: this.database.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.database.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
      getFailure: this.database.prepare("SELECT * FROM failures WHERE tweet_id = ?"),
      recordFailure: this.database.prepare(`
        INSERT INTO failures (tweet_id, attempts, last_error, gave_up)
        VALUES (?, 1, ?, 0)
        ON CONFLICT(tweet_id) DO UPDATE SET
          attempts = failures.attempts + 1,
          last_error = excluded.last_error
      `),
      giveUp: this.database.prepare(
        "UPDATE failures SET gave_up = 1 WHERE tweet_id = ?",
      ),
      clearFailure: this.database.prepare("DELETE FROM failures WHERE tweet_id = ?"),
    };
  }

  getPost(tweetId) {
    return this.statements.getPost.get(String(tweetId));
  }

  setPost(tweetId, post) {
    this.statements.setPost.run({
      tweet_id: String(tweetId),
      bsky_uri: post.uri,
      bsky_cid: post.cid,
      bsky_root_uri: post.rootUri,
      bsky_root_cid: post.rootCid,
      synced_at: new Date().toISOString(),
    });
  }

  getRecentLivePosts(limit = 50) {
    return this.statements.getRecentLivePosts.all(limit);
  }

  resetMissingCount(tweetId) {
    return this.statements.resetMissingCount.run(String(tweetId)).changes;
  }

  incrementMissingCount(tweetId) {
    return this.statements.incrementMissingCount.get(String(tweetId))?.missing_count ?? null;
  }

  markDeleted(tweetId, deletedAt = new Date().toISOString()) {
    return this.statements.markDeleted.run(deletedAt, String(tweetId)).changes;
  }

  getMeta(key) {
    return this.statements.getMeta.get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.statements.setMeta.run(key, String(value));
  }

  getFailure(tweetId) {
    return this.statements.getFailure.get(String(tweetId));
  }

  recordFailure(tweetId, error) {
    this.statements.recordFailure.run(String(tweetId), String(error));
    return this.getFailure(tweetId);
  }

  markGaveUp(tweetId) {
    this.statements.giveUp.run(String(tweetId));
    return this.getFailure(tweetId);
  }

  clearFailure(tweetId) {
    this.statements.clearFailure.run(String(tweetId));
  }

  close() {
    this.database.close();
  }
}
