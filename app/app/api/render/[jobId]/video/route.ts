import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { getRenderJob, getRenderJobVideo } from "@/lib/render-jobs";

type RouteContext = { params: Promise<{ jobId: string }> };

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { jobId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return jsonError("Render job was not found.", 404);

  const job = getRenderJob(jobId);
  if (!job) {
    return jsonError("Render job was not found. Jobs are temporary and may be lost when the server restarts.", 404);
  }
  const video = getRenderJobVideo(jobId);
  if (!video) return jsonError(`The MP4 is not available while the job is ${job.status}.`, 409);
  let file: Awaited<ReturnType<typeof stat>>;
  try {
    file = await stat(video.path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return jsonError("The temporary MP4 has expired. Render the video again to download it.", 410);
    }
    throw error;
  }

  let source: ReturnType<typeof createReadStream> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      source = createReadStream(video.path);
      source.on("data", (chunk: string | Buffer) => {
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
      });
      source.on("end", () => controller.close());
      source.on("error", (error) => controller.error(error));
    },
    cancel() {
      source?.destroy();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="motioncraft-video.mp4"',
      "Content-Length": String(file.size),
      "Cache-Control": "no-store",
    },
  });
}
