import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildBlueskyPost } from "../src/bsky.js";
import { SyncDatabase } from "../src/db.js";
import {
  buildComposeArgs,
  composeQuoteVideo,
  ffmpegAvailable,
} from "../src/video-card.js";

const hasFfmpeg = await ffmpegAvailable();
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/external-quote-video.json", import.meta.url), "utf8"),
);

function generateTestVideo(outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=1:size=640x360:rate=24",
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

function createAgent() {
  return {
    resolveHandle: async () => ({ data: { did: "did:plc:other" } }),
  };
}

test("builds exact ffmpeg arguments for a video quote card", () => {
  assert.deepEqual(
    buildComposeArgs("card.png", "video.mp4", "output.mp4", {
      x: 20,
      y: 40,
      width: 320,
      height: 180,
    }),
    [
      "-y",
      "-loop",
      "1",
      "-i",
      "card.png",
      "-i",
      "video.mp4",
      "-filter_complex",
      "[1:v]scale=320:180[vid];[0:v][vid]overlay=20:40:shortest=1[out]",
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
      "output.mp4",
    ],
  );
});

test(
  "composes a playable mp4 video quote card",
  { skip: hasFfmpeg ? false : "ffmpeg not installed" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bsky-video-card-test-"));
    try {
      const videoPath = path.join(directory, "source.mp4");
      const png = await sharp({
        create: {
          width: 640,
          height: 480,
          channels: 3,
          background: "#18202a",
        },
      })
        .png()
        .toBuffer();
      await generateTestVideo(videoPath);
      const videoBuffer = await readFile(videoPath);
      const output = await composeQuoteVideo(png, videoBuffer, {
        x: 20,
        y: 20,
        width: 320,
        height: 180,
      });
      assert.ok(output.length > 0);
      assert.equal(output.subarray(4, 8).toString(), "ftyp");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("falls back to raw quoted video and attribution when composition fails", async () => {
  const database = new SyncDatabase(":memory:");
  const logs = [];
  try {
    const built = await buildBlueskyPost(
      createAgent(),
      fixture,
      { kind: "external_quote" },
      "100",
      database,
      {
        dryRun: true,
        logger: (message) => logs.push(message),
        composeQuoteVideoCard: async () => {
          throw new Error("boom");
        },
      },
    );
    assert.equal(built.record.embed.$type, "app.bsky.embed.video");
    assert.ok(built.record.text.includes("\u{1F4AC} @other:"));
    assert.deepEqual(logs, [
      `[tweet ${fixture.id}] video quote card failed (boom); posting raw quoted video`,
    ]);
  } finally {
    database.close();
  }
});

test("uses a successful composed quote video without attribution", async () => {
  const database = new SyncDatabase(":memory:");
  const expectedEmbed = {
    $type: "app.bsky.embed.video",
    video: {
      $type: "blob",
      ref: { $link: "bafkrei-video-card" },
      mimeType: "video/mp4",
      size: 1234,
    },
    aspectRatio: { width: 680, height: 900 },
  };
  try {
    const built = await buildBlueskyPost(
      createAgent(),
      fixture,
      { kind: "external_quote" },
      "100",
      database,
      {
        dryRun: true,
        composeQuoteVideoCard: async () => expectedEmbed,
      },
    );
    assert.equal(built.record.embed.$type, "app.bsky.embed.video");
    assert.deepEqual(built.record.embed.aspectRatio, {
      width: 680,
      height: 900,
    });
    assert.equal(built.record.text.includes("\u{1F4AC} @other:"), false);
  } finally {
    database.close();
  }
});
