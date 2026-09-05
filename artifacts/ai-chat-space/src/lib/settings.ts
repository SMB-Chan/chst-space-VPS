import { parseReasoningLevel, type ReasoningLevel } from "./reasoning";

export type TranslationModeSetting =
  | "off"
  | "auto"
  | "ja-en"
  | "en-ja"
  | "auto-ko"
  | "ja-ko"
  | "ko-ja"
  | "auto-zh"
  | "ja-zh"
  | "zh-ja";

function parseTranslationModeSetting(raw: unknown): TranslationModeSetting {
  return [
    "auto",
    "ja-en",
    "en-ja",
    "auto-ko",
    "ja-ko",
    "ko-ja",
    "auto-zh",
    "ja-zh",
    "zh-ja",
  ].includes(raw as string)
    ? (raw as TranslationModeSetting)
    : "off";
}

const STORAGE_KEY = "chat-space.settings.v1";

export interface AppSettings {
  defaultModel: string;
  defaultReasoning: ReasoningLevel;
  auditEnabled: boolean;
  auditModelId: string;
  auditReasoning: ReasoningLevel;
  translationMode: TranslationModeSetting;
}

const FALLBACK: AppSettings = {
  defaultModel: "gpt-5.6-terra",
  defaultReasoning: "medium",
  auditEnabled: false,
  auditModelId: "qwen3.8-max",
  auditReasoning: "off",
  translationMode: "off",
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...FALLBACK };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      defaultModel:
        typeof parsed.defaultModel === "string" && parsed.defaultModel
          ? parsed.defaultModel
          : FALLBACK.defaultModel,
      defaultReasoning: parseReasoningLevel(parsed.defaultReasoning),
      auditEnabled: parsed.auditEnabled === true,
      auditModelId:
        typeof parsed.auditModelId === "string" && parsed.auditModelId
          ? parsed.auditModelId
          : FALLBACK.auditModelId,
      auditReasoning: parseReasoningLevel(parsed.auditReasoning),
      translationMode: parseTranslationModeSetting(parsed.translationMode),
    };
  } catch {
    return { ...FALLBACK };
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(
    new CustomEvent("chat-space-settings", { detail: next }),
  );
  return next;
}

export function subscribeSettings(
  listener: (settings: AppSettings) => void,
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener(loadSettings());
  };
  const onLocal = (event: Event) => {
    const detail = (event as CustomEvent<AppSettings>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("chat-space-settings", onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("chat-space-settings", onLocal);
  };
}

export function pickAuditModel(
  primaryId: string,
  models: { id: string; provider: "openai" | "dashscope" | "openrouter" }[],
  preferred?: string,
): string {
  if (
    preferred &&
    preferred !== primaryId &&
    models.some((m) => m.id === preferred)
  ) {
    return preferred;
  }
  const primary = models.find((m) => m.id === primaryId);
  const otherProvider = models.find(
    (m) => m.id !== primaryId && m.provider !== primary?.provider,
  );
  if (otherProvider) return otherProvider.id;
  return models.find((m) => m.id !== primaryId)?.id ?? primaryId;
}
