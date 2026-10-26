import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isProcessTimeout } from "../lib/process-timeout.mjs";

const baseUrl = process.env.MOTIONCRAFT_TEST_URL ?? "http://localhost:3000";
let fixtureDirectory;
let audioWav;
let audioMp3;
let longAudioMp3;
let backgroundPng;

function runFfmpeg(args) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe", timeout: 60_000 });
}

function makeScene(start, end, message, graphic = "wave") {
  return {
    start,
    end,
    message,
    keywords: ["test"],
    concept: "Test scene",
    graphic,
    background: "gradient",
    typography: "bold",
    animation: "rise",
    transition: "dissolve",
  };
}

async function renderForm({
  audio,
  filename = "fixture.wav",
  contentType = "audio/wav",
  scenes = [makeScene(0, 2, "Test scene")],
  timestamps = "",
  aspectRatio = "9:16",
  backgroundImage,
} = {}) {
  const form = new FormData();
  form.set("audio", new File([audio], filename, { type: contentType }));
  form.set("timestamps", timestamps);
  form.set("script", "A short test scene.");
  form.set("contentKind", "Song / lyric video");
  form.set("scenePlan", JSON.stringify(scenes));
  form.set("aspectRatio", aspectRatio);
  form.set("resolution", "720p");
  form.set("style", "Romantic Lyrics");
  form.set("intensity", "Subtle");
  form.set("captionPosition", "Center");
  form.set("captionSize", "Small");
  form.set("backgroundStyle", backgroundImage ? "Uploaded image" : "Generated gradient");
  form.set("transitionIntensity", "Subtle");
  if (backgroundImage) {
    form.set("backgroundImage", new File([backgroundImage], "background.png", { type: "image/png" }));
  }
  return form;
}

async function postRender(form) {
  return fetch(`${baseUrl}/api/render`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(330_000),
  });
}

async function expectJsonError(response, status, text) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const result = await response.json();
  assert.match(result.error, text);
}

async function assertMp4(response, expectedWidth, expectedHeight) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /video\/mp4/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 1_000, "rendered MP4 should not be empty");
  const outputPath = path.join(fixtureDirectory, `render-${expectedWidth}x${expectedHeight}-${Date.now()}.mp4`);
  await writeFile(outputPath, bytes);
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height",
    "-of", "json",
    outputPath,
  ], { encoding: "utf8", timeout: 20_000 }));
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert.ok(video, "MP4 should contain a video stream");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, expectedWidth);
  assert.equal(video.height, expectedHeight);
  assert.ok(audio, "MP4 should contain an audio stream");
  assert.equal(audio.codec_name, "aac");
}

async function completeRender(response) {
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.match(job.id, /^[0-9a-f-]{36}$/i);
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const statusResponse = await fetch(`${baseUrl}/api/render/${job.id}`, { cache: "no-store" });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    if (status.status === "failed") assert.fail(status.error || "Render job failed.");
    if (status.status === "cancelled") assert.fail("Render job was cancelled unexpectedly.");
    if (status.status === "completed") {
      return fetch(`${baseUrl}/api/render/${job.id}/video`, { cache: "no-store" });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.fail("Render job did not finish within 60 seconds.");
}

before(async () => {
  const health = await fetch(baseUrl, { signal: AbortSignal.timeout(10_000) });
  assert.ok(health.ok, `MotionCraft must be running at ${baseUrl}; start it with npm run dev.`);

  fixtureDirectory = await mkdtemp(path.join(tmpdir(), "motioncraft-render-tests-"));
  audioWav = path.join(fixtureDirectory, "fixture.wav");
  audioMp3 = path.join(fixtureDirectory, "fixture.mp3");
  longAudioMp3 = path.join(fixtureDirectory, "long-fixture.mp3");
  backgroundPng = path.join(fixtureDirectory, "background.png");

  runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2", audioWav]);
  runFfmpeg(["-i", audioWav, "-c:a", "libmp3lame", "-b:a", "128k", audioMp3]);
  runFfmpeg([
    "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=8000",
    "-t", "181", "-c:a", "libmp3lame", "-b:a", "16k", longAudioMp3,
  ]);
  runFfmpeg(["-f", "lavfi", "-i", "color=c=navy:s=160x90", "-frames:v", "1", backgroundPng]);
}, { timeout: 90_000 });

after(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

test("rejects unsupported audio extensions with an actionable validation error", async () => {
  const form = await renderForm({
    audio: Buffer.from("not an audio file"),
    filename: "fixture.flac",
    contentType: "audio/flac",
  });
  await expectJsonError(await postRender(form), 400, /Only MP3 and WAV/);
});

test("rejects corrupt audio and audio without a decodable stream", async () => {
  const form = await renderForm({ audio: Buffer.from("not an mp3") });
  await expectJsonError(await postRender(form), 400, /could not be decoded/);
});

test("rejects audio longer than the documented duration limit", async () => {
  const form = await renderForm({
    audio: await readFile(longAudioMp3),
    filename: "long-fixture.mp3",
    contentType: "audio/mpeg",
  });
  await expectJsonError(await postRender(form), 400, /3 minutes or shorter/);
});

test("rejects timestamps that extend beyond the uploaded audio", async () => {
  const form = await renderForm({
    audio: await readFile(audioWav),
    timestamps: "00:00 - 00:03 | Too long",
    scenes: [makeScene(0, 3, "Too long")],
  });
  await expectJsonError(await postRender(form), 400, /ends after the uploaded audio/);
});

test("rejects unsupported graphics in an edited scene plan", async () => {
  const form = await renderForm({
    audio: await readFile(audioWav),
    scenes: [makeScene(0, 2, "Invalid graphic", "not-a-graphic")],
  });
  await expectJsonError(await postRender(form), 400, /unsupported graphic type/);
});

test("rejects a background image whose bytes cannot be decoded", async () => {
  const form = await renderForm({
    audio: await readFile(audioWav),
    backgroundImage: Buffer.from("not a png"),
  });
  await expectJsonError(await postRender(form), 400, /background image could not be decoded/);
});

test("renders MP3 audio with a generated portrait background", async () => {
  const form = await renderForm({
    audio: await readFile(audioMp3),
    filename: "fixture.mp3",
    contentType: "audio/mpeg",
  });
  await assertMp4(await completeRender(await postRender(form)), 720, 1280);
});

test("renders timestamped lyrics with multiple scenes in landscape", async () => {
  const timestamps = "00:00 - 00:01 | First lyric\n00:01 - 00:02 | Second lyric";
  const form = await renderForm({
    audio: await readFile(audioWav),
    timestamps,
    scenes: [makeScene(0, 1, "First lyric", "heart"), makeScene(1, 2, "Second lyric", "chart")],
    aspectRatio: "16:9",
  });
  await assertMp4(await completeRender(await postRender(form)), 1280, 720);
}, { timeout: 90_000 });

test("renders an uploaded image background in a square composition", async () => {
  const form = await renderForm({
    audio: await readFile(audioWav),
    aspectRatio: "1:1",
    backgroundImage: await readFile(backgroundPng),
  });
  await assertMp4(await completeRender(await postRender(form)), 720, 720);
}, { timeout: 90_000 });

test("recognizes Node subprocess timeout metadata", () => {
  assert.equal(isProcessTimeout({ code: "ETIMEDOUT" }), true);
  assert.equal(isProcessTimeout({ killed: true, signal: "SIGTERM" }), true);
  assert.equal(isProcessTimeout({ killed: true, signal: "SIGKILL" }), false);
  assert.equal(isProcessTimeout({ killed: false, signal: "SIGTERM" }), false);
});
