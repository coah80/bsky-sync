import sharp from "sharp";

export const IMAGE_TARGET_BYTES = 950 * 1024;
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;

export class VideoTooLargeError extends Error {
  constructor(size) {
    super(`Video is ${size} bytes; Bluesky limit is ${VIDEO_MAX_BYTES} bytes`);
    this.name = "VideoTooLargeError";
    this.size = size;
  }
}

function decodeDataUrl(url) {
  const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) {
    throw new Error("Invalid data URL");
  }
  return {
    buffer: match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3])),
    contentType: match[1] || "application/octet-stream",
  };
}

export async function downloadAsset(url, options = {}) {
  if (!url) {
    throw new Error("Missing media URL");
  }
  if (url.startsWith("data:")) {
    const asset = decodeDataUrl(url);
    if (options.maxBytes && asset.buffer.length > options.maxBytes) {
      throw new Error(`Download exceeds ${options.maxBytes} bytes`);
    }
    return asset;
  }

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  if (!response.ok) {
    throw new Error(`Media download failed with HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (options.maxBytes && declaredLength > options.maxBytes) {
    throw new Error(`Download exceeds ${options.maxBytes} bytes`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (options.maxBytes && buffer.length > options.maxBytes) {
    throw new Error(`Download exceeds ${options.maxBytes} bytes`);
  }
  return {
    buffer,
    contentType: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
  };
}

export async function downloadToBuffer(url, options = {}) {
  return (await downloadAsset(url, options)).buffer;
}

export function originalImageUrl(url) {
  if (!url || url.startsWith("data:")) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("name", "orig");
    return parsed.toString();
  } catch {
    return url;
  }
}

export function pickBestMp4Variant(media) {
  const variants = media?.video_info?.variants ?? media?.videoInfo?.variants ?? [];
  return variants
    .filter((variant) => {
      const contentType = variant?.content_type ?? variant?.contentType;
      return contentType === "video/mp4" && variant?.url;
    })
    .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0))[0] ?? null;
}

export function mediaAspectRatio(media) {
  const ratio =
    media?.video_info?.aspect_ratio ??
    media?.videoInfo?.aspectRatio ??
    media?.original_info?.aspect_ratio;
  if (Array.isArray(ratio) && ratio.length === 2 && ratio[0] > 0 && ratio[1] > 0) {
    return { width: ratio[0], height: ratio[1] };
  }
  return undefined;
}

export async function downloadVideo(media) {
  const variant = pickBestMp4Variant(media);
  if (!variant) {
    throw new Error("No video/mp4 variant was available");
  }
  try {
    const asset = await downloadAsset(variant.url, { maxBytes: VIDEO_MAX_BYTES });
    return { ...asset, variant };
  } catch (error) {
    if (/exceeds/.test(error.message)) {
      throw new VideoTooLargeError(VIDEO_MAX_BYTES + 1);
    }
    throw error;
  }
}

export async function prepareImage(buffer, contentType = "image/jpeg") {
  const input = Buffer.from(buffer);
  const inputMetadata = await sharp(input).metadata();
  const originalRatio =
    inputMetadata.width && inputMetadata.height
      ? { width: inputMetadata.width, height: inputMetadata.height }
      : undefined;

  if (input.length <= IMAGE_TARGET_BYTES) {
    return {
      buffer: input,
      encoding: contentType.startsWith("image/") ? contentType : "image/jpeg",
      aspectRatio: originalRatio,
    };
  }

  let width = Math.min(inputMetadata.width ?? 2000, 2000);
  let quality = 86;
  let output = input;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    output = await sharp(input)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (output.length <= IMAGE_TARGET_BYTES) {
      const metadata = await sharp(output).metadata();
      return {
        buffer: output,
        encoding: "image/jpeg",
        aspectRatio:
          metadata.width && metadata.height
            ? { width: metadata.width, height: metadata.height }
            : originalRatio,
      };
    }
    quality = Math.max(48, quality - 7);
    width = Math.max(720, Math.floor(width * 0.85));
  }
  throw new Error(`Image could not be reduced below ${IMAGE_TARGET_BYTES} bytes`);
}
