import dotenv from "dotenv";

const requiredKeys = ["LABELER_DID", "SIGNING_KEY"];

export function loadConfig(env = process.env) {
  if (env === process.env) {
    dotenv.config({ quiet: true });
  }

  const missing = requiredKeys.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((key) => `- ${key}`).join("\n")}`,
    );
  }

  const did = env.LABELER_DID.trim();
  if (!did.startsWith("did:")) {
    throw new Error("LABELER_DID must be a did (like did:plc:...)");
  }

  const port = Number(env.PORT ?? 14831);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PORT must be a valid port number");
  }

  return {
    did,
    signingKey: env.SIGNING_KEY.trim(),
    port,
    dbPath: env.DB_PATH?.trim() || "./data/labels.db",
  };
}
