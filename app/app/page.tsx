"use client";

import { useEffect, useRef, useState } from "react";

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

export default function Home() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const [script, setScript] = useState("");
  const [timestamps, setTimestamps] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [resolution, setResolution] = useState("1080p");
  const [style, setStyle] = useState("Cinematic");
  const [intensity, setIntensity] = useState("Balanced");
  const [notice, setNotice] = useState("");
  const [noticeKind, setNoticeKind] = useState<"error" | "info">("info");
  const [isRendering, setIsRendering] = useState(false);
  const [renderedVideoUrl, setRenderedVideoUrl] = useState("");
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
    setDuration(null);
    setNotice("");
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
    if (!script.trim()) {
      setNoticeKind("error");
      setNotice("Add a creative script before generating.");
      return;
    }
    const timestampError = validateTimestamps(timestamps);
    if (timestampError) {
      setNoticeKind("error");
      setNotice(timestampError);
      return;
    }
    setIsRendering(true);
    setNoticeKind("info");
    setNotice("Rendering your video with FFmpeg...");
    setRenderedVideoUrl("");

    try {
      const formData = new FormData();
      formData.set("audio", audioFile);
      formData.set("timestamps", timestamps);
      formData.set("aspectRatio", aspectRatio);
      formData.set("resolution", resolution);

      const response = await fetch("/api/render", { method: "POST", body: formData });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error || "Video rendering failed. Try again.");
      }
      if (!response.headers.get("content-type")?.includes("video/mp4")) {
        throw new Error("The renderer returned an unexpected file type.");
      }

      const videoBlob = await response.blob();
      if (!videoBlob.size) throw new Error("The renderer returned an empty video.");
      setRenderedVideoUrl(URL.createObjectURL(videoBlob));
      setNotice("Your MP4 is ready. Preview it here or download the rendered file.");
    } catch (error) {
      setNoticeKind("error");
      setNotice(error instanceof Error ? error.message : "Video rendering failed. Try again.");
    } finally {
      setIsRendering(false);
    }
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
              <div><h2 id="script-heading">Creative direction</h2><p>Describe the world you want to create</p></div>
            </div>
            <label className="visually-hidden" htmlFor="creative-script">Creative direction</label>
            <textarea
              id="creative-script"
              className="script-input"
              value={script}
              onChange={(event) => setScript(event.target.value)}
              placeholder="Create an emotional cinematic lyrics video with elegant typography, dark blue and amber colors, smooth transitions, and subtle particles."
              rows={4}
              maxLength={1000}
              readOnly={isRendering}
            />
            <div className="field-footer"><span>Be specific about mood, color, and movement</span><span>{script.length} / 1,000</span></div>
          </section>

          <section className="form-section" aria-labelledby="timestamps-heading">
            <div className="section-heading">
              <span className="section-number">03</span>
              <div><h2 id="timestamps-heading">Timed moments</h2><p>Match lines to moments in your audio</p></div>
            </div>
            <label className="visually-hidden" htmlFor="timestamps">Timestamp lines</label>
            <textarea
              id="timestamps"
              className="timestamp-input"
              value={timestamps}
              onChange={(event) => { setTimestamps(event.target.value); setRenderedVideoUrl(""); }}
              placeholder={"00:04 - 00:06 | Suno na...\n00:06 - 00:08 | Haan, bolo"}
              rows={3}
              spellCheck={false}
              readOnly={isRendering}
            />
            <div className="field-footer"><span>One moment per line</span><span className="format-hint">MM:SS - MM:SS | caption</span></div>
          </section>

          <section className="form-section settings-section" aria-labelledby="settings-heading">
            <div className="section-heading">
              <span className="section-number">04</span>
              <div><h2 id="settings-heading">Video settings</h2><p>Set the frame and visual language</p></div>
            </div>
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
                <select value={style} onChange={(event) => setStyle(event.target.value)} disabled={isRendering}>
                  <option>Cinematic</option><option>Minimal</option><option>Luxury</option><option>Kinetic Typography</option><option>Neon</option>
                </select>
              </label>
              <label className="setting-group">
                <span>Animation intensity</span>
                <select value={intensity} onChange={(event) => setIntensity(event.target.value)} disabled={isRendering}>
                  <option>Subtle</option><option>Balanced</option><option>Dynamic</option>
                </select>
              </label>
            </div>
          </section>

          <div className="generation-area">
            {notice && <p className={`notice ${noticeKind}`} role="status">{notice}</p>}
            <div className="generation-actions">
              <button className="generate-button" type="button" onClick={handleGenerate} disabled={isRendering}><span aria-hidden="true">{isRendering ? "◌" : "✦"}</span> {isRendering ? "Rendering video..." : "Generate video"}</button>
              <button className="preview-button" type="button" onClick={handlePreview}><span aria-hidden="true">▶</span> {renderedVideoUrl ? "Preview video" : "Preview audio"}</button>
            </div>
            <p className="engine-note"><span className="info-icon" aria-hidden="true">i</span> Local MP4 rendering · up to 3 minutes of audio and 50 MB per file.</p>
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
