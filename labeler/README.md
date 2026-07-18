# bsky-sync labeler

the little service that gives everyone running bsky-sync a `bsky-sync` badge label on their profile. you (the person hosting the badge server) run this once, everyone else's syncers phone home to it on startup.

labels on bluesky only show up for people who **subscribe to the labeler**, so the badge is visible to you + anyone who subscribes to the labeler account. thats just how atproto labelers work, no way around it.

## how registration works

on startup a syncer asks its own PDS for a service auth token addressed to this labeler (`aud` = labeler did, `lxm` = `com.coah80.bskysync.registerBadge`), and POSTs it to `/xrpc/com.coah80.bskysync.registerBadge`. the server verifies the signature against the caller's did and labels **that did only** — nobody can label anyone but themselves. if the server is down the syncer just logs a warning and carries on.

## one-time setup

1. **make a labeler account.** a fresh bluesky account, e.g. `labeler.coah80.com`. this is the account people subscribe to.

2. **pick the public URL.** the labeler needs to be reachable over HTTPS, e.g. `https://labeler.coah80.com`. point DNS at your server and reverse proxy that hostname to port 14831 (caddy/nginx/cloudflare tunnel, whatever you already use).

3. **convert the account into a labeler:**

   ```
   npx @skyware/labeler setup
   ```

   log in with the labeler account, give it the HTTPS URL from step 2, confirm with the emailed code. it prints a **signing key** — save it, that goes in `.env`.

4. **define the label:**

   ```
   npx @skyware/labeler label add
   ```

   identifier `bsky-sync` (must be exactly that, the code applies this value), name/description whatever you like ("mirrored from twitter with bsky-sync"), adult content: no, severity: inform, blurs: nothing, default setting: warn.

5. **fill `.env`:**

   ```
   cp .env.example .env
   ```

   `LABELER_DID` is the labeler account's did (visible at `https://bsky.app/profile/<handle>` → it's in the url after clicking through, or `https://api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=<handle>`). `SIGNING_KEY` is from step 3.

6. **run it:**

   ```
   docker compose up -d --build
   ```

   label state lives in `./data/labels.db` on the host. check it's alive: `https://your-url/xrpc/_health` and `https://your-url/xrpc/com.coah80.bskysync.getLabelerInfo` should both answer.

7. **point the syncers at it.** `DEFAULT_BADGE_SERVER_URL` in `../src/badge.js` must match your URL from step 2. if it doesn't, change it and commit.

8. **tell people to subscribe.** anyone who wants to *see* the badges subscribes to the labeler account from its profile page.

## unlabeling someone

from this directory, node REPL or a one-off script:

```js
import { LabelerServer } from "@skyware/labeler";
const server = new LabelerServer({ did: process.env.LABELER_DID, signingKey: process.env.SIGNING_KEY, dbPath: "./data/labels.db" });
await server.createLabel({ uri: "did:plc:whoever", val: "bsky-sync", neg: true });
```
