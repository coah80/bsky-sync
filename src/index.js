import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loginBluesky, publishTweet } from "./bsky.js";
import { loadConfig } from "./config.js";
import { SyncDatabase } from "./db.js";
import { syncDeletedTweets } from "./deletions.js";
import { createHealthMonitor } from "./health.js";
import { sendToast } from "./notify.js";
import { syncProfile } from "./profile.js";
import { closeRenderer, renderQuoteCard } from "./screenshot.js";
import {
  classifyTweet,
  fetchNewTweetsSince,
  fetchTimelinePage,
  loginTwitter,
  newestTweetId,
  resolveOwnUser,
} from "./twitter.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
