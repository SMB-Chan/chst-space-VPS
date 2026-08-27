import type OpenAI from "openai";
import {
  applyGenerationParams,
  applySafeGenerationParams,
  isUnsupportedGenerationParam,
  type ModelProvider,
} from "./ai-clients";
import {
  ALIBABA_CAPABILITY_DEFAULTS,
  modelHasAlibabaCapability,
} from "./alibaba-capabilities";
import { QWEN_AUDIO_TTS_PLUS_VOICES } from "./alibaba-tts";
import { logger } from "./logger";

export type CapabilityToolPlan =
  | { tool: "none" }
  | {
      tool: "image.generate" | "image.edit";
      prompt: string;
      modelId?: string;
      imageName?: string;
      size?: string;
      n?: number;
    }
  | {
      tool: "audio.transcribe";
      attachmentName: string;
      modelId?: string;
      languageHints?: string[];
    }
  | {
      tool: "audio.synthesize";
      text: string;
      modelId?: string;
      voice?: (typeof QWEN_AUDIO_TTS_PLUS_VOICES)[number];
      instruction?: string;
      languageHint?: "zh" | "en";
      rate?: number;
      pitch?: number;
      volume?: number;
    };

const IMAGE_INTENT =
  /(?:画像|イラスト|絵|写真|image|illustration|picture|photo).{0,60}(?:生成|作(?:って|成)|描(?:いて|画)|編集|加工|修正|変換|generate|create|draw|edit|make)|(?:生成|作(?:って|成)|描(?:いて|画)|編集|加工|修正|変換|generate|create|draw|edit|make).{0,60}(?:画像|イラスト|絵|写真|image|illustration|picture|photo)/i;
const TRANSCRIBE_INTENT =
  /(?:音声|録音|音源|audio|voice|recording).{0,60}(?:認識|文字起こし|書き起こし|transcri(?:be|ption)|speech.?to.?text)|(?:認識|文字起こし|書き起こし|transcri(?:be|ption)|speech.?to.?text).{0,60}(?:音声|録音|音源|audio|voice|recording)/i;
const TTS_INTENT =
  /(?:読み上げ|音声化|音声に(?:して|する)|声に(?:して|する)|テキスト.*音声|read.{0,20}(?:aloud|out loud)|voiceover|text.?to.?speech|\btts\b|synthesi[sz]e.{0,20}(?:speech|voice)|(?:speech|voice).{0,20}synthesi[sz]e)/i;

const ROUTER_SYSTEM_PROMPT = `You are Chat Space's capability router. Decide whether the user's CURRENT request explicitly asks the application to use a specialist capability now.
Return exactly one JSON object and nothing else.

Allowed forms:
{"tool":"none"}
{"tool":"image.generate","prompt":"...","modelId":"optional","size":"optional WIDTH*HEIGHT","n":1}
{"tool":"image.edit","imageName":"attached filename","prompt":"...","modelId":"optional","size":"optional WIDTH*HEIGHT","n":1}
{"tool":"audio.transcribe","attachmentName":"attached filename","modelId":"optional","languageHints":["zh","en"]}
{"tool":"audio.synthesize","text":"text to speak","modelId":"qwen-audio-3.0-tts-plus","voice":"optional","instruction":"optional","languageHint":"zh or en","rate":1,"pitch":1,"volume":50}

Rules:
- Use none for image analysis, explanations, brainstorming, prompts/tutorials, or hypothetical discussion where the user did not ask Chat Space to actually generate/edit an image.
- audio.transcribe is only for turning an attached recording into text.
- audio.synthesize is only for an explicit request to create actual speech/audio from text. The currently implemented qwen-audio-3.0-tts-plus built-in voices support Chinese (Mandarin) and English; use none rather than silently promising unsupported Japanese built-in-voice synthesis.
- image.edit requires a reference image attached to the current user turn. audio.transcribe requires an attached audio file.
- Preserve the user's requested subject, style, text, composition, and constraints. Do not invent sensitive personal details.
- modelId may only be a model that implements the requested capability. Omit it unless the user asks for a specific specialist model.
- n must be 1-6. Omit size unless the user asks for a size/aspect resolution.
- Never route to realtime audio or video tools in this version.`;

export function couldNeedCapabilityTool(userText: string): boolean {
  const text = userText.slice(0, 12_000);
  return IMAGE_INTENT.test(text) || TRANSCRIBE_INTENT.test(text) || TTS_INTENT.test(text);
}

function optionalBoundedNumber(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

function parseToolPlan(
  raw: string,
  referenceImageNames: string[],
  audioAttachmentNames: string[],
): CapabilityToolPlan {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { tool: "none" };

  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { tool: "none" };
  }
  if (!value || typeof value !== "object") return { tool: "none" };
  const obj = value as Record<string, unknown>;
  if (obj.tool === "none") return { tool: "none" };

  if (obj.tool === "audio.transcribe") {
    const attachmentName =
      typeof obj.attachmentName === "string" ? obj.attachmentName.trim() : "";
    if (!attachmentName || !audioAttachmentNames.includes(attachmentName)) {
      return { tool: "none" };
    }
    const modelId =
      typeof obj.modelId === "string" &&
      modelHasAlibabaCapability(obj.modelId, "audio.asr")
        ? obj.modelId
        : undefined;
    let languageHints: string[] | undefined;
    if (obj.languageHints !== undefined) {
      if (!Array.isArray(obj.languageHints) || obj.languageHints.length > 4) {
        return { tool: "none" };
      }
      const hints = obj.languageHints.filter(
        (hint): hint is string =>
          typeof hint === "string" &&
          /^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/i.test(hint.trim()),
      );
      if (hints.length !== obj.languageHints.length) return { tool: "none" };
      const uniqueHints = [...new Set(hints.map((hint) => hint.trim().toLowerCase()))];
      if (uniqueHints.length > 0) languageHints = uniqueHints;
    }
    return {
      tool: "audio.transcribe",
      attachmentName,
      ...(modelId ? { modelId } : {}),
      ...(languageHints ? { languageHints } : {}),
    };
  }

  if (obj.tool === "audio.synthesize") {
    const text = typeof obj.text === "string" ? obj.text.trim().slice(0, 10_000) : "";
    if (!text) return { tool: "none" };
    if (
      obj.languageHint !== undefined &&
      obj.languageHint !== "zh" &&
      obj.languageHint !== "en"
    ) {
      return { tool: "none" };
    }
    const modelId =
      typeof obj.modelId === "string" && modelHasAlibabaCapability(obj.modelId, "audio.tts")
        ? obj.modelId
        : undefined;
    const voice =
      typeof obj.voice === "string" &&
      (QWEN_AUDIO_TTS_PLUS_VOICES as readonly string[]).includes(obj.voice)
        ? obj.voice as (typeof QWEN_AUDIO_TTS_PLUS_VOICES)[number]
        : undefined;
    const instruction = typeof obj.instruction === "string"
      ? obj.instruction.trim().slice(0, 1_000)
      : undefined;
    const languageHint = obj.languageHint === "zh" || obj.languageHint === "en"
      ? obj.languageHint
      : undefined;
    return {
      tool: "audio.synthesize",
      text,
      ...(modelId ? { modelId } : {}),
      ...(voice ? { voice } : {}),
      ...(instruction ? { instruction } : {}),
      ...(languageHint ? { languageHint } : {}),
      ...(optionalBoundedNumber(obj.rate, 0.5, 2) !== undefined
        ? { rate: optionalBoundedNumber(obj.rate, 0.5, 2) }
        : {}),
      ...(optionalBoundedNumber(obj.pitch, 0.5, 2) !== undefined
        ? { pitch: optionalBoundedNumber(obj.pitch, 0.5, 2) }
        : {}),
      ...(optionalBoundedNumber(obj.volume, 0, 100) !== undefined
        ? { volume: optionalBoundedNumber(obj.volume, 0, 100) }
        : {}),
    };
  }

  if (obj.tool !== "image.generate" && obj.tool !== "image.edit") {
    return { tool: "none" };
  }
  if (obj.tool === "image.edit") {
    const imageName = typeof obj.imageName === "string" ? obj.imageName.trim() : "";
    if (!imageName || !referenceImageNames.includes(imageName)) return { tool: "none" };
  }

  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim().slice(0, 16_000) : "";
  if (!prompt) return { tool: "none" };
  const modelId =
    typeof obj.modelId === "string" &&
    modelHasAlibabaCapability(obj.modelId, obj.tool === "image.edit" ? "image.edit" : "image.generate")
      ? obj.modelId
      : undefined;
  const size =
    typeof obj.size === "string" && /^\d{3,4}\*\d{3,4}$/.test(obj.size)
      ? obj.size
      : undefined;
  const n =
    typeof obj.n === "number" &&
    Number.isSafeInteger(obj.n) &&
    obj.n >= 1 &&
    obj.n <= 6
      ? obj.n
      : undefined;

  return {
    tool: obj.tool,
    prompt,
    ...(modelId ? { modelId } : {}),
    ...(obj.tool === "image.edit" ? { imageName: String(obj.imageName).trim() } : {}),
    ...(size ? { size } : {}),
    ...(n ? { n } : {}),
  };
}

async function runRouterCall(args: {
  client: OpenAI;
  provider: ModelProvider;
  modelId: string;
  userText: string;
  referenceImageNames: string[];
  audioAttachmentNames: string[];
  signal?: AbortSignal;
}): Promise<string> {
  const options: Parameters<typeof args.client.chat.completions.create>[0] = {
    model: args.modelId,
    messages: [
      { role: "system", content: ROUTER_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `Reference images attached: ${args.referenceImageNames.length > 0 ? "yes" : "no"}`,
          `Reference image filenames: ${args.referenceImageNames.join(", ") || "(none)"}`,
          `Audio attachments: ${args.audioAttachmentNames.length > 0 ? "yes" : "no"}`,
          `Audio filenames: ${args.audioAttachmentNames.join(", ") || "(none)"}`,
          "",
          `Current request:\n${args.userText.slice(0, 12_000)}`,
        ].join("\n"),
      },
    ],
    stream: false,
  };
  applyGenerationParams(
    options as unknown as Record<string, unknown>,
    args.modelId,
    args.provider,
    "off",
  );
  if (args.provider === "openai") {
    (options as unknown as Record<string, unknown>).max_completion_tokens = 800;
  } else {
    (options as unknown as Record<string, unknown>).max_tokens = 800;
  }

  try {
    const completion = await args.client.chat.completions.create(
      options as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { signal: args.signal },
    );
    return completion.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    if (args.signal?.aborted) throw args.signal.reason ?? error;
    if (!isUnsupportedGenerationParam(error)) throw error;
    logger.warn({ modelId: args.modelId }, "Capability router retrying with safe generation params");
    applySafeGenerationParams(options as unknown as Record<string, unknown>, args.provider);
    if (args.provider === "openai") {
      (options as unknown as Record<string, unknown>).max_completion_tokens = 800;
    } else {
      (options as unknown as Record<string, unknown>).max_tokens = 800;
    }
    const completion = await args.client.chat.completions.create(
      options as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { signal: args.signal },
    );
    return completion.choices?.[0]?.message?.content ?? "";
  }
}

/**
 * Cheap deterministic gate first, then let the currently selected chat model
 * decide whether an allowed specialist model should be invoked. This keeps
 * the capability available to GPT/Qwen/DeepSeek/GLM alike without requiring
 * every provider to implement identical native tool-calling semantics.
 */
export async function planCapabilityTool(args: {
  client: OpenAI;
  provider: ModelProvider;
  modelId: string;
  userText: string;
  hasReferenceImages: boolean;
  referenceImageNames?: string[];
  audioAttachmentNames?: string[];
  signal?: AbortSignal;
}): Promise<CapabilityToolPlan> {
  const referenceImageNames = args.referenceImageNames ?? [];
  const audioAttachmentNames = args.audioAttachmentNames ?? [];
  if (!couldNeedCapabilityTool(args.userText)) return { tool: "none" };
  if (TRANSCRIBE_INTENT.test(args.userText) && audioAttachmentNames.length === 0) {
    return { tool: "none" };
  }
  try {
    const raw = await runRouterCall({
      ...args,
      referenceImageNames,
      audioAttachmentNames,
    });
    const plan = parseToolPlan(raw, referenceImageNames, audioAttachmentNames);
    logger.info({ modelId: args.modelId, tool: plan.tool }, "Capability broker planned tool use");
    return plan;
  } catch (error) {
    if (args.signal?.aborted) throw error;
    logger.warn(
      { err: error, modelId: args.modelId },
      "Capability broker preflight failed; continuing without specialist tool",
    );
    return { tool: "none" };
  }
}

export const capabilityDefaults = ALIBABA_CAPABILITY_DEFAULTS;
