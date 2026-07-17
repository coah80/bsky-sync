import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { downloadAsset, originalImageUrl } from "./media.js";
import { prepareTweetText } from "./text.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(moduleDirectory, "templates", "quote-card.html");
const placeholderAvatar =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#202327"/><circle cx="48" cy="36" r="18" fill="#71767b"/><path d="M16 92c2-22 14-34 32-34s30 12 32 34" fill="#71767b"/></svg>',
  ).toString("base64");

let browserPromise = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function assetToDataUrl(asset) {
  return `data:${asset.contentType};base64,${asset.buffer.toString("base64")}`;
}

async function inlineAsset(url, fallback = null) {
  if (!url) {
    return fallback;
  }
  try {
    return assetToDataUrl(await downloadAsset(url, { timeoutMs: 12_000 }));
  } catch {
    return fallback;
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, args: process.env.CHROMIUM_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] }).catch((error) => {
      browserPromise = null;
      throw new Error(
        `Playwright Chromium could not launch. Run "npx playwright install chromium". ${error.message}`,
      );
    });
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Date unavailable";
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

async function buildMediaMarkup(tweet) {
  const photos = (tweet?.media ?? [])
    .filter((item) => !item?.type || item.type === "photo")
    .slice(0, 4);
  const images = [];
  for (const photo of photos) {
    const url = photo.media_url_https ?? photo.media_url ?? photo.url;
    const inlined = await inlineAsset(originalImageUrl(url));
    if (inlined) {
      images.push(inlined);
    }
  }
  if (images.length === 0) {
    return "";
  }
  const countClass = ["", "one", "two", "three", "four"][images.length];
  return `<div class="media ${countClass}">${images
    .map((src) => `<img src="${src}" alt="">`)
    .join("")}</div>`;
}

export async function renderQuoteCard(quotedTweet) {
  const [template, avatar, media] = await Promise.all([
    readFile(templatePath, "utf8"),
    inlineAsset(quotedTweet?.user?.profile_picture?.url, placeholderAvatar),
    buildMediaMarkup(quotedTweet),
  ]);
  const html = template
    .replace("{{AVATAR}}", avatar)
    .replace("{{NAME}}", escapeHtml(quotedTweet?.user?.name ?? "Unknown user"))
    .replace("{{HANDLE}}", escapeHtml(quotedTweet?.user?.username ?? "unknown"))
    .replace("{{TEXT}}", escapeHtml(prepareTweetText(quotedTweet)))
    .replace("{{MEDIA}}", media)
    .replace("{{DATE}}", escapeHtml(formatDate(quotedTweet?.created_at)));

  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: 680, height: 1200 },
    deviceScaleFactor: 2,
  });
  try {
    await page.setContent(html, { waitUntil: "load" });
    return await page.locator("#quote-card").screenshot({ type: "png" });
  } finally {
    await page.close();
  }
}

export async function closeRenderer() {
  if (!browserPromise) {
    return;
  }
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}
