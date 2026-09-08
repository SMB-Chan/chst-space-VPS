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

function sanitizeSettings(raw: unknown): AppSettings {
  const parsed = (raw ?? {}) as Partial<AppSettings>;
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
}

function apiBase(): string {
  return `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/openai/settings`;
}

// Server sync bookkeeping: hydration must never clobber a newer local write.
let lastLocalWriteAt = 0;
let hydrationStartedAt = 0;
let hydrationRequested = false;

/**
 * Pull the account's stored settings after authentication and apply them over
 * the local cache. Keeps defaults consistent across browsers and devices —
 * localStorage alone resets whenever storage is partitioned or cleared.
 */
export function hydrateSettingsFromServer(): void {
  if (hydrationRequested) return;
  hydrationRequested = true;
  hydrationStartedAt = Date.now();
  fetch(apiBase(), { credentials: "include" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const remote = (data as { settings?: unknown } | null)?.settings;
      if (!remote || typeof remote !== "object") return;
      if (lastLocalWriteAt > hydrationStartedAt) return;
      const next = sanitizeSettings(remote);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(
        new CustomEvent("chat-space-settings", { detail: next }),
      );
    })
    .catch(() => {
      /* offline / unauthenticated: keep local settings */
    });
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

function pushSettingsToServer(settings: AppSettings): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    fetch(apiBase(), {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }).catch(() => {
      /* retried on the next save */
    });
  }, 400);
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...FALLBACK };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...FALLBACK };
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    lastLocalWriteAt = Date.now();
    pushSettingsToServer(next);
  } catch {
    // Storage may be unavailable (private mode); the account copy still syncs.
    pushSettingsToServer(next);
  }
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
  models: { id: string; provider: "openai" | "dashscope" | "openrouter" | "xiaomi" }[],
  preferred?: string,
): string {
  // The saved choice is the source of truth whenever it still exists in the
  // current catalog — including when it equals the primary (the server then
  // skips the audit for that turn). Only a stale/invalid id falls back, and
  // the fallback prefers a different provider for genuine cross-checking.
  if (preferred && models.some((m) => m.id === preferred)) return preferred;
  const primary = models.find((m) => m.id === primaryId);
  const otherProvider = models.find(
    (m) => m.id !== primaryId && m.provider !== primary?.provider,
  );
  if (otherProvider) return otherProvider.id;
  return models.find((m) => m.id !== primaryId)?.id ?? primaryId;
}
