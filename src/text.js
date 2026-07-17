import { RichText } from "@atproto/api";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeLength(text) {
  return new RichText({ text: String(text ?? "") }).graphemeLength;
}

export function sliceGraphemes(text, count) {
  if (count <= 0) {
    return "";
  }
  let output = "";
  let seen = 0;
  for (const { segment } of segmenter.segment(String(text ?? ""))) {
    if (seen >= count) {
      break;
    }
    output += segment;
    seen += 1;
  }
  return output;
}

export function unescapeHtmlEntities(text) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return String(text ?? "").replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi,
    (entity, body) => {
      const lower = body.toLowerCase();
      if (lower.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      }
      if (lower.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      }
      return named[lower] ?? entity;
    },
  );
}

export function expandTcoUrls(text, urls = []) {
  let expanded = String(text ?? "");
  for (const item of urls ?? []) {
    const shortUrl = item?.url;
    const destination = item?.expanded_url ?? item?.expandedUrl;
    if (shortUrl && destination) {
      expanded = expanded.split(shortUrl).join(destination);
    }
  }
  return expanded;
}

export function stripTrailingTcoLink(text, tweet = {}) {
  const value = String(text ?? "");
  const match = value.match(/(?:\s+|^)(https?:\/\/\S+)\s*$/i);
  if (!match) {
    return value;
  }

  const trailingUrl = match[1];
  const mediaUrls = (tweet.media ?? [])
    .flatMap((item) => [item?.url, item?.expanded_url, item?.expandedUrl])
    .filter(Boolean);
  const quoteUrl = (tweet.urls ?? []).some((item) => {
    if (!tweet.quoting) {
      return false;
    }
    const expanded = item.expanded_url ?? item.expandedUrl ?? "";
    return (
      (item?.url === trailingUrl || expanded === trailingUrl) &&
      (!tweet.quoting.id || expanded.includes(`/status/${tweet.quoting.id}`))
    );
  });
  const removable =
    mediaUrls.includes(trailingUrl) ||
    quoteUrl ||
    ((tweet.media?.length ?? 0) > 0 && /^https?:\/\/t\.co\//i.test(trailingUrl));

  return removable ? value.slice(0, match.index).trimEnd() : value;
}

export function prepareTweetText(tweet) {
  const expanded = expandTcoUrls(tweet?.text ?? "", tweet?.urls ?? []);
  const stripped = stripTrailingTcoLink(expanded, tweet);
  return unescapeHtmlEntities(stripped).trim();
}

export function splitTextForBsky(
  text,
  maxChunkGraphemes = 295,
  singlePostLimit = 300,
) {
  const value = String(text ?? "");
  if (graphemeLength(value) <= singlePostLimit) {
    return [value];
  }

  const graphemes = Array.from(segmenter.segment(value), ({ segment }) => segment);
  const chunks = [];
  let offset = 0;

  while (offset < graphemes.length) {
    if (chunks.length > 0) {
      while (offset < graphemes.length && /^\s+$/u.test(graphemes[offset])) {
        offset += 1;
      }
    }
    if (offset >= graphemes.length) {
      break;
    }

    const remaining = graphemes.length - offset;
    if (remaining <= maxChunkGraphemes) {
      chunks.push(graphemes.slice(offset).join(""));
      break;
    }

    const end = offset + maxChunkGraphemes;
    let boundary = -1;
    for (let index = end - 1; index > offset; index -= 1) {
      if (/^\s+$/u.test(graphemes[index])) {
        boundary = index;
        break;
      }
    }

    if (boundary === -1) {
      chunks.push(graphemes.slice(offset, end).join(""));
      offset = end;
    } else {
      chunks.push(graphemes.slice(offset, boundary).join("").trimEnd());
      offset = boundary + 1;
    }
  }

  return chunks;
}

export function truncateToBskyLimit(text, maxGraphemes = 300) {
  const value = String(text ?? "");
  if (graphemeLength(value) <= maxGraphemes) {
    return value;
  }
  return `${sliceGraphemes(value, maxGraphemes - 1)}…`;
}
