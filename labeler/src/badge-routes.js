// registration endpoints on top of the skyware labeler. the register route
// authenticates callers with an atproto service auth JWT (aud = this labeler,
// lxm = the register NSID, signature checked against the caller's did), so the
// only account that can get a did labeled is the account itself.
//
// skyware's LabelerServer kicks off the fastify boot inside its constructor,
// which locks fastify against new routes, so these are plain handlers wired
// onto the raw node http server: badge paths are answered here, everything
// else is handed to fastify's own request listeners untouched.
//
// NSIDs must stay in sync with src/badge.js in the main repo.

export const BADGE_LABEL = "bsky-sync";
export const REGISTER_NSID = "com.coah80.bskysync.registerBadge";
export const INFO_NSID = "com.coah80.bskysync.getLabelerInfo";

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;

function createRateLimiter() {
  const requestLog = new Map();
  return (ip) => {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    const recent = (requestLog.get(ip) ?? []).filter((time) => time > cutoff);
    if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
      requestLog.set(ip, recent);
      return false;
    }
    requestLog.set(ip, [...recent, now]);
    if (requestLog.size > 10_000) {
      requestLog.clear();
    }
    return true;
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function hasActiveLabel(server, did) {
  const result = await server.db.execute({
    sql: "SELECT neg FROM labels WHERE uri = ? AND val = ? ORDER BY id DESC LIMIT 1",
    args: [did, BADGE_LABEL],
  });
  const latest = result.rows[0];
  return latest !== undefined && !latest.neg;
}

async function handleRegister(server, request, response, { logger, allowRequest }) {
  if (request.method !== "POST") {
    return sendJson(response, 405, {
      error: "MethodNotAllowed",
      message: "Use POST",
    });
  }
  if (!allowRequest(request.socket.remoteAddress ?? "unknown")) {
    return sendJson(response, 429, {
      error: "RateLimitExceeded",
      message: "Too many requests, try again later",
    });
  }

  let did;
  try {
    did = await server.parseAuthHeaderDid(request);
  } catch (error) {
    logger(`[register] rejected request: ${error.message}`);
    return sendJson(response, 401, {
      error: "AuthRequired",
      message: "Valid service auth token required",
    });
  }

  try {
    if (await hasActiveLabel(server, did)) {
      return sendJson(response, 200, { did, label: BADGE_LABEL, status: "already-labeled" });
    }
    await server.createLabel({ uri: did, val: BADGE_LABEL });
    logger(`[register] labeled ${did}`);
    return sendJson(response, 200, { did, label: BADGE_LABEL, status: "labeled" });
  } catch (error) {
    console.error(`[register] failed to label ${did}: ${error.message}`);
    return sendJson(response, 500, {
      error: "InternalError",
      message: "Failed to apply label",
    });
  }
}

export function attachBadgeRoutes(server, options = {}) {
  const logger = options.logger ?? console.log;
  if (typeof server.parseAuthHeaderDid !== "function") {
    throw new Error(
      "@skyware/labeler no longer exposes parseAuthHeaderDid; keep it pinned to 0.2.x or update badge-routes.js",
    );
  }
  const raw = server.app.server;
  const fastifyListeners = raw.listeners("request");
  if (fastifyListeners.length === 0) {
    throw new Error(
      "no request listeners found on the labeler's http server; cannot attach badge routes",
    );
  }
  raw.removeAllListeners("request");

  const allowRequest = createRateLimiter();
  raw.on("request", (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    // lets the labeler account use this domain as its handle without a DNS TXT record
    if (pathname === "/.well-known/atproto-did") {
      response.writeHead(200, { "content-type": "text/plain" });
      return response.end(server.did);
    }
    if (pathname === `/xrpc/${INFO_NSID}`) {
      return sendJson(response, 200, { did: server.did });
    }
    if (pathname === `/xrpc/${REGISTER_NSID}`) {
      handleRegister(server, request, response, { logger, allowRequest }).catch((error) => {
        console.error(`[register] unexpected error: ${error.message}`);
        if (!response.headersSent) {
          sendJson(response, 500, { error: "InternalError", message: "Unexpected error" });
        }
      });
      return;
    }
    for (const listener of fastifyListeners) {
      listener.call(raw, request, response);
    }
  });
}
