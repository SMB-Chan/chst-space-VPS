import { parseReasoningLevel, type ReasoningLevel } from "./reasoning";

const STORAGE_KEY = "chat-space.settings.v1";

export interface AppSettings {
  defaultModel: string;
  defaultReasoning: ReasoningLevel;
}

const FALLBACK: AppSettings = {
  defaultModel: "gpt-5.6-terra",
  defaultReasoning: "medium",
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
    };
  } catch {
    return { ...FALLBACK };
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("chat-space-settings", { detail: next }));
  return next;
}

export function subscribeSettings(listener: (settings: AppSettings) => void): () => void {
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
