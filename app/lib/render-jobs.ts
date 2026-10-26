import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { isProcessTimeout } from "@/lib/process-timeout.mjs";

export type RenderJobStatus = "preparing" | "queued" | "running" | "completed" | "failed" | "cancelled";

export type RenderJobSnapshot = {
  id: string;
  status: RenderJobStatus;
  progress: number;
  message: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

type RenderJob = RenderJobSnapshot & {
  directory?: string;
  outputPath?: string;
  child?: ChildProcessByStdio<null, Readable, Readable>;
  cancelRequested?: boolean;
  timeoutRequested?: boolean;
  startedAt?: number;
  stderr: string;
  duration: number;
  renderOptions?: RenderOptions;
  timeout?: NodeJS.Timeout;
  killTimeout?: NodeJS.Timeout;
  expiryTimeout?: NodeJS.Timeout;
};

type RenderOptions = {
  executable: string;
  args: string[];
  directory: string;
  outputPath: string;
  duration: number;
};

type RenderJobRegistry = {
  jobs: Map<string, RenderJob>;
  queue: string[];
  activeJobId: string | null;
};

const maxOutstandingJobs = 3;
const completedJobLifetimeMs = 30 * 60 * 1000;
const renderTimeoutMs = 300_000;
const killGracePeriodMs = 5_000;
const diagnosticLimit = 4_000;

declare global {
  var motionCraftRenderJobRegistry: RenderJobRegistry | undefined;
}

function registry() {
  globalThis.motionCraftRenderJobRegistry ??= {
    jobs: new Map(),
    queue: [],
    activeJobId: null,
  };
  return globalThis.motionCraftRenderJobRegistry;
}

function isTerminal(status: RenderJobStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function snapshot(job: RenderJob): RenderJobSnapshot {
  const { id, status, progress, message, error, createdAt, updatedAt } = job;
  return { id, status, progress, message, error, createdAt, updatedAt };
}

function update(job: RenderJob, patch: Partial<RenderJobSnapshot>) {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

function scheduleExpiry(job: RenderJob) {
  if (job.expiryTimeout) clearTimeout(job.expiryTimeout);
  job.expiryTimeout = setTimeout(() => {
    void removeRenderJob(job.id);
  }, completedJobLifetimeMs);
  job.expiryTimeout.unref();
}

async function cleanupJobFiles(job: RenderJob) {
  if (!job.directory) return;
  const directory = job.directory;
  job.directory = undefined;
  job.outputPath = undefined;
  await rm(directory, { recursive: true, force: true });
}

export function reserveRenderJob() {
  const current = registry();
  for (const [id, job] of current.jobs) {
    if (isTerminal(job.status) && Date.now() - job.updatedAt > completedJobLifetimeMs) {
      void removeRenderJob(id);
    }
  }
  const outstanding = [...current.jobs.values()].filter((job) => !isTerminal(job.status)).length;
  if (outstanding >= maxOutstandingJobs) return null;

  const now = Date.now();
  const job: RenderJob = {
    id: randomUUID(),
    status: "preparing",
    progress: 0,
    message: "Preparing audio and scene data",
    createdAt: now,
    updatedAt: now,
    stderr: "",
    duration: 0,
  };
  current.jobs.set(job.id, job);
  return snapshot(job);
}

export function getRenderJob(id: string) {
  const job = registry().jobs.get(id);
  return job ? snapshot(job) : null;
}

export function getRenderJobVideo(id: string) {
  const job = registry().jobs.get(id);
  if (!job || job.status !== "completed" || !job.outputPath || !job.directory) return null;
  return { path: job.outputPath, directory: job.directory };
}

export async function removeRenderJob(id: string) {
  const current = registry();
  const job = current.jobs.get(id);
  if (!job || job.child) return;
  current.jobs.delete(id);
  current.queue = current.queue.filter((queuedId) => queuedId !== id);
  if (job.timeout) clearTimeout(job.timeout);
  if (job.killTimeout) clearTimeout(job.killTimeout);
  if (job.expiryTimeout) clearTimeout(job.expiryTimeout);
  await cleanupJobFiles(job);
}

function updateProgress(job: RenderJob, line: string) {
  if (line.startsWith("out_time=")) {
    const match = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (!match) return;
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    const progress = Math.min(99, Math.max(job.progress, Math.floor(seconds / job.duration * 100)));
    update(job, { progress, message: `Rendering video · ${progress}%` });
  } else if (line === "progress=end") {
    update(job, { progress: 99, message: "Finalizing MP4" });
  }
}

function logProcessFailure(
  job: RenderJob,
  code: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  spawnError?: Error,
) {
  const diagnostics = JSON.stringify({
    jobId: job.id,
    stage: "ffmpeg",
    code,
    signal,
    killed: Boolean(signal),
    timedOut,
    elapsedMs: Date.now() - (job.startedAt ?? job.createdAt),
    spawnError: spawnError?.message,
    spawnErrorCode: spawnError && "code" in spawnError ? spawnError.code : undefined,
    stderr: job.stderr.slice(-diagnosticLimit),
  });
  console.error(`MotionCraft render job failed: ${diagnostics}`);
}

async function runJob(job: RenderJob, options: RenderOptions) {
  const current = registry();
  update(job, { status: "running", progress: 0, message: "Starting FFmpeg" });
  job.duration = options.duration;
  job.startedAt = Date.now();

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(options.executable, options.args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start FFmpeg.";
    update(job, { status: "failed", error: `Could not start FFmpeg: ${message}`, message: "Render failed" });
    console.error(`MotionCraft render job failed: ${JSON.stringify({
      jobId: job.id,
      stage: "ffmpeg-start",
      elapsedMs: Date.now() - (job.startedAt ?? job.createdAt),
      error: message,
    })}`);
    await cleanupJobFiles(job);
    scheduleExpiry(job);
    return;
  }

  job.child = child;
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) updateProgress(job, line);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    job.stderr = `${job.stderr}${chunk}`.slice(-diagnosticLimit);
  });

  job.timeout = setTimeout(() => {
    job.timeoutRequested = true;
    update(job, { message: "Rendering reached its 5-minute safety limit" });
    child.kill("SIGTERM");
    job.killTimeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, killGracePeriodMs);
    job.killTimeout.unref();
  }, renderTimeoutMs);
  job.timeout.unref();

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, spawnError: error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (job.timeout) clearTimeout(job.timeout);
  if (job.killTimeout) clearTimeout(job.killTimeout);
  job.child = undefined;
  current.activeJobId = null;

  if (job.cancelRequested) {
    update(job, { status: "cancelled", progress: 0, message: "Render cancelled" });
    await cleanupJobFiles(job);
  } else if (job.timeoutRequested || outcome.spawnError || outcome.code !== 0) {
    const timedOut = job.timeoutRequested || isProcessTimeout({
      code: outcome.spawnError && "code" in outcome.spawnError && typeof outcome.spawnError.code === "string"
        ? outcome.spawnError.code
        : null,
      killed: Boolean(outcome.signal),
      signal: outcome.signal,
    });
    const error = timedOut
      ? "Rendering exceeded the 5-minute limit. Try 720p or a shorter audio track."
      : outcome.spawnError
        ? `Could not start FFmpeg: ${outcome.spawnError.message}`
        : "FFmpeg could not render this composition. Check the server diagnostic log.";
    update(job, { status: "failed", error, message: "Render failed" });
    logProcessFailure(job, outcome.code, outcome.signal, timedOut, outcome.spawnError);
    await cleanupJobFiles(job);
  } else {
    try {
      const output = await stat(options.outputPath);
      if (output.size === 0) throw new Error("FFmpeg produced an empty output file.");
      update(job, { status: "completed", progress: 100, message: "MP4 ready" });
    } catch (error) {
      const details = error instanceof Error ? error.message : "Rendered MP4 could not be read.";
      update(job, { status: "failed", error: details, message: "Render failed" });
      console.error(`MotionCraft render job failed: ${JSON.stringify({ jobId: job.id, stage: "output", error: details })}`);
      await cleanupJobFiles(job);
    }
  }

  scheduleExpiry(job);
  pumpQueue();
}

function pumpQueue() {
  const current = registry();
  if (current.activeJobId) return;

  while (current.queue.length) {
    const id = current.queue.shift();
    if (!id) return;
    const job = current.jobs.get(id);
    if (!job || job.status !== "queued" || !job.renderOptions) continue;
    current.activeJobId = id;
    void runJob(job, job.renderOptions).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : "Unexpected render worker error.";
      update(job, { status: "failed", error: message, message: "Render failed" });
      console.error(`MotionCraft render worker failed: ${JSON.stringify({ jobId: job.id, error: message })}`);
      if (current.activeJobId === job.id) current.activeJobId = null;
      job.child = undefined;
      await cleanupJobFiles(job);
      scheduleExpiry(job);
      pumpQueue();
    });
    return;
  }
}

export function enqueueRenderJob(id: string, options: RenderOptions) {
  const job = registry().jobs.get(id);
  if (!job || job.status !== "preparing") return false;
  job.directory = options.directory;
  job.outputPath = options.outputPath;
  job.renderOptions = options;
  update(job, { status: "queued", progress: 0, message: "Waiting for an available render slot" });
  registry().queue.push(id);
  pumpQueue();
  return true;
}

export async function cancelRenderJob(id: string) {
  const current = registry();
  const job = current.jobs.get(id);
  if (!job) return false;
  if (job.status === "queued" || job.status === "preparing") {
    current.queue = current.queue.filter((queuedId) => queuedId !== id);
    update(job, { status: "cancelled", progress: 0, message: "Render cancelled" });
    await cleanupJobFiles(job);
    scheduleExpiry(job);
    return true;
  }
  if (job.status === "running" && job.child) {
    job.cancelRequested = true;
    update(job, { message: "Stopping FFmpeg" });
    job.child.kill("SIGTERM");
    job.killTimeout = setTimeout(() => {
      if (job.child && job.child.exitCode === null && job.child.signalCode === null) job.child.kill("SIGKILL");
    }, killGracePeriodMs);
    job.killTimeout.unref();
    return true;
  }
  return false;
}
