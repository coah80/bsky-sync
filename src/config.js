import dotenv from "dotenv";

const requiredKeys = [
  "TWITTER_AUTH_TOKEN",
  "TWITTER_USERNAME",
  "BSKY_HANDLE",
  "BSKY_APP_PASSWORD",
];

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

  const pollIntervalSeconds = Number(env.POLL_INTERVAL_SECONDS ?? 180);
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new Error("POLL_INTERVAL_SECONDS must be a positive number");
  }

  let bskyService;
  try {
    bskyService = new URL(env.BSKY_SERVICE?.trim() || "https://bsky.social").toString();
  } catch {
    throw new Error("BSKY_SERVICE must be a valid URL");
  }

  return {
    twitterAuthToken: env.TWITTER_AUTH_TOKEN.trim(),
    twitterUsername: env.TWITTER_USERNAME.trim().replace(/^@/, ""),
    bskyHandle: env.BSKY_HANDLE.trim(),
    bskyAppPassword: env.BSKY_APP_PASSWORD.trim(),
    bskyService,
    pollIntervalSeconds,
  };
}

