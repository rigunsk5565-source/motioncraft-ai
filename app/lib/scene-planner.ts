export const contentKinds = [
  "Song / lyric video",
  "Spoken explanation",
  "Marketing / business",
  "Educational content",
  "Narration / presentation",
] as const;

export const visualStyles = [
  "Cinematic",
  "Educational Explainer",
  "Digital Marketing",
  "Corporate",
  "Modern Minimal",
  "Kinetic Typography",
  "Luxury",
  "Neon",
  "Romantic Lyrics",
] as const;

export const graphicTypes = ["network", "chart", "target", "book", "heart", "idea", "wave"] as const;
export const sceneBackgrounds = ["gradient", "spotlight", "grid"] as const;
export const typographyTypes = ["bold", "editorial", "mono"] as const;

export type ContentKind = (typeof contentKinds)[number];
export type VisualStyle = (typeof visualStyles)[number];
export type GraphicType = (typeof graphicTypes)[number];
export type SceneBackground = (typeof sceneBackgrounds)[number];
export type TypographyType = (typeof typographyTypes)[number];

export type ScenePlan = {
  scenes: Scene[];
  mode: "fallback" | "external-ai";
  note: string;
};

export type Scene = {
  start: number;
  end: number;
  message: string;
  keywords: string[];
  concept: string;
  graphic: GraphicType;
  background: SceneBackground;
  typography: TypographyType;
  animation: "rise" | "drift" | "pulse" | "draw";
  transition: "fade" | "cut" | "dissolve";
};

export type TimedText = { start: number; end: number; text: string };

const timestampPattern = /^(\d{2,3}):([0-5]\d)\s*-\s*(\d{2,3}):([0-5]\d)\s*\|\s*(.+)$/;
const stopWords = new Set([
  "about", "after", "again", "also", "because", "been", "being", "could", "from", "have", "into",
  "just", "more", "most", "over", "some", "than", "that", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "under", "very", "what", "when", "where", "which", "while",
  "with", "would",   "your", "you", "will", "were", "each", "make", "made", "like", "only", "such", "helps", "strong",
  "your", "the", "and", "for", "are", "was", "but", "not", "all", "can", "our", "its", "has",
  "his", "her", "she", "him", "who", "how", "why", "get", "got", "let", "one", "two", "too",
  "out", "off", "now", "new", "use", "used", "using", "you", "we", "i", "a", "an", "of", "to",
  "in", "on", "at", "by", "as", "is", "it", "be", "or", "if", "so", "up",
]);

export function parseTimedText(value: string): TimedText[] | string {
  const lines = value.split("\n").filter((line) => line.trim());
  if (!lines.length) return "Add at least one timestamped line.";
  const scenes: TimedText[] = [];
  for (const [index, line] of lines.entries()) {
    const match = timestampPattern.exec(line.trim());
    if (!match) return `Line ${index + 1}: use MM:SS - MM:SS | text.`;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    const text = match[5];
    if (end <= start) return `Line ${index + 1}: the end time must be after the start time.`;
    if (!text.trim()) return `Line ${index + 1}: add text after the vertical bar.`;
    if (text.length > 180) return `Line ${index + 1}: text must be 180 characters or fewer.`;
    scenes.push({ start, end, text });
  }
  return scenes;
}

export function validateScenePlan(value: unknown, duration: number): Scene[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    return "Scene plan must contain between 1 and 30 scenes.";
  }
  const scenes: Scene[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object") return `Scene ${index + 1} is invalid.`;
    const scene = candidate as Record<string, unknown>;
    if (
      typeof scene.start !== "number" || !Number.isFinite(scene.start) ||
      typeof scene.end !== "number" || !Number.isFinite(scene.end) ||
      scene.start < 0 || scene.end <= scene.start || scene.end > duration + 0.05
    ) return `Scene ${index + 1} has an invalid time range.`;
    if (typeof scene.message !== "string" || !scene.message.trim() || scene.message.length > 240) {
      return `Scene ${index + 1} needs a message of 1–240 characters.`;
    }
    if (typeof scene.concept !== "string" || !scene.concept.trim() || scene.concept.length > 80) {
      return `Scene ${index + 1} needs a visual concept of 1–80 characters.`;
    }
    if (
      !Array.isArray(scene.keywords) || scene.keywords.length > 8 ||
      !scene.keywords.every((word) => typeof word === "string" && word.length <= 40)
    ) return `Scene ${index + 1} has invalid keywords.`;
    if (!graphicTypes.includes(scene.graphic as GraphicType)) return `Scene ${index + 1} has an unsupported graphic type.`;
    if (!sceneBackgrounds.includes(scene.background as SceneBackground)) return `Scene ${index + 1} has an unsupported background.`;
    if (!typographyTypes.includes(scene.typography as TypographyType)) return `Scene ${index + 1} has unsupported typography.`;
    if (!["rise", "drift", "pulse", "draw"].includes(String(scene.animation))) return `Scene ${index + 1} has an unsupported animation.`;
    if (!["fade", "cut", "dissolve"].includes(String(scene.transition))) return `Scene ${index + 1} has an unsupported transition.`;
    scenes.push({
      start: scene.start,
      end: scene.end,
      message: scene.message.trim(),
      concept: scene.concept.trim(),
      keywords: scene.keywords as string[],
      graphic: scene.graphic as GraphicType,
      background: scene.background as SceneBackground,
      typography: scene.typography as TypographyType,
      animation: scene.animation as Scene["animation"],
      transition: scene.transition as Scene["transition"],
    });
  }
  return scenes;
}

function chooseGraphic(text: string, kind: ContentKind): GraphicType {
  const value = text.toLowerCase();
  if (/\b(ai|artificial intelligence|machine learning|neural|algorithm|software|technology|network)\b/.test(value)) return "network";
  if (/\b(growth|sales|revenue|campaign|marketing|customer|audience|conversion|increase|percent|market)\b/.test(value)) return "chart";
  if (/\b(target|goal|reach|customer|audience|brand|focus|community)\b/.test(value)) return "target";
  if (/\b(learn|education|lesson|study|knowledge|science|explain|understand|research)\b/.test(value)) return "book";
  if (/\b(data|digital|technology)\b/.test(value)) return "network";
  if (/\b(love|heart|together|romance|miss|forever|beloved)\b/.test(value) || kind === "Song / lyric video") return "heart";
  if (/\b(idea|creative|imagine|future|story|vision|concept|solve|solution)\b/.test(value)) return "idea";
  return kind === "Marketing / business" ? "target" : kind === "Educational content" ? "book" : "wave";
}

function chooseConcept(text: string, graphic: GraphicType) {
  const value = text.toLowerCase();
  const keywords = extractKeywords(text);
  if (graphic === "network" && /\b(ai|artificial intelligence|machine learning|neural|algorithm)\b/.test(value)) {
    return value.includes("neural") ? "Neural network" : "Artificial intelligence";
  }
  if (graphic === "chart" && /\b(marketing|campaign|audience|customer)\b/.test(value)) return "Campaign · audience growth";
  if (graphic === "chart" && /\b(sales|revenue|conversion)\b/.test(value)) return "Sales · revenue growth";
  if (keywords.length) return keywords.slice(0, 3).join(" · ");
  return ({
    network: "Connected ideas",
    chart: "Growth over time",
    target: "Reach the right audience",
    book: "Explore the key idea",
    heart: "A moment to remember",
    idea: "A new perspective",
    wave: "Your message",
  })[graphic];
}

function extractKeywords(text: string) {
  const words = text.match(/[\p{L}\p{N}-]+/gu) ?? [];
  const seen = new Set<string>();
  return words
    .filter((word) => word.length > 3 && !stopWords.has(word.toLowerCase()))
    .filter((word) => {
      const key = word.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function sceneFromText(start: number, end: number, text: string, kind: ContentKind, index: number): Scene {
  const graphic = chooseGraphic(text, kind);
  const keywords = extractKeywords(text);
  const animations: Scene["animation"][] = ["rise", "drift", "pulse", "draw"];
  return {
    start,
    end,
    message: text,
    keywords,
    concept: chooseConcept(text, graphic),
    graphic,
    background: graphic === "network" ? "grid" : graphic === "heart" ? "spotlight" : "gradient",
    typography: kind === "Song / lyric video" || kind === "Narration / presentation" ? "editorial" : "bold",
    animation: animations[index % animations.length],
    transition: index === 0 ? "fade" : "dissolve",
  };
}

export function createFallbackPlan(input: {
  duration: number;
  kind: ContentKind;
  script: string;
  timestamps: string;
}): ScenePlan | string {
  const { duration, kind, script, timestamps } = input;
  if (timestamps.trim()) {
    const parsed = parseTimedText(timestamps);
    if (typeof parsed === "string") return parsed;
    for (const [index, timed] of parsed.entries()) {
      if (timed.end > duration + 0.05) return `Line ${index + 1} ends after the uploaded audio.`;
    }
    return {
      mode: "fallback",
      note: "Rule-based planning from your timestamped text. Times and wording are preserved; audio meaning was not analyzed.",
      scenes: parsed.map((timed, index) => sceneFromText(timed.start, timed.end, timed.text, kind, index)),
    };
  }

  if (!script.trim()) return "Add timestamped text or a script to plan scenes.";
  const sentences = script.match(/[^.!?\n]+[.!?]?/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= 180) {
      chunks.push(sentence);
      continue;
    }
    const words = sentence.split(/\s+/);
    let chunk = "";
    for (const word of words) {
      if ((chunk ? `${chunk} ${word}` : word).length > 160 && chunk) {
        chunks.push(chunk);
        chunk = word;
      } else chunk = chunk ? `${chunk} ${word}` : word;
    }
    if (chunk) chunks.push(chunk);
  }
  if (chunks.length > 30) return "This script creates more than 30 scenes. Shorten it or combine related sentences.";
  const scenes = chunks;
  if (!scenes.length) return "Add a script to plan scenes.";
  const wordCounts = scenes.map((text) => Math.max(1, text.split(/\s+/).length));
  const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);
  let cursor = 0;
  return {
    mode: "fallback",
    note: "Rule-based plan with estimated scene times. Script wording is preserved; no speech recognition or audio understanding was performed.",
    scenes: scenes.map((text, index) => {
      const start = cursor;
      cursor = index === scenes.length - 1 ? duration : cursor + duration * wordCounts[index] / totalWords;
      return sceneFromText(start, cursor, text, kind, index);
    }),
  };
}

export interface ScenePlannerProvider {
  plan(input: {
    duration: number;
    kind: ContentKind;
    script: string;
    timestamps: string;
  }): Promise<unknown>;
}

export class CompatibleChatPlanner implements ScenePlannerProvider {
  async plan(input: {
    duration: number;
    kind: ContentKind;
    script: string;
    timestamps: string;
  }) {
    const endpoint = process.env.SCENE_PLANNER_API_URL;
    const apiKey = process.env.SCENE_PLANNER_API_KEY;
    const model = process.env.SCENE_PLANNER_MODEL;
    if (!endpoint || !apiKey || !model) throw new Error("Scene-planner API is not configured.");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Create scene plans for a motion graphics video. Return JSON only: {"scenes":[{"start":0,"end":5,"message":"...","keywords":["..."],"concept":"...","graphic":"network|chart|target|book|heart|idea|wave","background":"gradient|spotlight|grid","typography":"bold|editorial|mono","animation":"rise|drift|pulse|draw","transition":"fade|cut|dissolve"}]}. Times must be within the ${input.duration}s audio. Preserve all supplied text and timestamps exactly; never invent transcript or claim audio was analyzed. Maximum 30 scenes; message max 240 chars, concept max 80 chars, keywords max 8.`,
          },
          {
            role: "user",
            content: JSON.stringify({ duration: input.duration, contentKind: input.kind, script: input.script, timestampedText: input.timestamps }),
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Scene-planner provider returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("choices" in payload)) throw new Error("Scene-planner provider returned an unexpected response.");
    const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
    const content = choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Scene-planner provider returned no scene plan.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("Scene-planner provider returned invalid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || !("scenes" in parsed)) throw new Error("Scene-planner provider response is missing scenes.");
    return (parsed as { scenes: unknown }).scenes;
  }
}

export function validateContentKind(value: unknown): value is ContentKind {
  return typeof value === "string" && contentKinds.includes(value as ContentKind);
}

export function validateVisualStyle(value: unknown): value is VisualStyle {
  return typeof value === "string" && visualStyles.includes(value as VisualStyle);
}
