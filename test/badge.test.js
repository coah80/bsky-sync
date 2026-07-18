import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INFO_NSID,
  REGISTER_NSID,
  registerSyncBadge,
} from "../src/badge.js";

const silent = () => {};

function fakeDatabase(initial = {}) {
  const meta = new Map(Object.entries(initial));
  return {
    meta,
    getMeta: (key) => meta.get(key) ?? null,
    setMeta: (key, value) => {
      meta.set(key, String(value));
    },
  };
}

function fakeAgent(did = "did:plc:user123") {
  const calls = [];
  return {
    calls,
    session: { did },
    com: {
      atproto: {
        server: {
          getServiceAuth: async (params) => {
            calls.push(params);
            return { data: { token: "service-auth-token" } };
          },
        },
      },
    },
  };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function workingServer() {
  return fakeFetch((url, options) => {
    if (url.includes(INFO_NSID)) {
      return jsonResponse({ did: "did:plc:labeler456" });
    }
    if (url.includes(REGISTER_NSID) && options.method === "POST") {
      return jsonResponse({ status: "labeled" });
    }
    return jsonResponse({ error: "MethodNotImplemented" }, 501);
  });
}

test("registers, records the did, and sends service auth", async () => {
  const database = fakeDatabase();
  const agent = fakeAgent();
  const fetchImpl = workingServer();

  const result = await registerSyncBadge(agent, database, {
    fetchImpl,
    logger: silent,
    warn: silent,
  });

  assert.equal(result.status, "registered");
  assert.equal(database.getMeta("badge_registered_did"), "did:plc:user123");
  assert.deepEqual(agent.calls, [
    { aud: "did:plc:labeler456", lxm: REGISTER_NSID },
  ]);
  const register = fetchImpl.calls.find((call) => call.options.method === "POST");
  assert.equal(
    register.options.headers.authorization,
    "Bearer service-auth-token",
  );
});

test("skips without network calls when disabled", async () => {
  const database = fakeDatabase();
  const fetchImpl = workingServer();

  const result = await registerSyncBadge(fakeAgent(), database, {
    enabled: false,
    fetchImpl,
    logger: silent,
    warn: silent,
  });

  assert.equal(result.status, "disabled");
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(database.getMeta("badge_registered_did"), null);
});

test("skips without network calls in dry run", async () => {
  const fetchImpl = workingServer();

  const result = await registerSyncBadge(fakeAgent(), fakeDatabase(), {
    dryRun: true,
    fetchImpl,
    logger: silent,
    warn: silent,
  });

  assert.equal(result.status, "skipped");
  assert.equal(fetchImpl.calls.length, 0);
});

test("skips when this did already registered", async () => {
  const database = fakeDatabase({ badge_registered_did: "did:plc:user123" });
  const fetchImpl = workingServer();

  const result = await registerSyncBadge(fakeAgent(), database, {
    fetchImpl,
    logger: silent,
    warn: silent,
  });

  assert.equal(result.status, "already-registered");
  assert.equal(fetchImpl.calls.length, 0);
});

test("re-registers when the account changed", async () => {
  const database = fakeDatabase({ badge_registered_did: "did:plc:someoneelse" });

  const result = await registerSyncBadge(fakeAgent(), database, {
    fetchImpl: workingServer(),
    logger: silent,
    warn: silent,
  });

  assert.equal(result.status, "registered");
  assert.equal(database.getMeta("badge_registered_did"), "did:plc:user123");
});

test("does not throw when the server is unreachable", async () => {
  const database = fakeDatabase();
  const fetchImpl = fakeFetch(() => {
    throw new Error("fetch failed");
  });

  const result = await registerSyncBadge(fakeAgent(), database, {
    fetchImpl,
    logger: silent,
    warn: silent,
  });

  assert.equal(result.status, "failed");
  assert.equal(database.getMeta("badge_registered_did"), null);
});

test("does not record registration on a server error response", async () => {
  const database = fakeDatabase();
  const fetchImpl = fakeFetch((url, options) => {
    if (options.method === "POST") {
      return jsonResponse({ error: "InternalError" }, 500);
    }
    return jsonResponse({ did: "did:plc:labeler456" });
  });

  const result = await registerSyncBadge(fakeAgent(), database, {
    fetchImpl,
    logger: silent,
    warn: silent,
  });

  assert.equal(result.status, "failed");
  assert.equal(database.getMeta("badge_registered_did"), null);
});

test("rejects a bogus labeler info response", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ did: "not-a-did" }));

  const result = await registerSyncBadge(fakeAgent(), fakeDatabase(), {
    fetchImpl,
    logger: silent,
    warn: silent,
  });

  assert.equal(result.status, "failed");
  assert.match(result.reason, /valid did/);
});
