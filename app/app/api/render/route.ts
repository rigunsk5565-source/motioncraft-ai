import { execFile as execFileCallback } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { enqueueRenderJob, getRenderJob, removeRenderJob, reserveRenderJob } from "@/lib/render-jobs";
import { isProcessTimeout } from "@/lib/process-timeout.mjs";
import {
  createFallbackPlan,
  parseTimedText,
  validateContentKind,
  validateScenePlan,
  validateVisualStyle,
  type GraphicType,
  type Scene,
  type VisualStyle,
} from "@/lib/scene-planner";

const execFile = promisify(execFileCallback);
const maxAudioBytes = 50 * 1024 * 1024;
const maxImageBytes = 20 * 1024 * 1024;
const maxRequestBytes = maxAudioBytes + maxImageBytes + 1024 * 1024;
const maxAudioSeconds = 180;
const diagnosticLimit = 2_000;
const intensities = ["Subtle", "Balanced", "Dynamic"] as const;
const captionPositions = ["Upper-middle", "Center", "Lower-middle"] as const;
const backgroundStyles = ["Generated gradient", "Uploaded image"] as const;
const transitionIntensities = ["Subtle", "Balanced", "Dynamic"] as const;

type Intensity = (typeof intensities)[number];
type CaptionPosition = (typeof captionPositions)[number];
type RenderStage = "request" | "audio-probe" | "image-probe" | "scene-setup" | "ffmpeg" | "output";
type ProcessError = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string | Buffer;
};
type CommandLabel = "FFmpeg" | "FFprobe";

class CommandExecutionError extends Error {
  readonly code: string | number | null;
  readonly killed: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stderr: string;

  constructor(command: CommandLabel, error: ProcessError) {
    super(`${command} exited unsuccessfully.`);
    this.name = "CommandExecutionError";
    this.code = error.code ?? null;
    this.killed = error.killed === true;
    this.signal = error.signal ?? null;
    this.timedOut = isProcessTimeout(error);
    const stderr = error.stderr;
    this.stderr = (Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr ?? "").slice(-diagnosticLimit);
  }
}
type Theme = {
  background: [string, string, string];
  text: string;
  glow: string;
  wave: string;
  ray: string;
  particles: string;
  accent: string;
};

const themes: Record<VisualStyle, Theme> = {
  Cinematic: {
    background: ["0x101225", "0x324568", "0x99735e"],
    text: "0xfff3e8", glow: "0xf1ad7f", wave: "0xffd3ae", ray: "0xffd6b1", particles: "0xffdec4", accent: "0xeeb487",
  },
  "Educational Explainer": {
    background: ["0x081a2d", "0x145078", "0x398a91"],
    text: "0xf0fbff", glow: "0x59c6d2", wave: "0x7cf1df", ray: "0x8fe9ff", particles: "0xb9f4f1", accent: "0x72decb",
  },
  "Digital Marketing": {
    background: ["0x190f2e", "0x45226f", "0xc34c7a"],
    text: "0xfff2f8", glow: "0xe174dc", wave: "0xffcf70", ray: "0xff8cb6", particles: "0xffc7dc", accent: "0xffbc70",
  },
  Corporate: {
    background: ["0x101a31", "0x284c70", "0x55889a"],
    text: "0xf2f7ff", glow: "0x78b9e1", wave: "0x9de1ff", ray: "0xa5d5f2", particles: "0xd0e9ff", accent: "0x87c7ed",
  },
  "Modern Minimal": {
    background: ["0x15212a", "0x35434b", "0x66726f"],
    text: "0xf5f4ee", glow: "0xd2dfdf", wave: "0xb9d3d4", ray: "0xd6e5e2", particles: "0xdce7e4", accent: "0xc5ddd7",
  },
  "Kinetic Typography": {
    background: ["0x160d27", "0x4d1d52", "0xb14545"],
    text: "0xfff7f0", glow: "0xff7b79", wave: "0xffc16e", ray: "0xffa16f", particles: "0xffc1a2", accent: "0xffa16f",
  },
  Luxury: {
    background: ["0x17110b", "0x4c3116", "0x99703a"],
    text: "0xffe8ad", glow: "0xd6a34e", wave: "0xffd77e", ray: "0xffd78b", particles: "0xffe7aa", accent: "0xe4bd66",
  },
  Neon: {
    background: ["0x100923", "0x402075", "0x852d71"],
    text: "0xf8edff", glow: "0xe56fff", wave: "0x5bf3ff", ray: "0x63eaff", particles: "0xe6a7ff", accent: "0x5bf3ff",
  },
  "Romantic Lyrics": {
    background: ["0x201125", "0x66354e", "0xd49179"],
    text: "0xfff5e8", glow: "0xf1a687", wave: "0xffd3ae", ray: "0xffd6b1", particles: "0xffdec4", accent: "0xf1a687",
  },
};

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function processErrorDetails(error: unknown) {
  if (!(error instanceof CommandExecutionError)) return null;
  return {
    code: error.code,
    killed: error.killed,
    signal: error.signal,
    timedOut: error.timedOut,
    stderr: error.stderr,
  };
}

async function runCommand(command: CommandLabel, executable: string, args: string[], options: { timeout: number; maxBuffer: number }) {
  try {
    return await execFile(executable, args, options);
  } catch (error) {
    if (error instanceof Error) throw new CommandExecutionError(command, error as ProcessError);
    throw error;
  }
}

async function writeUploadedFile(file: File, destination: string) {
  async function* chunks() {
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  await pipeline(Readable.from(chunks()), createWriteStream(destination, { flags: "wx" }));
}

function commandFailureResponse(stage: RenderStage, failure: ReturnType<typeof processErrorDetails>, requestId: string) {
  if (failure?.code === "ENOENT") {
    return jsonError(`Required ${stage === "ffmpeg" ? "FFmpeg" : "FFprobe"} executable was not found on the server. Check the server installation. Reference: ${requestId}.`, 500);
  }
  if (failure?.timedOut) {
    const message = stage === "ffmpeg"
      ? "Rendering exceeded the 5-minute limit. Try 720p or a shorter audio track."
      : "Audio inspection took too long. Check that the uploaded file is a valid MP3 or WAV.";
    return jsonError(`${message} Reference: ${requestId}.`, 504);
  }
  if (failure?.signal) {
    return jsonError(`The ${stage === "ffmpeg" ? "rendering process" : "audio inspection process"} stopped unexpectedly (${failure.signal}). Try a shorter track or 720p. Reference: ${requestId}.`, 500);
  }
  if (stage === "audio-probe") {
    return jsonError("The uploaded audio could not be decoded. Check that it is a valid MP3 or WAV file.", 400);
  }
  if (stage === "image-probe") {
    return jsonError("The uploaded background image could not be decoded. Check that it is a valid PNG, JPEG, or WebP file.", 400);
  }
  return jsonError(`FFmpeg could not render this composition. Try simplifying the scene or using 720p. Reference: ${requestId}.`, 500);
}

function wrapText(text: string, maxCharacters: number) {
  const lines: string[] = [];
  let current = "";
  for (const token of text.match(/\S+\s*/g) ?? []) {
    const word = token.trimEnd();
    const spacing = token.slice(word.length);
    if (word.length > maxCharacters) {
      if (current.trim()) lines.push(current.trimEnd());
      for (let offset = 0; offset < word.length; offset += maxCharacters) {
        const part = word.slice(offset, offset + maxCharacters);
        if (offset + maxCharacters < word.length) lines.push(part);
        else current = `${part}${spacing}`;
      }
      continue;
    }
    if (current.trimEnd().length + word.length > maxCharacters && current.trim()) {
      lines.push(current.trimEnd());
      current = `${word}${spacing}`;
    } else current += token;
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.join("\n");
}

function escapeFilterPath(filePath: string) {
  return filePath.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function isImageFile(file: File) {
  const types = new Map([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".webp", "image/webp"],
  ]);
  return types.get(path.extname(file.name).toLowerCase()) === file.type;
}

function graphicFilters(graphic: GraphicType, theme: Theme, start: number, end: number) {
  const enabled = `enable='between(t\\,${start}\\,${end})'`;
  const line = (x: string, y: string, width: string, height: string) =>
    `drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=${theme.accent}@0.82:t=fill:${enabled}`;
  const solid = (x: string, y: string, width: string, height: string) =>
    `drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=${theme.accent}@0.78:t=fill:${enabled}`;
  const left = "iw*0.73";
  const top = "ih*0.55";
  if (graphic === "chart") {
    return [
      line(`${left}-4`, `${top}+ih*0.19`, "iw*0.21", "3"),
      solid(`${left}+iw*0.02`, `${top}+ih*0.12`, "iw*0.035", "ih*0.07"),
      solid(`${left}+iw*0.075`, `${top}+ih*0.08`, "iw*0.035", "ih*0.11"),
      solid(`${left}+iw*0.13`, `${top}+ih*0.035`, "iw*0.035", "ih*0.155"),
      solid(`${left}+iw*0.185`, `${top}`, "iw*0.035", "ih*0.19"),
    ];
  }
  if (graphic === "network") {
    return [
      line(`${left}+iw*0.035`, `${top}+ih*0.055`, "iw*0.15", "2"),
      line(`${left}+iw*0.055`, `${top}+ih*0.05`, "2", "ih*0.13"),
      line(`${left}+iw*0.16`, `${top}+ih*0.05`, "2", "ih*0.13"),
      solid(`${left}+iw*0.005`, `${top}`, "iw*0.055", "ih*0.055"),
      solid(`${left}+iw*0.09`, `${top}+ih*0.11`, "iw*0.055", "ih*0.055"),
      solid(`${left}+iw*0.19`, `${top}`, "iw*0.055", "ih*0.055"),
      solid(`${left}+iw*0.19`, `${top}+ih*0.12`, "iw*0.055", "ih*0.055"),
    ];
  }
  if (graphic === "target") {
    return [
      `drawbox=x=${left}:y=${top}:w=iw*0.21:h=ih*0.2:color=${theme.accent}@0.78:t=3:${enabled}`,
      `drawbox=x=${left}+iw*0.035:y=${top}+ih*0.03:w=iw*0.14:h=ih*0.14:color=${theme.accent}@0.78:t=3:${enabled}`,
      solid(`${left}+iw*0.082`, `${top}+ih*0.07`, "iw*0.045", "ih*0.06"),
    ];
  }
  if (graphic === "book") {
    return [
      `drawbox=x=${left}:y=${top}:w=iw*0.1:h=ih*0.16:color=${theme.accent}@0.82:t=3:${enabled}`,
      `drawbox=x=${left}+iw*0.105:y=${top}:w=iw*0.1:h=ih*0.16:color=${theme.accent}@0.82:t=3:${enabled}`,
      line(`${left}+iw*0.025`, `${top}+ih*0.05`, "iw*0.065", "2"),
      line(`${left}+iw*0.025`, `${top}+ih*0.09`, "iw*0.065", "2"),
      line(`${left}+iw*0.12`, `${top}+ih*0.05`, "iw*0.065", "2"),
      line(`${left}+iw*0.12`, `${top}+ih*0.09`, "iw*0.065", "2"),
    ];
  }
  if (graphic === "heart") {
    return [
      `drawbox=x=${left}:y=${top}:w=iw*0.21:h=ih*0.19:color=${theme.accent}@0.78:t=3:${enabled}`,
      line(`${left}+iw*0.04`, `${top}+ih*0.055`, "iw*0.055", "3"),
      line(`${left}+iw*0.115`, `${top}+ih*0.055`, "iw*0.055", "3"),
      line(`${left}+iw*0.07`, `${top}+ih*0.105`, "iw*0.07", "3"),
    ];
  }
  if (graphic === "idea") {
    return [
      `drawbox=x=${left}:y=${top}:w=iw*0.21:h=ih*0.19:color=${theme.accent}@0.78:t=3:${enabled}`,
      line(`${left}+iw*0.1`, `${top}+ih*0.025`, "iw*0.02", "ih*0.035"),
      line(`${left}+iw*0.035`, `${top}+ih*0.08`, "iw*0.045", "3"),
      line(`${left}+iw*0.14`, `${top}+ih*0.08`, "iw*0.045", "3"),
      line(`${left}+iw*0.08`, `${top}+ih*0.15`, "iw*0.06", "3"),
    ];
  }
  return [
    line(`${left}`, `${top}+ih*0.1`, "iw*0.21", "3"),
    line(`${left}+iw*0.03`, `${top}+ih*0.065`, "iw*0.04", "ih*0.07"),
    line(`${left}+iw*0.085`, `${top}+ih*0.03`, "iw*0.04", "ih*0.105"),
    line(`${left}+iw*0.14`, `${top}+ih*0.08`, "iw*0.04", "ih*0.055"),
  ];
}

function sceneBackdropFilters(background: Scene["background"], theme: Theme, start: number, end: number) {
  const enabled = `enable='between(t\\,${start}\\,${end})'`;
  if (background === "spotlight") {
    return [`drawbox=x=iw*0.70:y=ih*0.46:w=iw*0.28:h=ih*0.36:color=${theme.background[1]}@0.28:t=fill:${enabled}`];
  }
  if (background === "grid") {
    return [
      `drawbox=x=iw*0.70:y=ih*0.46:w=iw*0.28:h=2:color=${theme.accent}@0.18:t=fill:${enabled}`,
      `drawbox=x=iw*0.70:y=ih*0.55:w=iw*0.28:h=2:color=${theme.accent}@0.18:t=fill:${enabled}`,
      `drawbox=x=iw*0.70:y=ih*0.64:w=iw*0.28:h=2:color=${theme.accent}@0.18:t=fill:${enabled}`,
      `drawbox=x=iw*0.70:y=ih*0.73:w=iw*0.28:h=2:color=${theme.accent}@0.18:t=fill:${enabled}`,
      `drawbox=x=iw*0.70:y=ih*0.46:w=2:h=ih*0.36:color=${theme.accent}@0.18:t=fill:${enabled}`,
      `drawbox=x=iw*0.79:y=ih*0.46:w=2:h=ih*0.36:color=${theme.accent}@0.18:t=fill:${enabled}`,
      `drawbox=x=iw*0.88:y=ih*0.46:w=2:h=ih*0.36:color=${theme.accent}@0.18:t=fill:${enabled}`,
      `drawbox=x=iw*0.97:y=ih*0.46:w=2:h=ih*0.36:color=${theme.accent}@0.18:t=fill:${enabled}`,
    ];
  }
  return [];
}

function captionY(position: CaptionPosition) {
  if (position === "Center") return "h*0.5-text_h/2";
  if (position === "Lower-middle") return "h*0.68-text_h/2";
  return "h*0.36-text_h/2";
}

export async function POST(request: Request) {
  let workDirectory = "";
  let jobSubmitted = false;
  const job = reserveRenderJob();
  if (!job) return jsonError("The render queue is full. Wait for a current render to finish, then try again.", 429);
  const requestId = job.id;
  let stage: RenderStage = "request";
  try {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      return jsonError("Submit the render request as a multipart form.", 415);
    }
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
      return jsonError("Render uploads, including form data, cannot exceed 71 MiB in total.", 413);
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonError("The upload form could not be read. Please retry with a valid audio file.", 400);
    }
    const audio = formData.get("audio");
    const backgroundImage = formData.get("backgroundImage");
    const timestampValue = formData.get("timestamps");
    const scriptValue = formData.get("script");
    const contentKind = formData.get("contentKind");
    const scenePlanValue = formData.get("scenePlan");
    const ratioValue = formData.get("aspectRatio");
    const resolutionValue = formData.get("resolution");
    const styleValue = formData.get("style");
    const intensityValue = formData.get("intensity");
    const captionPositionValue = formData.get("captionPosition");
    const captionSizeValue = formData.get("captionSize");
    const backgroundStyleValue = formData.get("backgroundStyle");
    const transitionIntensityValue = formData.get("transitionIntensity");

    if (!(audio instanceof File)) return jsonError("Upload an MP3 or WAV audio file.", 400);
    if (!/\.(mp3|wav)$/i.test(audio.name)) return jsonError("Only MP3 and WAV files are supported.", 400);
    if (!audio.size || audio.size > maxAudioBytes) return jsonError("Audio must be smaller than 50 MB.", 400);
    if (backgroundImage !== null && !(backgroundImage instanceof File)) return jsonError("Choose a valid background image.", 400);
    if (backgroundImage instanceof File) {
      if (!backgroundImage.size || backgroundImage.size > maxImageBytes) return jsonError("Background images must be smaller than 20 MB.", 400);
      if (!isImageFile(backgroundImage)) return jsonError("Use a PNG, JPEG, or WebP background image.", 400);
    }
    if (typeof timestampValue !== "string" || timestampValue.length > 20_000) return jsonError("Provide valid timestamped text.", 400);
    if (typeof scriptValue !== "string" || scriptValue.length > 10_000) return jsonError("Script is too long or invalid.", 400);
    if (!validateContentKind(contentKind)) return jsonError("Choose a supported content type.", 400);
    if (!validateVisualStyle(styleValue)) return jsonError("Choose a supported visual style.", 400);
    if (typeof intensityValue !== "string" || !intensities.includes(intensityValue as Intensity)) return jsonError("Choose a supported animation intensity.", 400);
    if (typeof captionPositionValue !== "string" || !captionPositions.includes(captionPositionValue as CaptionPosition)) return jsonError("Choose a supported caption position.", 400);
    if (typeof captionSizeValue !== "string" || !["Small", "Medium", "Large"].includes(captionSizeValue)) return jsonError("Choose a supported caption size.", 400);
    if (typeof backgroundStyleValue !== "string" || !backgroundStyles.includes(backgroundStyleValue as (typeof backgroundStyles)[number])) return jsonError("Choose a supported background style.", 400);
    if (typeof transitionIntensityValue !== "string" || !transitionIntensities.includes(transitionIntensityValue as Intensity)) return jsonError("Choose a supported transition intensity.", 400);
    if (backgroundStyleValue === "Uploaded image" && !(backgroundImage instanceof File)) return jsonError("Upload a background image or choose Generated gradient.", 400);

    const ratio = ratioValue === "16:9" || ratioValue === "1:1" ? ratioValue : ratioValue === "9:16" ? ratioValue : null;
    if (!ratio) return jsonError("Choose a supported aspect ratio.", 400);
    const resolution = resolutionValue === "720p" ? 720 : resolutionValue === "1080p" ? 1080 : null;
    if (!resolution) return jsonError("Choose a supported video resolution.", 400);

    workDirectory = await mkdtemp(path.join(tmpdir(), "motioncraft-render-"));
    const inputPath = path.join(workDirectory, `input${path.extname(audio.name).toLowerCase()}`);
    const imagePath = path.join(workDirectory, `background-image${backgroundImage instanceof File ? path.extname(backgroundImage.name).toLowerCase() : ""}`);
    const outputPath = path.join(workDirectory, "motioncraft-video.mp4");
    await writeUploadedFile(audio, inputPath);
    if (backgroundImage instanceof File) await writeUploadedFile(backgroundImage, imagePath);

    const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    let probe;
    stage = "audio-probe";
    try {
      probe = await runCommand("FFprobe", ffprobePath, [
        "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", inputPath,
      ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      const failure = processErrorDetails(error);
      console.warn(`MotionCraft render command failed: ${JSON.stringify({ requestId, stage, ...failure })}`);
      return commandFailureResponse(stage, failure, requestId);
    }
    let audioMetadata: { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
    try {
      audioMetadata = JSON.parse(probe.stdout);
    } catch {
      return jsonError("The uploaded audio metadata could not be read. Check the MP3 or WAV file.", 400);
    }
    if (!audioMetadata.streams?.some((stream) => stream.codec_type === "audio")) {
      return jsonError("The uploaded file does not contain an audio stream.", 400);
    }
    const duration = Number.parseFloat(audioMetadata.format?.duration ?? "");
    if (!Number.isFinite(duration) || duration <= 0) return jsonError("The uploaded audio could not be read.", 400);
    if (duration > maxAudioSeconds) return jsonError("Audio must be 3 minutes or shorter.", 400);
    if (backgroundImage instanceof File) {
      let imageProbe;
      stage = "image-probe";
      try {
        imageProbe = await runCommand("FFprobe", ffprobePath, [
          "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", imagePath,
        ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
      } catch (error) {
          const failure = processErrorDetails(error);
          console.warn(`MotionCraft render command failed: ${JSON.stringify({ requestId, stage, ...failure })}`);
          return commandFailureResponse(stage, failure, requestId);
        }
        let dimensions: { streams?: Array<{ width?: number; height?: number }> };
        try {
          dimensions = JSON.parse(imageProbe.stdout);
        } catch {
          return jsonError("The uploaded background image metadata could not be read.", 400);
        }
        const imageWidth = dimensions.streams?.[0]?.width ?? 0;
        const imageHeight = dimensions.streams?.[0]?.height ?? 0;
        if (!imageWidth || !imageHeight) return jsonError("The uploaded background image could not be decoded.", 400);
        if (imageWidth * imageHeight > 50_000_000) return jsonError("Background image dimensions exceed 50 megapixels.", 400);
    }

    stage = "scene-setup";
    const captions = timestampValue.trim() ? parseTimedText(timestampValue) : [];
    if (typeof captions === "string") return jsonError(captions, 400);
    for (const [index, caption] of captions.entries()) {
      if (caption.end > duration + 0.05) return jsonError(`Line ${index + 1} ends after the uploaded audio.`, 400);
    }

    let sceneCandidate: unknown;
    if (scenePlanValue) {
      try {
        sceneCandidate = JSON.parse(String(scenePlanValue));
      } catch {
        return jsonError("Scene plan must be valid JSON.", 400);
      }
    } else {
      const fallback = createFallbackPlan({ duration, kind: contentKind, script: scriptValue, timestamps: timestampValue });
      if (typeof fallback === "string") return jsonError(fallback, 400);
      sceneCandidate = fallback.scenes;
    }
    const scenes = validateScenePlan(sceneCandidate, duration);
    if (typeof scenes === "string") return jsonError(scenes, 400);
    if (!captions.length && !scenes.length) return jsonError("Add script text or timestamped text to render.", 400);
    if (captions.length && (
      captions.length !== scenes.length ||
      scenes.some((scene, index) =>
        scene.start !== captions[index].start || scene.end !== captions[index].end || scene.message !== captions[index].text
      )
    )) return jsonError("Timestamped captions must keep their original text and time ranges.", 400);

    const shortSide = resolution;
    const [width, height] = ratio === "16:9"
      ? [shortSide * 16 / 9, shortSide]
      : ratio === "1:1"
        ? [shortSide, shortSide]
        : [shortSide, shortSide * 16 / 9];
    const outputWidth = Math.round(width / 2) * 2;
    const outputHeight = Math.round(height / 2) * 2;
    const theme = themes[styleValue];
    const intensity = intensityValue as Intensity;
    const particleCount = intensity === "Subtle" ? 5 : intensity === "Balanced" ? 9 : 14;
    const rayOpacity = intensity === "Subtle" ? "0.035" : intensity === "Balanced" ? "0.06" : "0.09";
    const particleOpacity = intensity === "Subtle" ? "0.22" : intensity === "Balanced" ? "0.32" : "0.45";
    const speed = intensity === "Subtle" ? "0.004" : intensity === "Balanced" ? "0.009" : "0.018";
    const transitionDuration = transitionIntensityValue === "Subtle" ? 0.2 : transitionIntensityValue === "Balanced" ? 0.45 : 0.75;
    const baseFilters = [
      `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase`,
      `crop=${outputWidth}:${outputHeight}`,
      "setsar=1",
      "format=rgba",
      "noise=alls=4:allf=t+u",
      `drawbox=x='iw*0.38+sin(t*0.31)*iw*0.22':y=0:w=3:h=ih:color=${theme.ray}@${rayOpacity}:t=fill`,
      `drawbox=x='iw*0.7+sin(t*0.19+1)*iw*0.16':y=0:w=2:h=ih:color=${theme.ray}@${rayOpacity}:t=fill`,
    ];
    for (let index = 0; index < particleCount; index += 1) {
      const phase = index * 1.73;
      const x = `iw*${0.08 + (index % 5) * 0.19}+sin(t*${0.3 + (index % 4) * 0.12}+${phase})*iw*0.07`;
      const y = `ih*${0.12 + (index % 7) * 0.11}+sin(t*${0.42 + (index % 3) * 0.11}+${phase})*ih*0.035`;
      baseFilters.push(`drawbox=x='${x}':y='${y}':w=3:h=3:color=${theme.particles}@${particleOpacity}:t=fill`);
    }

    const graph: string[] = [];
    const imageBackground = backgroundStyleValue === "Uploaded image";
    const backgroundInput = imageBackground
      ? ["-loop", "1", "-framerate", "30", "-i", imagePath]
      : [
        "-f", "lavfi", "-i",
        `gradients=size=${outputWidth}x${outputHeight}:rate=30:duration=${duration}:speed=${speed}:type=radial:nb_colors=3:c0=${theme.background[0]}:c1=${theme.background[1]}:c2=${theme.background[2]}`,
      ];
    graph.push(`[0:v]${baseFilters.join(",")}[background]`);
    graph.push(`[1:a]showwaves=s=${outputWidth}x72:mode=line:rate=30:colors=${theme.wave}:scale=sqrt,format=rgba,colorkey=0x000000:0.08:0.04[waveform]`);
    graph.push(`[background][waveform]overlay=x=0:y=${outputHeight - 118}:shortest=1[visuals]`);

    let sourceLabel = "visuals";
    const baseFontSize = resolution === 1080 ? 64 : 44;
    const multiplier = captionSizeValue === "Small" ? 0.8 : captionSizeValue === "Large" ? 1.22 : 1;
    const fontSize = Math.round(baseFontSize * multiplier);
    const textColumnWidth = outputWidth * 0.66;
    const maxCharacters = Math.max(8, Math.floor(textColumnWidth / (fontSize * 0.62)));
    const textColumnX = "w*0.04+(w*0.66-text_w)/2";
    const yPosition = captionY(captionPositionValue as CaptionPosition);
    for (const [index, scene] of scenes.entries()) {
      const enabled = `between(t\\,${scene.start}\\,${scene.end})`;
      const sceneTransition = scene.transition === "cut" ? 0.02 : scene.transition === "dissolve" ? transitionDuration * 1.35 : transitionDuration;
      const fade = Math.min(sceneTransition, (scene.end - scene.start) / 3);
      const fadeEnd = scene.end - fade;
      const alpha = `if(lt(t,${scene.start + fade}),max(0,(t-${scene.start})/${fade}),if(gt(t,${fadeEnd}),max(0,(${scene.end}-t)/${fade}),1))`;
      const sceneFilters = [
        ...sceneBackdropFilters(scene.background, theme, scene.start, scene.end),
        ...graphicFilters(scene.graphic, theme, scene.start, scene.end),
      ];
      const conceptPath = path.join(workDirectory, `concept-${index}.txt`);
      const tagPath = path.join(workDirectory, `tag-${index}.txt`);
      const keywordsPath = path.join(workDirectory, `keywords-${index}.txt`);
      const messagePath = path.join(workDirectory, `message-${index}.txt`);
      await writeFile(conceptPath, wrapText(scene.concept.slice(0, 48), 18), "utf8");
      await writeFile(tagPath, scene.graphic.toUpperCase(), "utf8");
      await writeFile(keywordsPath, wrapText(scene.keywords.slice(0, 3).join(" · "), 18), "utf8");
      await writeFile(messagePath, wrapText(scene.message, maxCharacters), "utf8");
      const sceneFontFile = scene.typography === "mono"
        ? "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
        : scene.typography === "editorial"
          ? "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
          : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

      const transitionFilter = `drawtext=fontfile='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf':textfile='${escapeFilterPath(conceptPath)}':fontcolor=${theme.text}:fontsize=${Math.max(16, Math.round(fontSize * 0.34))}:x='w*0.73+(w*0.21-text_w)/2':y=h*0.42:alpha='${alpha.replaceAll(",", "\\,")}':fix_bounds=1:enable='${enabled}'`;
      const tagFilter = `drawtext=fontfile='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf':textfile='${escapeFilterPath(tagPath)}':fontcolor=${theme.accent}:fontsize=${Math.max(12, Math.round(fontSize * 0.22))}:x='w*0.73+(w*0.21-text_w)/2':y=h*0.77:alpha='${alpha.replaceAll(",", "\\,")}':fix_bounds=1:enable='${enabled}'`;
      const keywordsFilter = `drawtext=fontfile='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf':textfile='${escapeFilterPath(keywordsPath)}':fontcolor=${theme.accent}:fontsize=${Math.max(10, Math.round(fontSize * 0.16))}:x='w*0.73+(w*0.21-text_w)/2':y=h*0.51:alpha='${alpha.replaceAll(",", "\\,")}':fix_bounds=1:enable='${enabled}'`;
      sceneFilters.push(transitionFilter, keywordsFilter, tagFilter);
      if (!captions.length) {
        const sceneFontSize = scene.animation === "pulse" ? `${fontSize}*(1+0.04*sin((t-${scene.start})*4))` : String(fontSize);
        const sceneX = scene.animation === "drift" ? `w*0.04+(w*0.66-text_w)/2+10*sin((t-${scene.start})*1.2)` : textColumnX;
        const rise = scene.animation === "rise" ? "32" : scene.animation === "draw" ? "12" : "0";
        sceneFilters.push(
          `drawtext=fontfile='${sceneFontFile}':textfile='${escapeFilterPath(messagePath)}':fontcolor=${theme.text}:fontsize='${sceneFontSize}':x='${sceneX}':y='${yPosition}+${rise}*(1-min(1,(t-${scene.start})/${fade}))':line_spacing=14:borderw=2:bordercolor=${theme.glow}@0.32:shadowcolor=${theme.glow}@0.85:shadowx=0:shadowy=0:alpha='${alpha.replaceAll(",", "\\,")}':fix_bounds=1:enable='${enabled}'`,
        );
      }
      const outputLabel = `scenevisual${index}`;
      graph.push(`[${sourceLabel}]${sceneFilters.join(",")}[${outputLabel}]`);
      sourceLabel = outputLabel;
    }

    for (const [index, caption] of captions.entries()) {
      const textPath = path.join(workDirectory, `caption-${index}.txt`);
      await writeFile(textPath, wrapText(caption.text, maxCharacters), "utf8");
      const captionScene = scenes[index];
      const sceneTransition = captionScene?.transition === "cut" ? 0.02 : captionScene?.transition === "dissolve" ? transitionDuration * 1.35 : transitionDuration;
      const fade = Math.min(sceneTransition, (caption.end - caption.start) / 3);
      const fadeEnd = caption.end - fade;
      const alpha = `if(lt(t,${caption.start + fade}),max(0,(t-${caption.start})/${fade}),if(gt(t,${fadeEnd}),max(0,(${caption.end}-t)/${fade}),1))`;
      const animation = captionScene?.animation ?? "rise";
      const captionFontFile = captionScene?.typography === "mono"
        ? "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
        : captionScene?.typography === "editorial"
          ? "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
          : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
      const rise = animation === "rise" ? "30" : animation === "draw" ? "12" : "0";
      const captionFontSize = animation === "pulse" ? `${fontSize}*(1+0.04*sin((t-${caption.start})*4))` : String(fontSize);
      const captionX = animation === "drift" ? `w*0.04+(w*0.66-text_w)/2+10*sin((t-${caption.start})*1.2)` : textColumnX;
      const textFilter =
        `drawtext=fontfile='${captionFontFile}':textfile='${escapeFilterPath(textPath)}':fontcolor=${theme.text}:fontsize='${captionFontSize}':x='${captionX}':y='${yPosition}+${rise}*(1-min(1,(t-${caption.start})/${fade}))':line_spacing=14:borderw=2:bordercolor=${theme.glow}@0.32:shadowcolor=${theme.glow}@0.85:shadowx=0:shadowy=0:alpha='${alpha.replaceAll(",", "\\,")}':fix_bounds=1:enable='between(t\\,${caption.start}\\,${caption.end})'`;
      const outputLabel = `captioned${index}`;
      graph.push(`[${sourceLabel}]${textFilter}[${outputLabel}]`);
      sourceLabel = outputLabel;
    }

    const videoInputIndex = 1;
    stage = "ffmpeg";
    const ffmpegArgs = [
      "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", ...backgroundInput,
      "-i", inputPath,
      "-filter_complex", graph.join(";"),
      "-map", `[${sourceLabel}]`, "-map", `${videoInputIndex}:a:0`, "-t", String(duration),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
      "-shortest", "-movflags", "+faststart", "-y", outputPath,
    ];
    if (!enqueueRenderJob(requestId, { executable: ffmpegPath, args: ffmpegArgs, directory: workDirectory, outputPath, duration })) {
      return jsonError("The render job could not be queued. Please retry.", 500);
    }
    jobSubmitted = true;
    return Response.json(getRenderJob(requestId) ?? job, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const failure = processErrorDetails(error);
    if (failure) {
      console.error(`MotionCraft render command failed: ${JSON.stringify({ requestId, stage, ...failure })}`);
      return commandFailureResponse(stage, failure, requestId);
    }
    console.error(`MotionCraft render failed: ${JSON.stringify({
      requestId,
      stage,
      error: error instanceof Error ? error.message : "Unknown rendering error",
    })}`);
    return jsonError(`Rendering failed during ${stage}. Check server diagnostics. Reference: ${requestId}.`, 500);
  } finally {
    if (!jobSubmitted) {
      await removeRenderJob(requestId);
      if (workDirectory) await rm(workDirectory, { recursive: true, force: true });
    }
  }
}
