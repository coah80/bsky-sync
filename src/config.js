import dotenv from "dotenv";
import { DEFAULT_BADGE_SERVER_URL } from "./badge.js";

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

  const badgeEnabled = !["off", "false", "0", "no"].includes(
    (env.SYNC_BADGE ?? "").trim().toLowerCase(),
  );
  let badgeServerUrl;
  try {
    badgeServerUrl = new URL(
      env.BADGE_SERVER_URL?.trim() || DEFAULT_BADGE_SERVER_URL,
    ).toString();
  } catch {
    throw new Error("BADGE_SERVER_URL must be a valid URL");
  }

  return {
    twitterAuthToken: env.TWITTER_AUTH_TOKEN.trim(),
    twitterUsername: env.TWITTER_USERNAME.trim().replace(/^@/, ""),
    bskyHandle: env.BSKY_HANDLE.trim(),
    bskyAppPassword: env.BSKY_APP_PASSWORD.trim(),
    bskyService,
    pollIntervalSeconds,
    badgeEnabled,
    badgeServerUrl,
  };
}

