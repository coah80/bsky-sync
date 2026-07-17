import { BskyAgent, RichText } from "@atproto/api";
import {
  VideoTooLargeError,
  downloadAsset,
  downloadVideo,
  mediaAspectRatio,
  originalImageUrl,
  prepareImage,
} from "./media.js";
import { renderQuoteCard } from "./screenshot.js";
import {
  graphemeLength,
  prepareTweetText,
  sliceGraphemes,
  splitTextForBsky,
} from "./text.js";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function dryRunBlob(encoding, size) {
  return {
    $type: "blob",
    ref: { $link: "dry-run" },
    mimeType: encoding,
    size,
  };
}

async function uploadBlob(agent, buffer, encoding, dryRun) {
  if (dryRun) {
    return dryRunBlob(encoding, buffer.length);
  }
  const response = await agent.uploadBlob(buffer, { encoding });
  return response.data.blob;
}

function originalTweetUrl(tweet) {
  const username = tweet?.user?.username ?? "i";
  return `https://x.com/${username}/status/${tweet.id}`;
}

function appendRequiredLink(text, url) {
  return text ? `${text}\n\n${url}` : url;
}

function appendQuoteAttribution(text, quotedTweet) {
  const handle = quotedTweet?.user?.username ?? "unknown";
  const prefix = `\n\n💬 @${handle}:`;
  if (graphemeLength(text) + graphemeLength(prefix) > 300) {
    return text;
  }
  const quotedText = prepareTweetText(quotedTweet);
  if (!quotedText) {
    return `${text}${prefix}`;
  }
  const withSpace = `${prefix} `;
  const available = 300 - graphemeLength(text) - graphemeLength(withSpace);
  if (available <= 0) {
    return `${text}${prefix}`;
  }
  return `${text}${withSpace}${sliceGraphemes(quotedText, available)}`;
}

function isVideo(media) {
  return media?.type === "video" || media?.type === "animated_gif";
}

function quoteMapping(tweet, ownUserId, database) {
  if (
    tweet?.quoting?.id &&
    String(tweet.quoting.user?.id) === String(ownUserId)
  ) {
    return database.getPost(tweet.quoting.id);
  }
  return null;
}

async function buildVideoEmbed(agent, media, dryRun) {
  const asset = await downloadVideo(media);
  const blob = await uploadBlob(agent, asset.buffer, "video/mp4", dryRun);
  const embed = {
    $type: "app.bsky.embed.video",
    video: blob,
  };
  const aspectRatio = mediaAspectRatio(media);
  if (aspectRatio) {
    embed.aspectRatio = aspectRatio;
  }
  if (media.type === "animated_gif") {
    embed.presentation = "gif";
  }
  return embed;
}

async function buildImagesEmbed(agent, mediaItems, dryRun) {
  const images = [];
  for (const media of mediaItems.slice(0, 4)) {
    const url = media.media_url_https ?? media.media_url ?? media.url;
    const downloaded = await downloadAsset(originalImageUrl(url));
    const prepared = await prepareImage(downloaded.buffer, downloaded.contentType);
    const image = {
      image: await uploadBlob(agent, prepared.buffer, prepared.encoding, dryRun),
      alt: media.ext_alt_text ?? media.alt_text ?? "",
    };
    if (prepared.aspectRatio) {
      image.aspectRatio = prepared.aspectRatio;
    }
    images.push(image);
  }
  return images.length > 0
    ? { $type: "app.bsky.embed.images", images }
    : null;
}

async function buildOwnMedia(agent, tweet, options) {
  const media = tweet?.media ?? [];
  const video = media.find(isVideo);
  if (video) {
    try {
      return { embed: await buildVideoEmbed(agent, video, options.dryRun) };
    } catch (error) {
      if (error instanceof VideoTooLargeError) {
        options.logger(`[tweet ${tweet.id}] own video exceeds 100MB; using original link`);
        return { embed: null, fallbackUrl: originalTweetUrl(tweet) };
      }
      throw error;
    }
  }
  const photos = media.filter((item) => !item?.type || item.type === "photo");
  return { embed: await buildImagesEmbed(agent, photos, options.dryRun) };
}

async function buildQuoteScreenshotEmbed(agent, quotedTweet, dryRun) {
  const screenshot = await renderQuoteCard(quotedTweet);
  const prepared = await prepareImage(screenshot, "image/png");
  const handle = quotedTweet?.user?.username ?? "unknown";
  const alt = sliceGraphemes(
    `quote of @${handle}: ${prepareTweetText(quotedTweet)}`,
    1000,
  );
  const image = {
    image: await uploadBlob(agent, prepared.buffer, prepared.encoding, dryRun),
    alt,
  };
  if (prepared.aspectRatio) {
    image.aspectRatio = prepared.aspectRatio;
  }
  return { $type: "app.bsky.embed.images", images: [image] };
}

async function buildRichText(agent, text) {
  const richText = new RichText({ text });
  await richText.detectFacets(agent);
  richText.facets = richText.facets
    ?.map((facet) => ({
      ...facet,
      features: facet.features.filter(
        (feature) =>
          feature.$type !== "app.bsky.richtext.facet#mention" ||
          feature.did?.startsWith("did:"),
      ),
    }))
    .filter((facet) => facet.features.length > 0);
  return richText;
}

function parsedCreatedAt(tweet) {
  const date = new Date(tweet?.created_at);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Tweet has an invalid created_at timestamp");
  }
  return date.toISOString();
}

export async function loginBluesky(config) {
  const agent = new BskyAgent({ service: config.bskyService });
  await agent.login({
    identifier: config.bskyHandle,
    password: config.bskyAppPassword,
  });
  return agent;
}

export async function buildBlueskyPost(
  agent,
  tweet,
  classification,
  ownUserId,
  database,
  options = {},
) {
  const dryRun = options.dryRun ?? false;
  const logger = options.logger ?? console.log;
  const ownMediaPresent = (tweet?.media?.length ?? 0) > 0;
  const quotedTweet = tweet?.quoting ?? null;
  const mappedQuote = quoteMapping(tweet, ownUserId, database);
  let text = prepareTweetText(tweet);
  let embed = null;
  let ownMedia = { embed: null };

  if (ownMediaPresent) {
    ownMedia = await buildOwnMedia(agent, tweet, { dryRun, logger });
    if (ownMedia.fallbackUrl) {
      text = appendRequiredLink(text, ownMedia.fallbackUrl);
    }
  }

  if (mappedQuote) {
    const record = {
      $type: "app.bsky.embed.record",
      record: { uri: mappedQuote.bsky_uri, cid: mappedQuote.bsky_cid },
    };
    embed = ownMedia.embed
      ? {
          $type: "app.bsky.embed.recordWithMedia",
          record,
          media: ownMedia.embed,
        }
      : record;
  } else if (quotedTweet) {
    if (ownMediaPresent) {
      logger(`[tweet ${tweet.id}] outer media wins quote media slot; using attribution text`);
      embed = ownMedia.embed;
      text = appendQuoteAttribution(text, quotedTweet);
    } else {
      const quotedVideo = (quotedTweet.media ?? []).find(isVideo);
      if (quotedVideo) {
        text = appendQuoteAttribution(text, quotedTweet);
        try {
          embed = await buildVideoEmbed(agent, quotedVideo, dryRun);
        } catch (error) {
          if (error instanceof VideoTooLargeError) {
            logger(`[tweet ${tweet.id}] quoted video exceeds 100MB; using screenshot card`);
            embed = await buildQuoteScreenshotEmbed(agent, quotedTweet, dryRun);
          } else {
            throw error;
          }
        }
      } else {
        embed = await buildQuoteScreenshotEmbed(agent, quotedTweet, dryRun);
      }
    }
  } else {
    embed = ownMedia.embed;
  }

  const parent =
    classification.kind === "self_reply"
      ? database.getPost(tweet.in_reply_to_status_id)
      : null;
  const chunks = splitTextForBsky(text);
  const richText = await buildRichText(agent, chunks[0]);
  const record = {
    text: richText.text,
    facets: richText.facets,
    createdAt: parsedCreatedAt(tweet),
  };
  if (embed) {
    record.embed = embed;
  }
  if (parent) {
    record.reply = {
      root: { uri: parent.bsky_root_uri, cid: parent.bsky_root_cid },
      parent: { uri: parent.bsky_uri, cid: parent.bsky_cid },
    };
  } else if (classification.kind === "self_reply") {
    logger(`[tweet ${tweet.id}] self-reply parent is not mapped; posting standalone`);
  }
  return { record, parent, chunks };
}

export async function publishTweet(
  agent,
  tweet,
  classification,
  ownUserId,
  database,
  options = {},
) {
  const built = await buildBlueskyPost(
    agent,
    tweet,
    classification,
    ownUserId,
    database,
    options,
  );
  if (options.dryRun) {
    const logger = options.logger ?? console.log;
    if (built.chunks.length === 1) {
      logger(
        `[tweet ${tweet.id}] dry run would post:\n${JSON.stringify(built.record, null, 2)}`,
      );
    } else {
      for (let index = 0; index < built.chunks.length; index += 1) {
        logger(
          `[tweet ${tweet.id}] dry run chunk ${index + 1}/${built.chunks.length}: ${JSON.stringify(built.chunks[index])}`,
        );
      }
    }
    return { dryRun: true, record: built.record };
  }

  const firstResult = await agent.post(built.record);
  const root = built.parent
    ? { uri: built.parent.bsky_root_uri, cid: built.parent.bsky_root_cid }
    : { uri: firstResult.uri, cid: firstResult.cid };
  let previous = { uri: firstResult.uri, cid: firstResult.cid };
  const wait = options.sleep ?? sleep;

  for (const chunk of built.chunks.slice(1)) {
    await wait(1500);
    const richText = await buildRichText(agent, chunk);
    const record = {
      text: richText.text,
      facets: richText.facets,
      createdAt: built.record.createdAt,
      reply: { root, parent: previous },
    };
    const result = await agent.post(record);
    previous = { uri: result.uri, cid: result.cid };
  }

  return {
    uri: firstResult.uri,
    cid: firstResult.cid,
    rootUri: root.uri,
    rootCid: root.cid,
  };
}
