function asId(value) {
  return value === null || value === undefined ? null : String(value);
}

function mappedTweet(mappingSource, tweetId) {
  if (!tweetId || !mappingSource) {
    return null;
  }
  if (typeof mappingSource === "function") {
    return mappingSource(String(tweetId));
  }
  if (typeof mappingSource.getPost === "function") {
    return mappingSource.getPost(String(tweetId));
  }
  if (typeof mappingSource.has === "function") {
    return mappingSource.has(String(tweetId)) ? { tweet_id: String(tweetId) } : null;
  }
  return null;
}

export async function loginTwitter(authToken) {
  const { default: Emusks } = await import("emusks");
  const client = new Emusks();
  await client.login(authToken);
  return client;
}

export async function resolveOwnUser(client, username) {
  const user = await client.users.getByUsername(username);
  if (!user?.id) {
    throw new Error(`Twitter user @${username} did not resolve to an id`);
  }
  return user;
}

export async function fetchTimelinePage(client, ownUserId, count = 40) {
  const page = await client.users.tweets(String(ownUserId), { count });
  return Array.isArray(page?.tweets) ? page.tweets : [];
}

export async function fetchNewTweetsSince(client, ownUserId, lastSeenId) {
  const tweets = await fetchTimelinePage(client, ownUserId, 40);
  const lastSeen = BigInt(lastSeenId);
  return tweets
    .filter((tweet) => {
      try {
        return tweet?.id && BigInt(tweet.id) > lastSeen;
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      const a = BigInt(left.id);
      const b = BigInt(right.id);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

export function newestTweetId(tweets) {
  let newest = null;
  for (const tweet of tweets) {
    try {
      const id = BigInt(tweet.id);
      if (newest === null || id > newest) {
        newest = id;
      }
    } catch {
      continue;
    }
  }
  return newest?.toString() ?? null;
}

export function classifyTweet(tweet, ownUserId, mappingSource) {
  const ownId = asId(ownUserId);
  const authorId = asId(tweet?.user?.id);
  const replyUserId = asId(tweet?.in_reply_to_user_id);
  const hasReply = Boolean(tweet?.in_reply_to_status_id);
  const isRetweet =
    Boolean(tweet?.retweeted_status || tweet?.retweetedStatus) ||
    (authorId !== null && authorId !== ownId) ||
    /^RT\s+@/i.test(tweet?.text ?? "");

  if (isRetweet) {
    return { kind: "skip", reason: "retweet" };
  }
  if (hasReply && replyUserId !== ownId) {
    return { kind: "skip", reason: "reply_to_other" };
  }
  if (hasReply && replyUserId === ownId) {
    return { kind: "self_reply" };
  }
  if (tweet?.quoting) {
    const quotedId = asId(tweet.quoting.id);
    const quotedAuthorId = asId(tweet.quoting.user?.id);
    const post = quotedAuthorId === ownId ? mappedTweet(mappingSource, quotedId) : null;
    if (quotedId && post) {
      return { kind: "self_quote", quotedPost: post };
    }
    return { kind: "external_quote" };
  }
  return { kind: "original" };
}
