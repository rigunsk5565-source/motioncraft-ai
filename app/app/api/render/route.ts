import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const maxAudioBytes = 50 * 1024 * 1024;
const maxAudioSeconds = 180;
const timestampPattern = /^(\d{2}):([0-5]\d)\s*-\s*(\d{2}):([0-5]\d)\s*\|\s*(.+)$/;

type Caption = { start: number; end: number; text: string };

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function parseCaptions(value: string): Caption[] | string {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "Add at least one timestamped caption.";

  const captions: Caption[] = [];
  for (const [index, line] of lines.entries()) {
    const match = timestampPattern.exec(line);
    if (!match) return `Line ${index + 1}: use MM:SS - MM:SS | caption.`;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    const text = match[5].trim();
    if (end <= start) return `Line ${index + 1}: the end time must be after the start time.`;
    if (text.length > 180) return `Line ${index + 1}: captions must be 180 characters or fewer.`;
    captions.push({ start, end, text });
  }
  return captions;
}

function wrapCaption(text: string, maxCharacters: number) {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxCharacters && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

function escapeFilterPath(filePath: string) {
  return filePath.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

export async function POST(request: Request) {
  let workDirectory = "";
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    const timestampValue = formData.get("timestamps");
    const ratioValue = formData.get("aspectRatio");
    const resolutionValue = formData.get("resolution");

    if (!(audio instanceof File)) return jsonError("Upload an MP3 or WAV audio file.", 400);
    if (!/\.(mp3|wav)$/i.test(audio.name)) return jsonError("Only MP3 and WAV files are supported.", 400);
    if (!audio.size || audio.size > maxAudioBytes) return jsonError("Audio must be smaller than 50 MB.", 400);
    if (typeof timestampValue !== "string" || timestampValue.length > 20_000) return jsonError("Provide valid timestamped captions.", 400);

    const parsedCaptions = parseCaptions(timestampValue);
    if (typeof parsedCaptions === "string") return jsonError(parsedCaptions, 400);

    const ratio = ratioValue === "16:9" || ratioValue === "1:1" ? ratioValue : "9:16";
    const resolution = resolutionValue === "720p" ? 720 : 1080;
    const shortSide = resolution;
    const [width, height] = ratio === "16:9"
      ? [shortSide * 16 / 9, shortSide]
      : ratio === "1:1"
        ? [shortSide, shortSide]
        : [shortSide, shortSide * 16 / 9];
    const outputWidth = Math.round(width / 2) * 2;
    const outputHeight = Math.round(height / 2) * 2;

    workDirectory = await mkdtemp(path.join(tmpdir(), "motioncraft-render-"));
    const inputPath = path.join(workDirectory, `input${path.extname(audio.name).toLowerCase()}`);
    const outputPath = path.join(workDirectory, "motioncraft-video.mp4");
    await writeFile(inputPath, Buffer.from(await audio.arrayBuffer()));

    const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    const probe = await execFile(ffprobePath, [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath,
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const duration = Number.parseFloat(probe.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) return jsonError("The uploaded audio could not be read.", 400);
    if (duration > maxAudioSeconds) return jsonError("For this local renderer, audio must be 3 minutes or shorter.", 400);

    for (const [index, caption] of parsedCaptions.entries()) {
      if (caption.end > duration + 0.05) return jsonError(`Caption ${index + 1} ends after the uploaded audio.`, 400);
    }

    const maxCharacters = ratio === "9:16" ? 24 : ratio === "1:1" ? 30 : 42;
    const fontSize = resolution === 1080 ? 62 : 42;
    const filters = ["vignette=PI/5", "noise=alls=2:allf=t+u"];
    for (const [index, caption] of parsedCaptions.entries()) {
      const textPath = path.join(workDirectory, `caption-${index}.txt`);
      await writeFile(textPath, wrapCaption(caption.text, maxCharacters), "utf8");
      const fadeDuration = Math.min(0.4, (caption.end - caption.start) / 3);
      const fadeEnd = caption.end - fadeDuration;
      const alpha = `if(lt(t,${caption.start + fadeDuration}),max(0,(t-${caption.start})/${fadeDuration}),if(gt(t,${fadeEnd}),max(0,(${caption.end}-t)/${fadeDuration}),1))`;
      filters.push(
        `drawtext=font='DejaVu Sans':textfile='${escapeFilterPath(textPath)}':fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=18:shadowcolor=black@0.72:shadowx=0:shadowy=3:alpha='${alpha.replaceAll(",", "\\,")}':enable='between(t\\,${caption.start}\\,${caption.end})'`,
      );
    }

    await execFile(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x0b0c14:s=${outputWidth}x${outputHeight}:r=30:d=${duration}`,
      "-i", inputPath, "-vf", filters.join(","), "-map", "0:v:0", "-map", "1:a:0", "-t", String(duration),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
      "-shortest", "-movflags", "+faststart", "-y", outputPath,
    ], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });

    const video = await readFile(outputPath);
    return new Response(new Uint8Array(video), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="motioncraft-video.mp4"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown rendering error";
    console.error("MotionCraft render failed:", details);
    return jsonError("Rendering failed. Confirm FFmpeg and FFprobe are installed, then try again.", 500);
  } finally {
    if (workDirectory) await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}