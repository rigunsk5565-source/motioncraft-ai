# MotionCraft AI

MotionCraft AI turns uploaded audio and scripts or timestamped captions into
animated MP4 motion graphics. It uses Next.js/TypeScript for the studio and
server-side FFmpeg/FFprobe for video and audio encoding.

## Setup

Install Node.js 20 or newer, FFmpeg/FFprobe, and DejaVu Sans fonts. In GitHub
Codespaces:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-dejavu-core
cd app
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Configure `FFMPEG_PATH`
and `FFPROBE_PATH` on the server if the binaries are not on `PATH`. The renderer
currently references `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`.

## Create videos

Upload an MP3/WAV, select the content type and visual style, then provide a
script, timestamped text (`MM:SS - MM:SS | text`), or both. Click **Plan scenes
for review** to inspect/edit concepts, keywords, and graphic type, then render.
For a script without timestamps, the fallback divides sentences into scenes
and estimates timings by word count. These are estimates, not speech alignment.
When timestamps are supplied, caption wording and timings are validated and
preserved in the render.

Available styles: Cinematic, Educational Explainer, Digital Marketing,
Corporate, Modern Minimal, Kinetic Typography, Luxury, Neon, and Romantic
Lyrics. Style selection changes the encoded palette and other render
properties. Additional render controls include aspect ratio, 720p/1080p,
animation intensity, caption position and size, generated or uploaded-image
background, and transition intensity.

The graphics engine renders rule-selected topic concepts as network, chart,
target, book, heart, idea, or waveform vector-style motifs. It also renders
animated gradient backgrounds, moving rays, particles, scene labels,
typography, per-scene gradient/spotlight/grid backgrounds, and an audio-reactive
waveform. Scene plans define a message, keywords, concept, graphic, background,
typography, animation, and transition. The editor lets users adjust these
fields and scene timing where timestamps are not locked. It does not create
bespoke photorealistic illustrations. Uploaded images are cropped to fill the
canvas.

## Optional external AI and transcription

The app works without API credentials. In that case the scene planner is
explicitly labeled **Rule-based fallback plan**. It derives scene concepts from
the submitted script/captions using simple keyword rules; it does not analyze
audio or claim to understand its meaning.

An optional OpenAI-compatible chat-completions endpoint can create scene plans.
Configure these server-only environment variables:

```text
SCENE_PLANNER_API_URL=https://provider.example/v1/chat/completions
SCENE_PLANNER_API_KEY=server-side-secret
SCENE_PLANNER_MODEL=provider-model-name
```

The server sends the text, content type, and audio duration to this endpoint.
No API key is sent to the browser. External provider pricing, availability, and
data handling apply; review the provider's terms before enabling it. Invalid
provider plans are rejected rather than silently presented as AI output.

Optional audio transcription uses a provider endpoint with an
OpenAI-compatible `/audio/transcriptions` multipart API. Configure:

```text
TRANSCRIPTION_API_URL=https://provider.example/v1/audio/transcriptions
TRANSCRIPTION_API_KEY=server-side-secret
TRANSCRIPTION_MODEL=provider-transcription-model
```

The transcription button sends the uploaded audio to that external service.
Transcription may incur provider charges and may make mistakes; review/edit
returned text and timing before rendering. Without these settings, the
transcription endpoint responds that it is unavailable.

## Limits and checks

- Audio: MP3/WAV, 50 MB maximum, 3 minutes maximum.
- Optional background: PNG/JPEG/WebP, 20 MB maximum.
- Up to 30 scenes; the renderer produces H.264 video and AAC audio.
- FFmpeg rendering has a 5-minute process limit; a deployment platform may
  impose a shorter request limit.
- Render upload and validation return a job ID; the browser polls status and
  FFmpeg progress, then fetches the completed MP4. One FFmpeg render runs at a
  time, with at most three outstanding jobs (including the active job).
- Job state and temporary MP4s are kept in the Next.js process and expire after
  30 minutes. They are not durable: a server/Codespace restart loses queued
  jobs, status, and completed downloads. This queue is intended for a single
  app instance, not horizontally scaled deployments.
- Speech alignment requires the optional transcription provider. Local
  script-only timing is estimated.
- Beat detection and semantic audio analysis are not implemented. The waveform
  is generated from actual audio samples.
- Rendering time depends on resolution, duration, and available CPU. The
  preview and download use a browser-managed Blob URL after the job completes.

Run checks from this directory:

```bash
npm run dev
# In a second terminal, from app/:
npm test
npm run lint
npm run build
```

The render integration tests use synthetic audio and require FFmpeg/FFprobe.
They send requests to `http://localhost:3000` by default; set
`MOTIONCRAFT_TEST_URL` to test another running local instance.
