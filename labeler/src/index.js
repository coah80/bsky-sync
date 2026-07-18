import { mkdir } from "node:fs/promises";
import path from "node:path";
import { LabelerServer } from "@skyware/labeler";
import { attachBadgeRoutes } from "./badge-routes.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
await mkdir(path.dirname(path.resolve(config.dbPath)), { recursive: true });

const server = new LabelerServer({
  did: config.did,
  signingKey: config.signingKey,
  dbPath: config.dbPath,
});

server.start({ port: config.port, host: "0.0.0.0" }, (error, address) => {
  if (error) {
    console.error(`Failed to start labeler: ${error.message}`);
    process.exit(1);
  }
  try {
    attachBadgeRoutes(server);
  } catch (attachError) {
    console.error(`Failed to attach badge routes: ${attachError.message}`);
    process.exit(1);
  }
  console.log(`bsky-sync labeler listening on ${address}`);
});
