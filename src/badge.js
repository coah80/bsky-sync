// registers this account with the bsky-sync labeler so subscribers see a
// "synced with bsky-sync" badge on the profile. strictly best effort: any
// failure here is logged and swallowed, mirroring never depends on it.
// NSIDs must stay in sync with labeler/src/badge-routes.js.

export const DEFAULT_BADGE_SERVER_URL = "https://labeler.coah80.com";
export const REGISTER_NSID = "com.coah80.bskysync.registerBadge";
export const INFO_NSID = "com.coah80.bskysync.getLabelerInfo";

const REQUEST_TIMEOUT_MS = 10_000;

async function fetchLabelerDid(serverUrl, fetchImpl) {
  const response = await fetchImpl(new URL(`/xrpc/${INFO_NSID}`, serverUrl), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`labeler info request returned ${response.status}`);
  }
  const info = await response.json();
  if (typeof info?.did !== "string" || !info.did.startsWith("did:")) {
    throw new Error("labeler info response did not contain a valid did");
  }
  return info.did;
}

export async function registerSyncBadge(agent, database, options = {}) {
  const logger = options.logger ?? console.log;
  const warn = options.warn ?? console.warn;
  const fetchImpl = options.fetchImpl ?? fetch;
  const serverUrl = options.badgeServerUrl ?? DEFAULT_BADGE_SERVER_URL;

  if (options.enabled === false) {
    return { status: "disabled" };
  }
  if (options.dryRun) {
    logger("[badge] dry run; skipping registration");
    return { status: "skipped" };
  }
  const ownDid = agent.session?.did;
  if (!ownDid) {
    warn("[badge] no session did available; skipping registration");
    return { status: "skipped" };
  }
  if (database.getMeta("badge_registered_did") === ownDid) {
    return { status: "already-registered" };
  }

  try {
    const labelerDid = await fetchLabelerDid(serverUrl, fetchImpl);
    const auth = await agent.com.atproto.server.getServiceAuth({
      aud: labelerDid,
      lxm: REGISTER_NSID,
    });
    const response = await fetchImpl(new URL(`/xrpc/${REGISTER_NSID}`, serverUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${auth.data.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`register request returned ${response.status}`);
    }
    database.setMeta("badge_registered_did", ownDid);
    logger("[badge] registered with the bsky-sync labeler");
    return { status: "registered" };
  } catch (error) {
    warn(`[badge] registration failed, sync continues without it: ${error.message}`);
    return { status: "failed", reason: error.message };
  }
}
