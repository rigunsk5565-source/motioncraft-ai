const maxAudioBytes = 50 * 1024 * 1024;

type TranscriptionSegment = { start: number; end: number; text: string };

export async function POST(request: Request) {
  const endpoint = process.env.TRANSCRIPTION_API_URL;
  const apiKey = process.env.TRANSCRIPTION_API_KEY;
  const model = process.env.TRANSCRIPTION_MODEL;
  if (!endpoint || !apiKey || !model) {
    return Response.json(
      { error: "Speech-to-text is not configured. Add a transcription provider URL, key, and model on the server." },
      { status: 503 },
    );
  }

  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    if (!(audio instanceof File) || !/\.(mp3|wav)$/i.test(audio.name)) {
      return Response.json({ error: "Upload an MP3 or WAV audio file." }, { status: 400 });
    }
    if (!audio.size || audio.size > maxAudioBytes) {
      return Response.json({ error: "Audio must be smaller than 50 MB." }, { status: 400 });
    }

    const providerForm = new FormData();
    providerForm.set("file", audio);
    providerForm.set("model", model);
    providerForm.set("response_format", "verbose_json");
    providerForm.append("timestamp_granularities[]", "segment");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: providerForm,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      console.error("MotionCraft transcription provider failed:", response.status);
      return Response.json({ error: `Speech-to-text provider returned HTTP ${response.status}.` }, { status: 502 });
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Speech-to-text provider returned an invalid response." }, { status: 502 });
    }
    const result = payload as { text?: unknown; segments?: unknown };
    if (typeof result.text !== "string") {
      return Response.json({ error: "Speech-to-text provider returned no transcript." }, { status: 502 });
    }

    const segments = Array.isArray(result.segments)
      ? result.segments.flatMap((segment): TranscriptionSegment[] => {
        if (!segment || typeof segment !== "object") return [];
        const value = segment as Record<string, unknown>;
        if (
          typeof value.start !== "number" || !Number.isFinite(value.start) ||
          typeof value.end !== "number" || !Number.isFinite(value.end) ||
          typeof value.text !== "string" || value.end <= value.start
        ) return [];
        return [{ start: value.start, end: value.end, text: value.text.trim() }];
      })
      : [];
    return Response.json({ text: result.text, segments });
  } catch (error) {
    console.error("MotionCraft transcription failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Speech-to-text failed." },
      { status: 502 },
    );
  }
}
