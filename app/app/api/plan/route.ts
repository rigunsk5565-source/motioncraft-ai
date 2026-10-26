import {
  CompatibleChatPlanner,
  createFallbackPlan,
  validateContentKind,
  validateScenePlan,
} from "@/lib/scene-planner";

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object") return jsonError("Provide a scene-planning request.", 400);
    const input = body as Record<string, unknown>;
    const { duration, kind, script, timestamps } = input;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > 180) {
      return jsonError("Provide the uploaded audio duration (up to 180 seconds).", 400);
    }
    if (!validateContentKind(kind)) return jsonError("Choose a supported content type.", 400);
    if (typeof script !== "string" || script.length > 10_000 || typeof timestamps !== "string" || timestamps.length > 20_000) {
      return jsonError("Script or timestamp text is too long or invalid.", 400);
    }

    let candidate: unknown;
    let mode: "fallback" | "external-ai" = "fallback";
    let note: string;
    const configured = Boolean(process.env.SCENE_PLANNER_API_URL && process.env.SCENE_PLANNER_API_KEY && process.env.SCENE_PLANNER_MODEL);
    if (configured) {
      candidate = await new CompatibleChatPlanner().plan({ duration, kind, script, timestamps });
      mode = "external-ai";
      note = "Scene plan created by the configured external AI provider. Review it before rendering.";
    } else {
      const fallback = createFallbackPlan({ duration, kind, script, timestamps });
      if (typeof fallback === "string") return jsonError(fallback, 400);
      candidate = fallback.scenes;
      note = fallback.note;
    }

    const scenes = validateScenePlan(candidate, duration);
    if (typeof scenes === "string") return jsonError(`Scene planner returned an invalid plan: ${scenes}`, 502);
    if (timestamps.trim()) {
      const expected = createFallbackPlan({ duration, kind, script, timestamps });
      if (typeof expected === "string") return jsonError(expected, 400);
      if (
        expected.scenes.length !== scenes.length ||
        scenes.some((scene, index) =>
          scene.start !== expected.scenes[index].start ||
          scene.end !== expected.scenes[index].end ||
          scene.message !== expected.scenes[index].message
        )
      ) return jsonError("Planner must preserve each supplied lyric and timestamp exactly.", 502);
    }
    return Response.json({ scenes, mode, note });
  } catch (error) {
    console.error("MotionCraft scene planning failed:", error);
    return jsonError(error instanceof Error ? error.message : "Scene planning failed.", 502);
  }
}
