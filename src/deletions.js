export async function syncDeletedTweets(
  database,
  client,
  agent,
  options = {},
) {
  const dryRun = options.dryRun ?? false;
  const logger = options.logger ?? console.log;
  const warn = options.warn ?? console.warn;
  const errorLogger = options.errorLogger ?? console.error;
  const posts = database.getRecentLivePosts(50);
  if (posts.length === 0) {
    return;
  }

  const ids = posts.map((post) => String(post.tweet_id));
  let tweets;
  try {
    tweets = await client.tweets.getMany(ids);
  } catch (error) {
    warn(`[tweet n/a] deletion check skipped: ${error.message}`);
    return;
  }
  if (!Array.isArray(tweets)) {
    warn("[tweet n/a] deletion check skipped: Twitter getMany returned a non-array result");
    return;
  }

  const presentIds = new Set(
    tweets
      .filter((tweet) => tweet?.id !== null && tweet?.id !== undefined)
      .map((tweet) => String(tweet.id)),
  );

  for (const post of posts) {
    const id = String(post.tweet_id);
    if (presentIds.has(id)) {
      if (post.missing_count !== 0) {
        if (dryRun) {
          logger(
            `[tweet ${id}] dry run would reset missing count from ${post.missing_count} to 0`,
          );
        } else {
          database.resetMissingCount(id);
        }
      }
      continue;
    }

    const nextMissingCount = post.missing_count + 1;
    if (dryRun) {
      if (nextMissingCount >= 2) {
        logger(
          `[tweet ${id}] dry run would delete Bluesky post ${post.bsky_uri} after missing count reached ${nextMissingCount}`,
        );
      } else {
        logger(
          `[tweet ${id}] dry run would increment missing count from ${post.missing_count} to ${nextMissingCount}`,
        );
      }
      continue;
    }

    const missingCount = database.incrementMissingCount(id);
    if (missingCount === null || missingCount < 2) {
      continue;
    }

    try {
      await agent.deletePost(post.bsky_uri);
    } catch (error) {
      errorLogger(`[tweet ${id}] bluesky deletion failed: ${error.message}`);
    }
    database.markDeleted(id);
    logger(`[tweet ${id}] deleted on twitter; removed bluesky post`);
  }
}
