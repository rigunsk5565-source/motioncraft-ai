"use client";

import { useEffect, useRef, useState } from "react";
import {
  contentKinds,
  visualStyles,
  type ContentKind,
  type Scene,
  type ScenePlan,
  type VisualStyle,
} from "@/lib/scene-planner";

type AspectRatio = "9:16" | "16:9" | "1:1";

const timestampPattern = /^(\d{2}):([0-5]\d)\s*-\s*(\d{2}):([0-5]\d)\s*\|\s*(.+)$/;

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "--:--";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function validateTimestamps(value: string) {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "Add at least one timestamp before continuing.";

  for (const [index, line] of lines.entries()) {
    const match = timestampPattern.exec(line);
    if (!match) return `Line ${index + 1}: use MM:SS - MM:SS | caption.`;

    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (end <= start) return `Line ${index + 1}: the end time must be after the start time.`;
    if (!match[5].trim()) return `Line ${index + 1}: add caption text after the vertical bar.`;
  }

  return "";
}

function formatStamp(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export default function Home() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [backgroundImage, setBackgroundImage] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const [script, setScript] = useState("");
  const [timestamps, setTimestamps] = useState("");
  const [contentKind, setContentKind] = useState<ContentKind>("Song / lyric video");
  const [scenePlan, setScenePlan] = useState<ScenePlan | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [resolution, setResolution] = useState("1080p");
  const [style, setStyle] = useState<VisualStyle>("Romantic Lyrics");
  const [intensity, setIntensity] = useState("Balanced");
  const [captionPosition, setCaptionPosition] = useState("Upper-middle");
  const [captionSize, setCaptionSize] = useState("Medium");
  const [backgroundStyle, setBackgroundStyle] = useState("Generated gradient");
  const [transitionIntensity, setTransitionIntensity] = useState("Balanced");
  const [notice, setNotice] = useState("");
  const [noticeKind, setNoticeKind] = useState<"error" | "info">("info");
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderMessage, setRenderMessage] = useState("");
  const [activeRenderJobId, setActiveRenderJobId] = useState("");
  const [renderedVideoUrl, setRenderedVideoUrl] = useState("");
  const [isPlanning, setIsPlanning] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  useEffect(() => {
    return () => {
      if (renderedVideoUrl) URL.revokeObjectURL(renderedVideoUrl);
    };
  }, [renderedVideoUrl]);

  function handleAudioChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const isSupported = /\.(mp3|wav)$/i.test(file.name) || ["audio/mpeg", "audio/wav", "audio/x-wav"].includes(file.type);
    if (!isSupported) {
      setNoticeKind("error");
      setNotice("Choose an MP3 or WAV audio file.");
      event.target.value = "";
      return;
    }
    setAudioFile(file);
    setAudioUrl(URL.createObjectURL(file));
    setRenderedVideoUrl("");
    setScenePlan(null);
    setDuration(null);
    setNotice("");
  }

  function handleBackgroundImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const isSupported = /\.(png|jpe?g|webp)$/i.test(file.name)
      && ["image/png", "image/jpeg", "image/webp"].includes(file.type);
    if (!isSupported) {
      setNoticeKind("error");
      setNotice("Choose a PNG, JPEG, or WebP background image.");
      event.target.value = "";
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setNoticeKind("error");
      setNotice("Background images must be smaller than 20 MB.");
      event.target.value = "";
      return;
    }
    setBackgroundImage(file);
    setBackgroundStyle("Uploaded image");
    setRenderedVideoUrl("");
    setScenePlan(null);
    setNotice("");
  }

  async function requestScenePlan() {
    if (!duration || !Number.isFinite(duration)) throw new Error("Wait for the uploaded audio duration to load.");
    if (!script.trim() && !timestamps.trim()) throw new Error("Add a script or timestamped text before planning scenes.");
    if (timestamps.trim()) {
      const timestampError = validateTimestamps(timestamps);
      if (timestampError) throw new Error(timestampError);
    }
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration, kind: contentKind, script, timestamps }),
    });
    const result = await response.json() as ScenePlan | { error?: string };
    if (!response.ok || !("scenes" in result)) throw new Error("error" in result ? result.error || "Scene planning failed." : "Scene planning failed.");
    setScenePlan(result);
    return result;
  }

  async function handlePlanScenes() {
    if (!audioFile) {
      setNoticeKind("error");
      setNotice("Upload an audio file before planning scenes.");
      return;
    }
    setIsPlanning(true);
    setNoticeKind("info");
    setNotice("Planning scenes from the supplied script...");
    try {
      await requestScenePlan();
      setNotice("Scene plan is ready to review and edit before rendering.");
    } catch (error) {
      setNoticeKind("error");
      setNotice(error instanceof Error ? error.message : "Scene planning failed.");
    } finally {
      setIsPlanning(false);
    }
  }

  async function handleTranscribe() {
    if (!audioFile) {
      setNoticeKind("error");
      setNotice("Upload an audio file before requesting transcription.");
      return;
    }
    setIsTranscribing(true);
    setNoticeKind("info");
    setNotice("Sending audio to the configured speech-to-text provider...");
    try {
      const formData = new FormData();
      formData.set("audio", audioFile);
      const response = await fetch("/api/transcribe", { method: "POST", body: formData });
      const result = await response.json() as {
        error?: string;
        text?: string;
        segments?: Array<{ start: number; end: number; text: string }>;
      };
      if (!response.ok) throw new Error(result.error || "Transcription failed.");
      const segments = result.segments ?? [];
      if (segments.length) {
        setTimestamps(segments.map((segment) =>
          `${formatStamp(segment.start)} - ${formatStamp(Math.max(segment.end, segment.start + 1))} | ${segment.text}`,
        ).join("\n"));
      } else if (result.text) setScript(result.text);
      else throw new Error("Transcription provider returned no usable text.");
      setScenePlan(null);
      setRenderedVideoUrl("");
      setNotice("Transcript received. Review and edit it before planning scenes.");
    } catch (error) {
      setNoticeKind("error");
      setNotice(error instanceof Error ? error.message : "Transcription failed.");
    } finally {
      setIsTranscribing(false);
    }
  }

  function handlePreview() {
    if (renderedVideoUrl && videoRef.current) {
      if (videoRef.current.paused) void videoRef.current.play();
      else videoRef.current.pause();
      return;
    }
    if (!audioFile || !audioRef.current) {
      setNoticeKind("error");
      setNotice("Upload an audio file to preview your composition.");
      return;
    }
    setNoticeKind("info");
    setNotice("Playing the uploaded audio. Render a video to preview the finished composition.");
    if (audioRef.current.paused) void audioRef.current.play();
    else audioRef.current.pause();
  }

  async function handleGenerate() {
    if (isRendering) return;
    if (!audioFile) {
      setNoticeKind("error");
      setNotice("Upload an MP3 or WAV file before generating.");
      return;
    }
    if (!script.trim() && !timestamps.trim()) {
      setNoticeKind("error");
      setNotice("Add a script or timestamped text before generating.");
      return;
    }
    if (timestamps.trim()) {
      const timestampError = validateTimestamps(timestamps);
      if (timestampError) {
        setNoticeKind("error");
        setNotice(timestampError);
        return;
      }
    }
    setIsRendering(true);
    setRenderProgress(0);
    setRenderMessage("Preparing audio and scene data");
    setNoticeKind("info");
    setNotice("Uploading your project and starting a background render...");
    setRenderedVideoUrl("");

    try {
      const activePlan = scenePlan ?? await requestScenePlan();
      const formData = new FormData();
      formData.set("audio", audioFile);
      formData.set("timestamps", timestamps);
      formData.set("script", script);
      formData.set("contentKind", contentKind);
      formData.set("scenePlan", JSON.stringify(activePlan.scenes));
      formData.set("aspectRatio", aspectRatio);
      formData.set("resolution", resolution);
      formData.set("style", style);
      formData.set("intensity", intensity);
      formData.set("captionPosition", captionPosition);
      formData.set("captionSize", captionSize);
      formData.set("backgroundStyle", backgroundStyle);
      formData.set("transitionIntensity", transitionIntensity);
      if (backgroundImage) formData.set("backgroundImage", backgroundImage);

      const response = await fetch("/api/render", { method: "POST", body: formData });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error || `Video rendering failed (HTTP ${response.status}). Check the server logs if this continues.`);
      }
      const job = await response.json() as { id?: string; error?: string };
      if (!job.id) throw new Error(job.error || "The renderer did not return a render job ID.");
      setActiveRenderJobId(job.id);

      while (true) {
        const statusResponse = await fetch(`/api/render/${job.id}`, { cache: "no-store" });
        const status = await statusResponse.json() as {
          status?: string;
          progress?: number;
          message?: string;
          error?: string;
        };
        if (!statusResponse.ok) throw new Error(status.error || `Could not check render status (HTTP ${statusResponse.status}).`);
        setRenderProgress(status.progress ?? 0);
        setRenderMessage(status.message ?? "Rendering");

        if (status.status === "failed") throw new Error(status.error || "FFmpeg could not render this composition.");
        if (status.status === "cancelled") throw new Error("Render cancelled.");
        if (status.status === "completed") break;
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }

      const videoResponse = await fetch(`/api/render/${job.id}/video`, { cache: "no-store" });
      if (!videoResponse.ok) {
        const result = await videoResponse.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error || `The rendered MP4 could not be downloaded (HTTP ${videoResponse.status}).`);
      }
      const videoBlob = await videoResponse.blob();
      if (!videoBlob.size) throw new Error("The renderer returned an empty video.");
      setRenderedVideoUrl(URL.createObjectURL(videoBlob));
      setRenderProgress(100);
      setRenderMessage("MP4 ready");
      setNoticeKind("info");
      setNotice("Your MP4 is ready. Preview it here or download the rendered file.");
    } catch (error) {
      setNoticeKind("error");
      setNotice(error instanceof Error ? error.message : "Video rendering failed. Try again.");
    } finally {
      setIsRendering(false);
      setActiveRenderJobId("");
    }
  }

  async function handleCancelRender() {
    if (!activeRenderJobId) return;
    try {
      const response = await fetch(`/api/render/${activeRenderJobId}`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error || `Could not cancel the render (HTTP ${response.status}).`);
      }
      setRenderMessage("Stopping FFmpeg...");
    } catch (error) {
      setNoticeKind("error");
      setNotice(error instanceof Error ? error.message : "Could not cancel the render.");
    }
  }

  function updateScene(index: number, patch: Partial<Scene>) {
    setScenePlan((current) => current
      ? { ...current, scenes: current.scenes.map((scene, sceneIndex) => sceneIndex === index ? { ...scene, ...patch } : scene) }
      : current);
    setRenderedVideoUrl("");
  }

  return (
    <main className="studio-shell">
      <header className="topbar">
        <a className="brand" href="#main" aria-label="MotionCraft AI home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>motioncraft<span className="brand-ai"> AI</span></span>
        </a>
        <div className="topbar-right">
          <span className="engine-status"><span className="status-dot ready" /> Local FFmpeg renderer</span>
          <button className="avatar" type="button" aria-label="Account">MC</button>
        </div>
      </header>

      <div className="workspace" id="main">
        <section className="editor-column" aria-labelledby="page-title">
          <div className="page-heading">
            <div>
              <p className="eyebrow">MOTION STUDIO <span> / </span> NEW PROJECT</p>
              <h1 id="page-title">New composition</h1>
              <p className="heading-copy">Shape the sound into something you can see.</p>
            </div>
            <span className="project-tag"><span className="project-dot" /> Untitled project</span>
          </div>

          <section className="form-section audio-section" aria-labelledby="audio-heading">
            <div className="section-heading">
              <span className="section-number">01</span>
              <div><h2 id="audio-heading">Audio source</h2><p>Start with a track</p></div>
            </div>
            <label className={`upload-zone${audioFile ? " has-file" : ""}`} htmlFor="audio-upload">
              <span className="upload-icon" aria-hidden="true">♫</span>
              <span className="upload-copy">
                <strong>{audioFile ? audioFile.name : "Drop your audio here"}</strong>
                <span>{audioFile ? `${formatDuration(duration ?? NaN)} · ${audioFile.type || "Audio file"}` : "MP3 or WAV · Choose a file to begin"}</span>
              </span>
              <span className="browse-button">{audioFile ? "Replace" : "Browse"}</span>
              <input id="audio-upload" type="file" accept=".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav" onChange={handleAudioChange} disabled={isRendering} />
            </label>
            {audioUrl && (
              <div className="audio-player">
                <span className="audio-wave" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>
                <audio ref={audioRef} src={audioUrl} controls preload="metadata" onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} aria-label="Uploaded audio playback" />
              </div>
            )}
          </section>

          <section className="form-section" aria-labelledby="script-heading">
            <div className="section-heading">
              <span className="section-number">02</span>
              <div><h2 id="script-heading">Content script</h2><p>Use a script, or add exact timed lines below</p></div>
            </div>
            <label className="setting-group content-kind">
              <span>Content type</span>
              <select value={contentKind} onChange={(event) => { setContentKind(event.target.value as ContentKind); setScenePlan(null); setRenderedVideoUrl(""); }} disabled={isRendering}>
                {contentKinds.map((kind) => <option key={kind}>{kind}</option>)}
              </select>
            </label>
            <label className="visually-hidden" htmlFor="creative-script">Creative direction</label>
            <textarea
              id="creative-script"
              className="script-input"
              value={script}
              onChange={(event) => { setScript(event.target.value); setScenePlan(null); setRenderedVideoUrl(""); }}
              placeholder="Paste your narration or script. Without timestamps, scenes get estimated timings; speech alignment needs the optional transcription service."
              rows={4}
              maxLength={10_000}
              readOnly={isRendering}
            />
            <div className="field-footer"><span>Script text is not changed unless you edit the scene plan</span><span>{script.length} / 10,000</span></div>
            <button className="transcribe-button" type="button" onClick={handleTranscribe} disabled={isTranscribing || isRendering || !audioFile}>
              {isTranscribing ? "Transcribing audio..." : "Transcribe audio (external service)"}
            </button>
          </section>

          <section className="form-section" aria-labelledby="timestamps-heading">
            <div className="section-heading">
              <span className="section-number">03</span>
              <div><h2 id="timestamps-heading">Timed text</h2><p>Provided timestamped lines are preserved exactly</p></div>
            </div>
            <label className="visually-hidden" htmlFor="timestamps">Timestamp lines</label>
            <textarea
              id="timestamps"
              className="timestamp-input"
              value={timestamps}
              onChange={(event) => { setTimestamps(event.target.value); setScenePlan(null); setRenderedVideoUrl(""); }}
              placeholder={"00:04 - 00:06 | Suno na...\n00:06 - 00:08 | Haan, bolo"}
              rows={3}
              spellCheck={false}
              readOnly={isRendering}
            />
            <div className="field-footer"><span>Optional · one caption or lyric per line</span><span className="format-hint">MM:SS - MM:SS | text</span></div>
            <button className="plan-button" type="button" onClick={handlePlanScenes} disabled={isPlanning || isRendering || !audioFile}>
              {isPlanning ? "Planning scenes..." : "Plan scenes for review"}
            </button>
            <p className="fallback-note">Without server AI credentials, planning uses a clearly labeled rule-based content fallback. It does not analyze audio.</p>
            {scenePlan && (
              <section className="scene-plan" aria-label="Editable scene plan">
                <div className="scene-plan-header">
                  <div><strong>{scenePlan.mode === "fallback" ? "Rule-based fallback plan" : "External AI scene plan"}</strong><span>{scenePlan.scenes.length} scenes · review before render</span></div>
                  <button type="button" onClick={() => setScenePlan(null)} disabled={isRendering}>Discard</button>
                </div>
                <p className="scene-plan-note">{scenePlan.note}</p>
                {scenePlan.scenes.map((scene, index) => (
                  <article className="scene-card" key={`${scene.start}-${index}`}>
                    <div className="scene-card-top">
                      <span>SCENE {String(index + 1).padStart(2, "0")}</span>
                      <span>{formatDuration(scene.start)}–{formatDuration(scene.end)}</span>
                    </div>
                    {!timestamps.trim() && (
                      <div className="scene-field-row">
                        <label><span>Start seconds</span><input type="number" min="0" max={duration ?? undefined} step="0.1" value={scene.start} onChange={(event) => { if (event.target.value !== "") updateScene(index, { start: Number(event.target.value) }); }} readOnly={isRendering} /></label>
                        <label><span>End seconds</span><input type="number" min="0" max={duration ?? undefined} step="0.1" value={scene.end} onChange={(event) => { if (event.target.value !== "") updateScene(index, { end: Number(event.target.value) }); }} readOnly={isRendering} /></label>
                      </div>
                    )}
                    <label>
                      <span>Message{timestamps.trim() ? " · timestamp text locked" : ""}</span>
                      <textarea value={scene.message} onChange={(event) => updateScene(index, { message: event.target.value })} readOnly={isRendering || Boolean(timestamps.trim())} maxLength={240} rows={2} />
                    </label>
                    <div className="scene-field-row">
                      <label><span>Visual concept</span><input value={scene.concept} onChange={(event) => updateScene(index, { concept: event.target.value })} readOnly={isRendering} maxLength={80} /></label>
                      <label><span>Graphic</span><select value={scene.graphic} onChange={(event) => updateScene(index, { graphic: event.target.value as Scene["graphic"] })} disabled={isRendering}>{["network", "chart", "target", "book", "heart", "idea", "wave"].map((graphic) => <option key={graphic}>{graphic}</option>)}</select></label>
                    </div>
                    <div className="scene-field-row">
                      <label><span>Animation</span><select value={scene.animation} onChange={(event) => updateScene(index, { animation: event.target.value as Scene["animation"] })} disabled={isRendering}>{["rise", "drift", "pulse", "draw"].map((animation) => <option key={animation}>{animation}</option>)}</select></label>
                      <label><span>Transition</span><select value={scene.transition} onChange={(event) => updateScene(index, { transition: event.target.value as Scene["transition"] })} disabled={isRendering}>{["fade", "cut", "dissolve"].map((transition) => <option key={transition}>{transition}</option>)}</select></label>
                    </div>
                    <div className="scene-field-row">
                      <label><span>Scene background</span><select value={scene.background} onChange={(event) => updateScene(index, { background: event.target.value as Scene["background"] })} disabled={isRendering}>{["gradient", "spotlight", "grid"].map((background) => <option key={background}>{background}</option>)}</select></label>
                      <label><span>Typography</span><select value={scene.typography} onChange={(event) => updateScene(index, { typography: event.target.value as Scene["typography"] })} disabled={isRendering}>{["bold", "editorial", "mono"].map((typography) => <option key={typography}>{typography}</option>)}</select></label>
                    </div>
                    <label className="scene-keywords"><span>Keywords · comma separated</span><input value={scene.keywords.join(", ")} onChange={(event) => updateScene(index, { keywords: event.target.value.split(",").map((word) => word.trim()).filter(Boolean).slice(0, 8) })} readOnly={isRendering} /></label>
                  </article>
                ))}
              </section>
            )}
          </section>

          <section className="form-section settings-section" aria-labelledby="settings-heading">
            <div className="section-heading">
              <span className="section-number">04</span>
              <div><h2 id="settings-heading">Video settings</h2><p>Set the frame and visual language</p></div>
            </div>
            <label className={`upload-zone background-upload${backgroundImage ? " has-file" : ""}`} htmlFor="background-upload">
              <span className="upload-icon" aria-hidden="true">▧</span>
              <span className="upload-copy">
                <strong>{backgroundImage ? backgroundImage.name : "Add a background image (optional)"}</strong>
                <span>PNG, JPEG, or WebP · up to 20 MB</span>
              </span>
              <span className="browse-button">{backgroundImage ? "Replace" : "Browse"}</span>
              <input id="background-upload" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" onChange={handleBackgroundImageChange} disabled={isRendering} />
            </label>
            {backgroundImage && (
              <button
                className="clear-background"
                type="button"
                onClick={() => { setBackgroundImage(null); setBackgroundStyle("Generated gradient"); setRenderedVideoUrl(""); }}
                disabled={isRendering}
              >
                Remove background image
              </button>
            )}
            <div className="settings-grid">
              <fieldset className="setting-group">
                <legend>Aspect ratio</legend>
                <div className="segmented-control">
                  {(["9:16", "16:9", "1:1"] as const).map((ratio) => (
                    <button key={ratio} type="button" className={aspectRatio === ratio ? "selected" : ""} onClick={() => { setAspectRatio(ratio); setRenderedVideoUrl(""); }} aria-pressed={aspectRatio === ratio} disabled={isRendering}>{ratio}</button>
                  ))}
                </div>
              </fieldset>
              <label className="setting-group">
                <span>Resolution</span>
                <select value={resolution} onChange={(event) => { setResolution(event.target.value); setRenderedVideoUrl(""); }} disabled={isRendering}>
                  <option>720p</option><option>1080p</option>
                </select>
              </label>
              <label className="setting-group">
                <span>Visual style</span>
                <select value={style} onChange={(event) => { setStyle(event.target.value as VisualStyle); setRenderedVideoUrl(""); }} disabled={isRendering}>
                  {visualStyles.map((visualStyle) => <option key={visualStyle}>{visualStyle}</option>)}
                </select>
              </label>
              <label className="setting-group">
                <span>Animation intensity</span>
                <select value={intensity} onChange={(event) => { setIntensity(event.target.value); setRenderedVideoUrl(""); }} disabled={isRendering}>
                  <option>Subtle</option><option>Balanced</option><option>Dynamic</option>
                </select>
              </label>
              <label className="setting-group">
                <span>Background style</span>
                <select value={backgroundStyle} onChange={(event) => { setBackgroundStyle(event.target.value); setRenderedVideoUrl(""); }} disabled={isRendering}>
                  <option>Generated gradient</option><option>Uploaded image</option>
                </select>
              </label>
              <label className="setting-group">
                <span>Transition intensity</span>
                <select value={transitionIntensity} onChange={(event) => { setTransitionIntensity(event.target.value); setRenderedVideoUrl(""); }} disabled={isRendering}>
                  <option>Subtle</option><option>Balanced</option><option>Dynamic</option>
                </select>
              </label>
              <label className="setting-group">
                <span>Caption position</span>
                <select value={captionPosition} onChange={(event) => { setCaptionPosition(event.target.value); setRenderedVideoUrl(""); }} disabled={isRendering}>
                  <option>Upper-middle</option><option>Center</option><option>Lower-middle</option>
                </select>
              </label>
              <label className="setting-group">
                <span>Caption size</span>
                <select value={captionSize} onChange={(event) => { setCaptionSize(event.target.value); setRenderedVideoUrl(""); }} disabled={isRendering}>
                  <option>Small</option><option>Medium</option><option>Large</option>
                </select>
              </label>
            </div>
          </section>

          <div className="generation-area">
            {notice && <p className={`notice ${noticeKind}`} role="status">{notice}</p>}
            <div className="generation-actions">
              <button className="generate-button" type="button" onClick={handleGenerate} disabled={isRendering}><span aria-hidden="true">{isRendering ? "◌" : "✦"}</span> {isRendering ? "Rendering video..." : "Generate video"}</button>
              {isRendering && <button className="cancel-render-button" type="button" onClick={handleCancelRender} disabled={!activeRenderJobId}>Cancel render</button>}
              <button className="preview-button" type="button" onClick={handlePreview}><span aria-hidden="true">▶</span> {renderedVideoUrl ? "Preview video" : "Preview audio"}</button>
            </div>
            {isRendering && (
              <div className="render-progress" role="status">
                <div className="render-progress-label"><span>{renderMessage || "Preparing render"}</span><span>{renderProgress}%</span></div>
                <progress max="100" value={renderProgress} aria-label="Video render progress" />
              </div>
            )}
            <p className="engine-note"><span className="info-icon" aria-hidden="true">i</span> Local MP4 rendering · up to 3 minutes of audio, 50 MB per track, and 20 MB per image.</p>
          </div>
        </section>

        <aside className="preview-column" aria-label="Composition preview">
          <div className="preview-header">
            <div><p className="eyebrow">CANVAS</p><h2>Preview</h2></div>
            <span className={`canvas-state${renderedVideoUrl ? " has-render" : ""}`}><span className="status-dot" /> {renderedVideoUrl ? "Rendered" : isRendering ? "Rendering" : "No render"}</span>
          </div>
          <div className="canvas-wrap">
            <div className={`preview-frame ratio-${aspectRatio.replace(":", "-")}`} aria-busy={isRendering}>
              <div className="frame-grid" aria-hidden="true" />
              <div className="frame-glow glow-one" aria-hidden="true" />
              <div className="frame-glow glow-two" aria-hidden="true" />
              {renderedVideoUrl ? (
                <video ref={videoRef} className="rendered-video" src={renderedVideoUrl} controls playsInline aria-label="Rendered MotionCraft video preview" />
              ) : (
                <>
                  <div className="frame-content">
                    <span className="frame-mark" aria-hidden="true"><i /><i /><i /></span>
                    <span className="frame-placeholder">Your composition<br />will appear here</span>
                    <span className="frame-subtitle">Add a track and brief to begin</span>
                  </div>
                  <button className="canvas-play" type="button" onClick={handlePreview} aria-label="Preview uploaded audio"><span aria-hidden="true">▶</span></button>
                </>
              )}
              <div className="frame-corner corner-tl" /><div className="frame-corner corner-tr" /><div className="frame-corner corner-bl" /><div className="frame-corner corner-br" />
              <span className="frame-ratio">{aspectRatio}</span>
            </div>
          </div>
          <div className="timeline">
            <div className="timeline-top"><span>00:00</span><span>{duration ? formatDuration(duration) : "--:--"}</span></div>
            <div className="timeline-track"><span className="timeline-progress" /><span className="timeline-marker marker-one" /><span className="timeline-marker marker-two" /><span className="timeline-marker marker-three" /></div>
            <div className="timeline-label"><span className="timeline-playhead" /> TIMELINE <span className="timeline-lines">{timestamps.split("\n").filter((line) => line.trim()).length} MOMENTS</span></div>
          </div>
          <div className="export-row">
            <div className="export-copy"><span className="export-icon" aria-hidden="true">↓</span><span><strong>Export video</strong><small>MP4 · {resolution}</small></span></div>
            {renderedVideoUrl ? (
              <a className="download-button available" href={renderedVideoUrl} download="motioncraft-video.mp4">Download MP4</a>
            ) : (
              <button className="download-button" type="button" disabled title="Render a video before downloading">Download MP4</button>
            )}
          </div>
          <div className="preview-meta"><span>VISUAL STYLE <strong>{style}</strong></span><span>INTENSITY <strong>{intensity}</strong></span></div>
        </aside>
      </div>
      <footer className="studio-footer"><span>MotionCraft AI <span className="footer-separator">/</span> Creative workspace</span><span>Built for the moments between notes.</span></footer>
    </main>
  );
}
