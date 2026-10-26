import { cancelRenderJob, getRenderJob } from "@/lib/render-jobs";

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
  return Response.json(job, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { jobId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return jsonError("Render job was not found.", 404);

  const cancelled = await cancelRenderJob(jobId);
  if (!cancelled) {
    const job = getRenderJob(jobId);
    if (!job) return jsonError("Render job was not found.", 404);
    return jsonError(`Render job is already ${job.status}.`, 409);
  }
  return Response.json({ cancelled: true }, { headers: { "Cache-Control": "no-store" } });
}
