import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerSyncBadge } from "./badge.js";
import { loginBluesky, publishTweet } from "./bsky.js";
import { loadConfig } from "./config.js";
import { SyncDatabase } from "./db.js";
import { syncDeletedTweets } from "./deletions.js";
import { createHealthMonitor } from "./health.js";
import { sendToast } from "./notify.js";
import { syncProfile } from "./profile.js";
import {
  closeRenderer,
  renderQuoteCard,
  renderQuoteCardWithVideoSlot,
} from "./screenshot.js";
import {
  classifyTweet,
  fetchNewTweetsSince,
  fetchTimelinePage,
  loginTwitter,
  newestTweetId,
  resolveOwnUser,
} from "./twitter.js";
import { composeQuoteVideo, ffmpegAvailable } from "./video-card.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function generateRenderTestClip(outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=640x360:rate=24",
        "-pix_fmt",
        "yuv420p",
        outputPath,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.slice(-500).trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

function parseFlags(argv) {
  const supported = new Set(["--once", "--dry-run", "--render-test"]);
  const unknown = argv.filter((argument) => !supported.has(argument));
  if (unknown.length > 0) {
    throw new Error(`Unknown flag${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  return {
    once: argv.includes("--once"),
    dryRun: argv.includes("--dry-run"),
    renderTest: argv.includes("--render-test"),
  };
}

async function runRenderTest() {
  const fixturePath = path.join(projectRoot, "test", "fixtures", "external-quote-images.json");
  const outputPath = path.join(projectRoot, "test", "fixtures", "quote-card-sample.png");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const png = await renderQuoteCard(fixture.quoting ?? fixture);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, png);
  const info = await stat(outputPath);
  console.log(`Rendered quote card: ${outputPath}`);
  console.log(`PNG bytes: ${info.size}`);
  if (await ffmpegAvailable()) {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "bsky-render-test-"),
    );
    try {
      const testClipPath = path.join(temporaryDirectory, "test-clip.mp4");
      const videoOutputPath = path.join(
        projectRoot,
        "test",
        "fixtures",
        "quote-card-video-sample.mp4",
      );
      await generateRenderTestClip(testClipPath);
      const testClip = await readFile(testClipPath);
      const card = await renderQuoteCardWithVideoSlot(
        fixture.quoting ?? fixture,
        { width: 16, height: 9 },
      );
      const video = await composeQuoteVideo(card.png, testClip, card.slot);
      await mkdir(path.dirname(videoOutputPath), { recursive: true });
      await writeFile(videoOutputPath, video);
      const videoInfo = await stat(videoOutputPath);
      console.log(`Rendered quote card video: ${videoOutputPath}`);
      console.log(`MP4 bytes: ${videoInfo.size}`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  } else {
    console.log("render test: ffmpeg not available, skipping video card sample");
  }
  await closeRenderer();
}

function advance(database, tweetId, dryRun, allowed) {
  if (!dryRun && allowed) {
    database.setMeta("last_seen_tweet_id", tweetId);
  }
}

async function runDeletionPass(context) {
  await syncDeletedTweets(context.database, context.twitter, context.bluesky, {
    dryRun: context.flags.dryRun,
    logger: console.log,
    warn: console.warn,
    errorLogger: console.error,
  });
}

async function runProfilePass(context) {
  await syncProfile(
    context.database,
    context.twitter,
    context.bluesky,
    context.ownUserId,
    {
      dryRun: context.flags.dryRun,
      logger: console.log,
      errorLogger: console.error,
    },
  );
}

async function runPoll(context) {
  const lastSeen = context.database.getMeta("last_seen_tweet_id");
  if (!lastSeen) {
    const newestPage = await fetchTimelinePage(context.twitter, context.ownUserId, 40);
    const baseline = newestTweetId(newestPage);
    if (baseline === null) {
      console.error("first poll returned no tweets; baseline not set, will retry next poll");
      await runDeletionPass(context);
      await runProfilePass(context);
      return;
    }
    if (context.flags.dryRun) {
      console.log(`[tweet ${baseline}] dry run baseline would be set; no posts mirrored`);
    } else {
      context.database.setMeta("last_seen_tweet_id", baseline);
      console.log(`[tweet ${baseline}] baseline set; no posts mirrored`);
    }
    await runDeletionPass(context);
    await runProfilePass(context);
    return;
  }

  const tweets = await fetchNewTweetsSince(
    context.twitter,
    context.ownUserId,
    lastSeen,
  );
  if (tweets.length === 0) {
    console.log(`[tweet ${lastSeen}] poll complete; no new tweets`);
    await runDeletionPass(context);
    await runProfilePass(context);
    return;
  }

  let postedThisPoll = 0;
  let watermarkAllowed = true;
  for (const tweet of tweets) {
    if (postedThisPoll >= 20) {
      console.log(`[tweet ${tweet.id}] poll post cap reached; remaining tweets deferred`);
      break;
    }

    const existing = context.database.getPost(tweet.id);
    if (existing) {
      console.log(`[tweet ${tweet.id}] already mirrored; advancing checkpoint`);
      advance(context.database, tweet.id, context.flags.dryRun, watermarkAllowed);
      continue;
    }

    const previousFailure = context.database.getFailure(tweet.id);
    if (previousFailure?.gave_up) {
      console.error(`[tweet ${tweet.id}] previously gave up; advancing checkpoint`);
      advance(context.database, tweet.id, context.flags.dryRun, watermarkAllowed);
      continue;
    }

    const classification = classifyTweet(
      tweet,
      context.ownUserId,
      context.database,
    );
    if (classification.kind === "skip") {
      console.log(`[tweet ${tweet.id}] skipped: ${classification.reason}`);
      advance(context.database, tweet.id, context.flags.dryRun, watermarkAllowed);
      continue;
    }

    if (postedThisPoll > 0) {
      await sleep(1500);
    }
    postedThisPoll += 1;
    try {
      const result = await publishTweet(
        context.bluesky,
        tweet,
        classification,
        context.ownUserId,
        context.database,
        { dryRun: context.flags.dryRun, logger: console.log },
      );
      if (!context.flags.dryRun) {
        context.database.setPost(tweet.id, result);
        context.database.clearFailure(tweet.id);
        advance(context.database, tweet.id, false, watermarkAllowed);
        console.log(`[tweet ${tweet.id}] mirrored to ${result.uri}`);
      }
    } catch (error) {
      console.error(`[tweet ${tweet.id}] mirror failed: ${error.message}`);
      if (context.flags.dryRun) {
        watermarkAllowed = false;
        continue;
      }
      const failure = context.database.recordFailure(tweet.id, error.message);
      if (failure.attempts >= 3) {
        context.database.markGaveUp(tweet.id);
        console.error(`[tweet ${tweet.id}] GAVE UP after ${failure.attempts} attempts`);
        advance(context.database, tweet.id, false, watermarkAllowed);
      } else {
        watermarkAllowed = false;
        console.error(`[tweet ${tweet.id}] will retry; attempt ${failure.attempts} of 3`);
      }
    }
  }
  await runDeletionPass(context);
  await runProfilePass(context);
}

async function start() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.renderTest) {
    await runRenderTest();
    return;
  }

  const config = loadConfig();
  const database = new SyncDatabase();
  const health = createHealthMonitor(database, { toastSender: sendToast });
  const runStartupStep = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      health.alertStartupFailure(error);
      throw error;
    }
  };
  try {
    const twitter = await runStartupStep(() =>
      loginTwitter(config.twitterAuthToken),
    );
    let ownUserId = database.getMeta("own_user_id");
    if (!ownUserId) {
      const user = await runStartupStep(() =>
        resolveOwnUser(twitter, config.twitterUsername),
      );
      ownUserId = String(user.id);
      database.setMeta("own_user_id", ownUserId);
    }
    const bluesky = await runStartupStep(() => loginBluesky(config));
    await registerSyncBadge(bluesky, database, {
      enabled: config.badgeEnabled,
      badgeServerUrl: config.badgeServerUrl,
      dryRun: flags.dryRun,
    });
    const context = { flags, config, database, twitter, bluesky, ownUserId };

    if (flags.once) {
      await runPoll(context);
      return;
    }
    while (true) {
      try {
        await runPoll(context);
        health.recordSuccess();
      } catch (error) {
        console.error(`[tweet n/a] poll failed: ${error.message}`);
        health.recordFailure(error);
      }
      await sleep(config.pollIntervalSeconds * 1000);
    }
  } finally {
    await closeRenderer();
    database.close();
  }
}

// emusks pulls in cycletls, which spawns a go child process that keeps the
// event loop alive forever, its cleanup only runs on process "exit" so we
// have to force the exit ourselves once the one-shot work is done
const forceExit =
  process.argv.includes("--once") || process.argv.includes("--render-test");

start()
  .catch((error) => {
    console.error(`Configuration/startup error:\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (forceExit) {
      process.exit(process.exitCode ?? 0);
    }
  });
