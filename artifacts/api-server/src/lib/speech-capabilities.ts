import { dashscopeClient } from "./ai-clients";
import {
  isAlibabaSpecialistConfigured,
  isAlibabaTokenPlanKey,
} from "./alibaba-specialist-config";
import {
  QWEN_AUDIO_TTS_PLUS_VOICES,
  type QwenAudioTtsPlusVoice,
} from "./alibaba-tts";
import { isProviderFrozen } from "./provider-policy";
import {
  MIMO_ASR_MODEL_ID,
  MIMO_TTS_DEFAULT_MODEL_ID,
  MIMO_TTS_VOICE_DESIGN_MODEL_ID,
  MIMO_TTS_VOICES,
  isXiaomiAudioConfigured,
  type XiaomiTtsModelId,
  type XiaomiTtsVoice,
} from "./xiaomi-audio";

/**
 * Provider-neutral speech catalog. Chat Space has more than one vendor that can
 * speak and listen, and which one is usable depends on credentials plus the
 * provider freeze flags, so routing decisions are resolved here instead of
 * being hardwired to a single vendor at each call site.
 */

export type SpeechProvider = "alibaba" | "xiaomi";

export type SpeechLanguage = "zh" | "en" | "ja";

export const SPEECH_LANGUAGES: readonly SpeechLanguage[] = ["zh", "en", "ja"];

export function isSpeechLanguage(value: unknown): value is SpeechLanguage {
  return (
    typeof value === "string" &&
    (SPEECH_LANGUAGES as readonly string[]).includes(value)
  );
}

export type AlibabaTtsModelId = "qwen-audio-3.0-tts-plus";
export type AlibabaAsrModelId = "qwen-audio-3.0-asr-flash" | "paraformer-v2";

export type TtsModelId = AlibabaTtsModelId | XiaomiTtsModelId;
export type AsrModelId = AlibabaAsrModelId | typeof MIMO_ASR_MODEL_ID;

export type TtsVoice = QwenAudioTtsPlusVoice | XiaomiTtsVoice;

export interface TtsModelSpec {
  id: TtsModelId;
  label: string;
  provider: SpeechProvider;
  /** Empty when the model designs a voice from an instruction instead. */
  voices: readonly TtsVoice[];
  languages: readonly SpeechLanguage[];
  /** Accepts a free-form description of the voice to use. */
  supportsInstruction: boolean;
  /** Accepts rate/pitch/volume. MiMo exposes none of these. */
  supportsProsody: boolean;
}

export interface AsrModelSpec {
  id: AsrModelId;
  label: string;
  provider: SpeechProvider;
}

export const ALIBABA_TTS_MODEL_ID: AlibabaTtsModelId =
  "qwen-audio-3.0-tts-plus";

/** Alibaba's built-in TTS voices cover Mandarin and English only. */
export const ALIBABA_TTS_LANGUAGES: readonly SpeechLanguage[] = ["zh", "en"];

export const TTS_MODELS: readonly TtsModelSpec[] = [
  {
    id: ALIBABA_TTS_MODEL_ID,
    label: "Qwen Audio 3.0 TTS Plus",
    provider: "alibaba",
    voices: QWEN_AUDIO_TTS_PLUS_VOICES,
    languages: ALIBABA_TTS_LANGUAGES,
    supportsInstruction: true,
    supportsProsody: true,
  },
  {
    id: MIMO_TTS_DEFAULT_MODEL_ID,
    label: "MiMo V2.5 TTS",
    provider: "xiaomi",
    voices: MIMO_TTS_VOICES,
    // Japanese renders through the built-in voices but with Mandarin phonology;
    // voicedesign is the usable Japanese path.
    languages: ["zh", "en", "ja"],
    supportsInstruction: false,
    supportsProsody: false,
  },
  {
    id: MIMO_TTS_VOICE_DESIGN_MODEL_ID,
    label: "MiMo V2.5 TTS Voice Design",
    provider: "xiaomi",
    voices: [],
    languages: ["zh", "en", "ja"],
    supportsInstruction: true,
    supportsProsody: false,
  },
];

export const ASR_MODELS: readonly AsrModelSpec[] = [
  {
    id: "qwen-audio-3.0-asr-flash",
    label: "Qwen Audio 3.0 ASR Flash",
    provider: "alibaba",
  },
  { id: "paraformer-v2", label: "Paraformer V2", provider: "alibaba" },
  { id: MIMO_ASR_MODEL_ID, label: "MiMo V2.5 ASR", provider: "xiaomi" },
];

export function isTtsModelId(value: unknown): value is TtsModelId {
  return typeof value === "string" && getTtsModel(value) !== undefined;
}

export function isAsrModelId(value: unknown): value is AsrModelId {
  return (
    typeof value === "string" && ASR_MODELS.some((model) => model.id === value)
  );
}

export function getTtsModel(modelId: string): TtsModelSpec | undefined {
  return TTS_MODELS.find((model) => model.id === modelId);
}

export function getAsrModel(modelId: string): AsrModelSpec | undefined {
  return ASR_MODELS.find((model) => model.id === modelId);
}

export function ttsVoicesFor(modelId: string): readonly TtsVoice[] {
  return getTtsModel(modelId)?.voices ?? [];
}

export function isTtsVoice(modelId: string, voice: string): boolean {
  return (ttsVoicesFor(modelId) as readonly string[]).includes(voice);
}

/** Voices are unique across vendors, so a voice alone identifies its model. */
export function modelIdForVoice(voice: string): TtsModelId | undefined {
  return TTS_MODELS.find((model) =>
    (model.voices as readonly string[]).includes(voice),
  )?.id;
}

export function isSpeechProviderAvailable(
  provider: SpeechProvider,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return provider === "xiaomi"
    ? isXiaomiAudioConfigured(env)
    : isAlibabaSpecialistConfigured(env);
}

/**
 * Paraformer runs on a plain Model Studio key, so it stays reachable on
 * installations that never configured specialist credentials. Token Plan keys
 * are still rejected for backend specialist traffic.
 */
export function isRegularDashScopeTranscriptionConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const key = env.DASHSCOPE_API_KEY?.trim();
  return Boolean(
    !isProviderFrozen("dashscope", env) &&
    dashscopeClient &&
    key &&
    !isAlibabaTokenPlanKey(key),
  );
}

export function availableTtsModels(
  env: NodeJS.ProcessEnv = process.env,
): TtsModelSpec[] {
  return TTS_MODELS.filter((model) =>
    isSpeechProviderAvailable(model.provider, env),
  );
}

export function availableAsrModels(
  env: NodeJS.ProcessEnv = process.env,
): AsrModelSpec[] {
  return ASR_MODELS.filter((model) =>
    model.id === "paraformer-v2"
      ? isRegularDashScopeTranscriptionConfigured(env)
      : isSpeechProviderAvailable(model.provider, env),
  );
}

export function isTtsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return availableTtsModels(env).length > 0;
}

export function isAsrAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return availableAsrModels(env).length > 0;
}

/**
 * Pick the model to use when the caller did not name one.
 *
 * Japanese skips Alibaba entirely: its built-in voices only cover Mandarin and
 * English and its transport rejects any other language hint. An instruction
 * prefers a model that can act on one, and MiMo's voicedesign model is the
 * only MiMo path that produced intelligible Japanese in round-trip testing.
 */
export function selectDefaultTtsModel(
  args: { instruction?: string; languageHint?: SpeechLanguage } = {},
  env: NodeJS.ProcessEnv = process.env,
): TtsModelSpec | undefined {
  const order: TtsModelId[] =
    args.languageHint === "ja"
      ? [MIMO_TTS_VOICE_DESIGN_MODEL_ID, MIMO_TTS_DEFAULT_MODEL_ID]
      : args.instruction
        ? [
            ALIBABA_TTS_MODEL_ID,
            MIMO_TTS_VOICE_DESIGN_MODEL_ID,
            MIMO_TTS_DEFAULT_MODEL_ID,
          ]
        : [
            ALIBABA_TTS_MODEL_ID,
            MIMO_TTS_DEFAULT_MODEL_ID,
            MIMO_TTS_VOICE_DESIGN_MODEL_ID,
          ];
  for (const id of order) {
    const spec = getTtsModel(id);
    if (spec && isSpeechProviderAvailable(spec.provider, env)) return spec;
  }
  return undefined;
}

/** Language coverage across every configured TTS model, for the router prompt. */
export function availableTtsLanguages(
  env: NodeJS.ProcessEnv = process.env,
): SpeechLanguage[] {
  const languages = new Set<SpeechLanguage>();
  for (const model of availableTtsModels(env)) {
    for (const language of model.languages) languages.add(language);
  }
  return [...languages];
}

export function describeAvailableTtsModels(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const models = availableTtsModels(env);
  if (models.length === 0) return "(none configured)";
  return models
    .map((model) => {
      const parts = [
        `${model.id} [${model.provider}] languages=${model.languages.join("+")}`,
        model.voices.length > 0
          ? `voices=${model.voices.join("|")}`
          : "voices=none (design the voice with instruction)",
        model.supportsInstruction ? "instruction=yes" : "instruction=no",
        model.supportsProsody
          ? "rate/pitch/volume=yes"
          : "rate/pitch/volume=no",
      ];
      return `- ${parts.join(", ")}`;
    })
    .join("\n");
}

export function describeAvailableAsrModels(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const models = availableAsrModels(env);
  if (models.length === 0) return "(none configured)";
  return models.map((model) => `- ${model.id} [${model.provider}]`).join("\n");
}
