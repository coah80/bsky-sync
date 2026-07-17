import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VIDEO_MAX_BYTES, VideoTooLargeError } from "./media.js";

let ffmpegAvailablePromise = null;

export function ffmpegAvailable() {
  if (!ffmpegAvailablePromise) {
    ffmpegAvailablePromise = new Promise((resolve) => {
      const child = spawn("ffmpeg", ["-version"], {
        stdio: "ignore",
        windowsHide: true,
      });
      let settled = false;
      child.once("error", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      child.once("spawn", () => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
      child.once("close", (code) => {
        if (!settled) {
          settled = true;
          resolve(code === 0);
        }
      });
    });
  }
  return ffmpegAvailablePromise;
}

export function buildComposeArgs(cardPngPath, videoPath, outputPath, slot) {
  return [
    "-y",
    "-loop",
    "1",
    "-i",
    cardPngPath,
    "-i",
    videoPath,
    "-filter_complex",
    `[1:v]scale=${slot.width}:${slot.height}[vid];[0:v][vid]overlay=${slot.x}:${slot.y}:shortest=1[out]`,
    "-map",
    "[out]",
    "-map",
    "1:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
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
      const message = stderr.slice(-500).trim() || `ffmpeg exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

export async function composeQuoteVideo(cardPng, videoBuffer, slot) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bsky-quote-video-"));
  const cardPngPath = path.join(directory, "card.png");
  const videoPath = path.join(directory, "video.mp4");
  const outputPath = path.join(directory, "output.mp4");
  try {
    await Promise.all([
      writeFile(cardPngPath, cardPng),
      writeFile(videoPath, videoBuffer),
    ]);
    await runFfmpeg(buildComposeArgs(cardPngPath, videoPath, outputPath, slot));
    const output = await readFile(outputPath);
    if (output.length > VIDEO_MAX_BYTES) {
      throw new VideoTooLargeError(output.length);
    }
    return output;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
