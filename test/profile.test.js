import assert from "node:assert/strict";
import test from "node:test";
import { SyncDatabase } from "../src/db.js";
import { syncProfile } from "../src/profile.js";

const pngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function user(overrides = {}) {
  return {
    profile_picture: { url: "https://example.com/avatar_normal.jpg" },
    banner: "https://example.com/banner.jpg",
    description: "current bio",
    name: "Example User",
    pinned_tweets: [],
    ...overrides,
  };
}

function state(value) {
  return JSON.stringify({
    avatar: value.profile_picture.url,
    banner: value.banner,
    bio: value.description,
    name: value.name,
    pinned: String(value.pinned_tweets?.[0] ?? ""),
  });
}

test("does nothing when the fetched profile state is unchanged", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const currentUser = user();
    database.setMeta("profile_state", state(currentUser));
    const originalSetMeta = database.setMeta.bind(database);
    let metaWrites = 0;
    database.setMeta = (...args) => {
      metaWrites += 1;
      return originalSetMeta(...args);
    };
    let uploadCalls = 0;
    let upsertCalls = 0;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      uploadBlob: async () => {
        uploadCalls += 1;
      },
      upsertProfile: async () => {
        upsertCalls += 1;
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.equal(uploadCalls, 0);
    assert.equal(upsertCalls, 0);
    assert.equal(metaWrites, 0);
    assert.equal(database.getMeta("profile_state"), state(currentUser));
  } finally {
    database.close();
  }
});

test("updates only the description for a bio-only change", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const currentUser = user({ description: "new bio" });
    database.setMeta(
      "profile_state",
      state(user({ description: "old bio" })),
    );
    const avatar = { ref: "existing-avatar" };
    const banner = { ref: "existing-banner" };
    let uploadCalls = 0;
    let payload;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      uploadBlob: async () => {
        uploadCalls += 1;
      },
      upsertProfile: async (updater) => {
        payload = updater({ avatar, banner, pinnedPost: { uri: "at://post" } });
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.equal(uploadCalls, 0);
    assert.equal(payload.description, "new bio");
    assert.equal(payload.avatar, avatar);
    assert.equal(payload.banner, banner);
    assert.deepEqual(payload.pinnedPost, { uri: "at://post" });
    assert.equal("displayName" in payload, false);
    assert.equal(database.getMeta("profile_state"), state(currentUser));
  } finally {
    database.close();
  }
});

test("does not save profile state when upsert fails after image uploads", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const previousState = state(user());
    database.setMeta("profile_state", previousState);
    const currentUser = user({
      profile_picture: { url: pngDataUrl },
      banner: pngDataUrl,
    });
    let uploadCalls = 0;
    let payload;
    const errors = [];
    const client = { users: { get: async () => currentUser } };
    const agent = {
      uploadBlob: async () => {
        uploadCalls += 1;
        return { data: { blob: { ref: `blob-${uploadCalls}` } } };
      },
      upsertProfile: async (updater) => {
        payload = updater({ pinnedPost: { uri: "at://post" } });
        throw new Error("upsert unavailable");
      },
    };

    await syncProfile(database, client, agent, "1", {
      errorLogger: (message) => errors.push(message),
    });

    assert.equal(uploadCalls, 2);
    assert.equal("displayName" in payload, false);
    assert.equal(database.getMeta("profile_state"), previousState);
    assert.deepEqual(errors, ["[profile] sync failed: upsert unavailable"]);
  } finally {
    database.close();
  }
});

test("dry run logs changed parts without uploads, upserts, or meta writes", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const previousState = state(user());
    database.setMeta("profile_state", previousState);
    const currentUser = user({
      profile_picture: { url: "https://example.com/new_normal.jpg" },
      description: "new bio",
    });
    const originalSetMeta = database.setMeta.bind(database);
    let metaWrites = 0;
    database.setMeta = (...args) => {
      metaWrites += 1;
      return originalSetMeta(...args);
    };
    let uploadCalls = 0;
    let upsertCalls = 0;
    const logs = [];
    const client = { users: { get: async () => currentUser } };
    const agent = {
      uploadBlob: async () => {
        uploadCalls += 1;
      },
      upsertProfile: async () => {
        upsertCalls += 1;
      },
    };

    await syncProfile(database, client, agent, "1", {
      dryRun: true,
      logger: (message) => logs.push(message),
    });

    assert.equal(uploadCalls, 0);
    assert.equal(upsertCalls, 0);
    assert.equal(metaWrites, 0);
    assert.equal(database.getMeta("profile_state"), previousState);
    assert.deepEqual(logs, ["[profile] dry run would update: avatar, bio"]);
  } finally {
    database.close();
  }
});

test("falls back to the original avatar URL when the full-size download fails", async () => {
  const database = new SyncDatabase(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    const currentUser = user();
    database.setMeta(
      "profile_state",
      state(user({ profile_picture: { url: "https://example.com/old.jpg" } })),
    );
    const fetchedUrls = [];
    const png = Buffer.from(pngDataUrl.split(",")[1], "base64");
    globalThis.fetch = async (url) => {
      fetchedUrls.push(String(url));
      if (fetchedUrls.length === 1) {
        return new Response("not found", { status: 404 });
      }
      return new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    };
    let payload;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      uploadBlob: async () => ({ data: { blob: { ref: "new-avatar" } } }),
      upsertProfile: async (updater) => {
        payload = updater({ banner: { ref: "existing-banner" } });
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.deepEqual(fetchedUrls, [
      "https://example.com/avatar_400x400.jpg",
      "https://example.com/avatar_normal.jpg",
    ]);
    assert.deepEqual(payload.avatar, { ref: "new-avatar" });
    assert.equal("displayName" in payload, false);
    assert.equal(database.getMeta("profile_state"), state(currentUser));
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("sets pinnedPost when the pinned tweet has a live mapping", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const previousUser = user();
    const currentUser = user({ pinned_tweets: ["42"] });
    database.setMeta("profile_state", state(previousUser));
    database.setPost("42", {
      uri: "at://post/42",
      cid: "cid-42",
      rootUri: "at://post/42",
      rootCid: "cid-42",
    });
    let payload;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      upsertProfile: async (updater) => {
        payload = updater({ description: "current bio" });
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.deepEqual(payload.pinnedPost, {
      uri: "at://post/42",
      cid: "cid-42",
    });
    assert.equal("displayName" in payload, false);
    assert.equal(database.getMeta("profile_state"), state(currentUser));
  } finally {
    database.close();
  }
});

test("removes pinnedPost when Twitter becomes unpinned", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const previousUser = user({ pinned_tweets: ["42"] });
    const currentUser = user();
    database.setMeta("profile_state", state(previousUser));
    let payload;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      upsertProfile: async (updater) => {
        payload = updater({
          description: "current bio",
          pinnedPost: { uri: "at://post/42", cid: "cid-42" },
        });
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.equal("pinnedPost" in payload, false);
    assert.equal("displayName" in payload, false);
    assert.equal(database.getMeta("profile_state"), state(currentUser));
  } finally {
    database.close();
  }
});

test("defers an unmapped pin while saving unrelated profile changes", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const previousUser = user();
    const currentUser = user({
      description: "new bio",
      pinned_tweets: ["404"],
    });
    database.setMeta("profile_state", state(previousUser));
    let payload;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      upsertProfile: async (updater) => {
        payload = updater({
          pinnedPost: { uri: "at://post/existing", cid: "cid-existing" },
        });
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.deepEqual(payload.pinnedPost, {
      uri: "at://post/existing",
      cid: "cid-existing",
    });
    assert.equal("displayName" in payload, false);
    assert.equal(
      database.getMeta("profile_state"),
      state(user({ description: "new bio" })),
    );
  } finally {
    database.close();
  }
});

test("does not upsert or persist a tombstoned pin", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const previousUser = user();
    const currentUser = user({ pinned_tweets: ["77"] });
    const previousState = state(previousUser);
    database.setMeta("profile_state", previousState);
    database.setPost("77", {
      uri: "at://post/77",
      cid: "cid-77",
      rootUri: "at://post/77",
      rootCid: "cid-77",
    });
    database.markDeleted("77");
    let upsertCalls = 0;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      upsertProfile: async () => {
        upsertCalls += 1;
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.equal(upsertCalls, 0);
    assert.equal(database.getMeta("profile_state"), previousState);
  } finally {
    database.close();
  }
});

test("sets displayName when only the name changes", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const currentUser = user();
    database.setMeta("profile_state", state(user({ name: "old name" })));
    const avatar = { ref: "existing-avatar" };
    const banner = { ref: "existing-banner" };
    let uploadCalls = 0;
    let payload;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      uploadBlob: async () => {
        uploadCalls += 1;
      },
      upsertProfile: async (updater) => {
        payload = updater({ avatar, banner });
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.equal(payload.displayName, "Example User");
    assert.equal(uploadCalls, 0);
    assert.equal(payload.avatar, avatar);
    assert.equal(payload.banner, banner);
    assert.equal(database.getMeta("profile_state"), state(currentUser));
  } finally {
    database.close();
  }
});

test("removes displayName when the twitter name becomes empty", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const currentUser = user({ name: "" });
    database.setMeta("profile_state", state(user()));
    let payload;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      upsertProfile: async (updater) => {
        payload = updater({ displayName: "Example User" });
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.equal("displayName" in payload, false);
    assert.equal(database.getMeta("profile_state"), state(currentUser));
  } finally {
    database.close();
  }
});

test("truncates a display name longer than 64 graphemes", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const currentUser = user({ name: "a".repeat(70) });
    database.setMeta("profile_state", state(user({ name: "old name" })));
    let payload;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      upsertProfile: async (updater) => {
        payload = updater({});
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.equal(Array.from(payload.displayName).length, 64);
    assert.equal(payload.displayName.endsWith("…"), true);
    assert.equal(database.getMeta("profile_state"), state(currentUser));
  } finally {
    database.close();
  }
});

test("pushes displayName once when stored state predates name sync", async () => {
  const database = new SyncDatabase(":memory:");
  try {
    const currentUser = user({ name: "Example User" });
    database.setMeta(
      "profile_state",
      JSON.stringify({
        avatar: "https://example.com/avatar_normal.jpg",
        banner: "https://example.com/banner.jpg",
        bio: "current bio",
        pinned: "",
      }),
    );
    let payload;
    const client = { users: { get: async () => currentUser } };
    const agent = {
      upsertProfile: async (updater) => {
        payload = updater({});
      },
    };

    await syncProfile(database, client, agent, "1");

    assert.equal(payload.displayName, "Example User");
    assert.equal(database.getMeta("profile_state"), state(currentUser));
  } finally {
    database.close();
  }
});
