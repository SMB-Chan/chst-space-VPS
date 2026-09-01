import { useEffect, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ResponsiveSelection } from "./responsive-selection";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const TOKEN_PLAN_QUOTA_REFRESH_MS = 60_000;

const QUOTA_HEADERS = {
  weeklyRemaining: "X-Chat-Space-Token-Plan-Weekly-Remaining",
  fiveHourRemaining: "X-Chat-Space-Token-Plan-Five-Hour-Remaining",
  weeklyReset: "X-Chat-Space-Token-Plan-Weekly-Reset",
  fiveHourReset: "X-Chat-Space-Token-Plan-Five-Hour-Reset",
  limitingWindow: "X-Chat-Space-Token-Plan-Limiting-Window",
  limitingRemaining: "X-Chat-Space-Token-Plan-Limiting-Remaining",
} as const;

export interface ModelInfo {
  id: string;
  label: string;
  provider: "openai" | "dashscope";
  description: string;
  supportsVision: boolean;
  supportsReasoning: boolean;
  reasoning?: "none" | "openai" | "dashscope";
}

export interface TokenPlanQuotaHint {
  weeklyRemainingPercent?: number;
  fiveHourRemainingPercent?: number;
  weeklyResetAt?: string;
  fiveHourResetAt?: string;
  limitingWindow?: "5-hour" | "1-week";
  limitingRemainingPercent?: number;
}

const MODELS: ModelInfo[] = [
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    description: "高性能・汎用",
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    description: "高速・低コスト",
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "o4-mini",
    label: "o4-mini",
    provider: "openai",
    description: "高度な推論",
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "qwen3.8-max",
    label: "Qwen3.8 Max",
    provider: "dashscope",
    description: "Alibaba最高性能",
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "qwen3.8-flash",
    label: "Qwen3.8 Flash",
    provider: "dashscope",
    description: "高速・画像理解",
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "qwen3.7-plus",
    label: "Qwen3.7 Plus",
    provider: "dashscope",
    description: "高速・バランス",
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "qwen3.7-max",
    label: "Qwen3.7 Max",
    provider: "dashscope",
    description: "高性能テキスト推論",
    supportsVision: false,
    supportsReasoning: true,
  },
  {
    id: "qwen3.6-flash",
    label: "Qwen3.6 Flash",
    provider: "dashscope",
    description: "最速・低コスト",
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "deepseek-v4-pro-0813",
    label: "DeepSeek V4 Pro 0813",
    provider: "dashscope",
    description: "推論特化スナップショット",
    supportsVision: false,
    supportsReasoning: true,
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "dashscope",
    description: "推論特化・画像は転記で対応",
    supportsVision: false,
    supportsReasoning: true,
  },
  {
    id: "deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731",
    provider: "dashscope",
    description: "高速推論・画像は転記で対応",
    supportsVision: false,
    supportsReasoning: true,
  },
  {
    id: "glm-5.2",
    label: "GLM-5.2",
    provider: "dashscope",
    description: "汎用・画像は転記で対応",
    supportsVision: false,
    supportsReasoning: true,
  },
];

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  dashscope: "Alibaba Cloud (Qwen)",
};

interface ModelSelectorProps {
  selectedModel: string;
  onSelect: (modelId: string) => void;
  disabled?: boolean;
}

function isModelInfo(value: unknown): value is ModelInfo {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    (v.provider === "openai" || v.provider === "dashscope") &&
    typeof v.description === "string" &&
    typeof v.supportsVision === "boolean" &&
    typeof v.supportsReasoning === "boolean"
  );
}

function readPercentHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

export function readTokenPlanQuotaHint(
  headers: Headers,
): TokenPlanQuotaHint | null {
  const weeklyRemainingPercent = readPercentHeader(
    headers,
    QUOTA_HEADERS.weeklyRemaining,
  );
  const fiveHourRemainingPercent = readPercentHeader(
    headers,
    QUOTA_HEADERS.fiveHourRemaining,
  );
  const limitingRemainingPercent = readPercentHeader(
    headers,
    QUOTA_HEADERS.limitingRemaining,
  );
  const rawWindow = headers.get(QUOTA_HEADERS.limitingWindow);
  const limitingWindow =
    rawWindow === "5-hour" || rawWindow === "1-week" ? rawWindow : undefined;
  const weeklyResetAt = headers.get(QUOTA_HEADERS.weeklyReset) || undefined;
  const fiveHourResetAt = headers.get(QUOTA_HEADERS.fiveHourReset) || undefined;
  if (
    weeklyRemainingPercent === undefined ||
    fiveHourRemainingPercent === undefined
  ) {
    return null;
  }
  return {
    ...(weeklyRemainingPercent !== undefined ? { weeklyRemainingPercent } : {}),
    ...(fiveHourRemainingPercent !== undefined
      ? { fiveHourRemainingPercent }
      : {}),
    ...(limitingRemainingPercent !== undefined
      ? { limitingRemainingPercent }
      : {}),
    ...(limitingWindow ? { limitingWindow } : {}),
    ...(weeklyResetAt ? { weeklyResetAt } : {}),
    ...(fiveHourResetAt ? { fiveHourResetAt } : {}),
  };
}

export function readTokenPlanQuotaResponse(
  response: Response,
): TokenPlanQuotaHint | null {
  if (!response.ok) return null;
  return readTokenPlanQuotaHint(response.headers);
}

function useTokenPlanQuotaHint(enabled: boolean): TokenPlanQuotaHint | null {
  const [quota, setQuota] = useState<TokenPlanQuotaHint | null>(null);

  useEffect(() => {
    if (!enabled) {
      setQuota(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch(`${BASE}/api/openai/models`, {
          credentials: "include",
        });
        if (cancelled) return;
        if (!res.ok) {
          setQuota(null);
          return;
        }
        const next = readTokenPlanQuotaResponse(res);
        if (!cancelled) setQuota(next);
      } catch {
        if (!cancelled) setQuota(null);
      }
    };
    void refresh();
    const timer = window.setInterval(
      () => void refresh(),
      TOKEN_PLAN_QUOTA_REFRESH_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return quota;
}

function quotaTone(remaining: number): string {
  if (remaining <= 20)
    return "[border-color:var(--m3-error)] [background:var(--m3-error-container)] [color:var(--m3-on-error-container)]";
  if (remaining <= 35)
    return "[border-color:var(--app-status-warning)] [background:var(--app-status-warning-container)] [color:var(--app-status-warning)]";
  return "[border-color:var(--app-status-success)] [background:var(--app-status-success-container)] [color:var(--app-status-success)]";
}

function formatQuotaPercent(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}

function formatReset(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function quotaTitle(quota: TokenPlanQuotaHint): string {
  const parts = ["Alibaba Token Plan 残量"];
  if (quota.weeklyRemainingPercent !== undefined) {
    const reset = formatReset(quota.weeklyResetAt);
    parts.push(
      `週間 ${formatQuotaPercent(quota.weeklyRemainingPercent)}%${reset ? `（${reset} JST リセット）` : ""}`,
    );
  }
  if (quota.fiveHourRemainingPercent !== undefined) {
    const reset = formatReset(quota.fiveHourResetAt);
    parts.push(
      `5時間 ${formatQuotaPercent(quota.fiveHourRemainingPercent)}%${reset ? `（${reset} JST リセット）` : ""}`,
    );
  }
  return parts.join(" / ");
}

/** Live list from the API, falling back to the bundled catalog if the request fails. */
export function useAvailableModels(): ModelInfo[] {
  const [models, setModels] = useState<ModelInfo[]>(MODELS);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/openai/models`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        const parsed = data.filter(isModelInfo);
        if (parsed.length > 0) setModels(parsed);
      })
      .catch(() => {
        /* keep fallback catalog */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return models;
}

export function getModelLabel(
  modelId: string,
  models: ModelInfo[] = MODELS,
): string {
  return models.find((m) => m.id === modelId)?.label ?? modelId;
}

export function ModelSelector({
  selectedModel,
  onSelect,
  disabled,
}: ModelSelectorProps) {
  const models = useAvailableModels();
  const current =
    models.find((m) => m.id === selectedModel) ?? models[0] ?? MODELS[0];
  const quota = useTokenPlanQuotaHint(current.provider === "dashscope");

  const openaiModels = models.filter((m) => m.provider === "openai");
  const qwenModels = models.filter((m) => m.provider === "dashscope");
  const triggerQuota =
    quota?.weeklyRemainingPercent ?? quota?.limitingRemainingPercent;
  const triggerQuotaLabel =
    quota?.weeklyRemainingPercent !== undefined ? "週" : "TP";

  const renderModelOption = (
    model: ModelInfo,
    surface: "desktop" | "mobile",
    close?: () => void,
  ) => {
    const selected = selectedModel === model.id;
    const optionContent = (
      <>
        <span className="min-w-0 break-words font-medium">{model.label}</span>
        <span className="max-w-[48%] shrink-0 text-right text-xs text-muted-foreground">
          {model.description}
        </span>
      </>
    );

    if (surface === "mobile") {
      return (
        <button
          key={model.id}
          type="button"
          onClick={() => {
            onSelect(model.id);
            close?.();
          }}
          data-testid={`model-option-${model.id}`}
          aria-current={selected ? "true" : undefined}
          className={cn(
            "flex min-h-14 w-full items-center justify-between gap-3 rounded-[var(--m3-shape-sm)] px-4 py-3 text-left text-sm outline-none transition-[background-color,color,transform] duration-[var(--m3-duration-short)] ease-[var(--m3-motion-standard)] hover:bg-[var(--m3-surface-container-highest)] focus-visible:ring-2 focus-visible:ring-[var(--m3-primary)] active:scale-[0.99]",
            selected && "bg-primary/10 text-primary",
            model.provider === "dashscope" &&
              selected &&
              "[background:var(--app-status-accent-container)] [color:var(--app-status-accent)]",
          )}
        >
          {optionContent}
        </button>
      );
    }

    return (
      <DropdownMenuItem
        key={model.id}
        onClick={() => onSelect(model.id)}
        data-testid={`model-option-${model.id}`}
        className={cn(
          "flex items-center justify-between gap-3 cursor-pointer rounded-[var(--m3-shape-xs)]",
          selected && "bg-primary/10 text-primary",
          model.provider === "dashscope" &&
            selected &&
            "[background:var(--app-status-accent-container)] [color:var(--app-status-accent)]",
        )}
      >
        {optionContent}
      </DropdownMenuItem>
    );
  };

  const providerQuota = (
    <div className="flex flex-wrap items-center gap-2 text-xs font-normal [color:var(--app-status-accent)]">
      <span>{PROVIDER_LABELS["dashscope"]}</span>
      {quota?.weeklyRemainingPercent !== undefined ? (
        <span
          title={quotaTitle(quota)}
          className={cn(
            "rounded-[var(--m3-shape-full)] border px-1.5 py-0.5 text-[10px] tabular-nums",
            quotaTone(quota.weeklyRemainingPercent),
          )}
        >
          週 {formatQuotaPercent(quota.weeklyRemainingPercent)}%
        </span>
      ) : null}
      {quota?.fiveHourRemainingPercent !== undefined ? (
        <span
          title={quotaTitle(quota)}
          className={cn(
            "rounded-[var(--m3-shape-full)] border px-1.5 py-0.5 text-[10px] tabular-nums",
            quotaTone(quota.fiveHourRemainingPercent),
          )}
        >
          5h {formatQuotaPercent(quota.fiveHourRemainingPercent)}%
        </span>
      ) : null}
    </div>
  );

  const desktopContent = (
    <>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        {PROVIDER_LABELS["openai"]}
      </DropdownMenuLabel>
      {openaiModels.map((model) => renderModelOption(model, "desktop"))}
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal [color:var(--app-status-accent)]">
        {providerQuota}
      </DropdownMenuLabel>
      {qwenModels.map((model) => renderModelOption(model, "desktop"))}
    </>
  );

  return (
    <ResponsiveSelection
      trigger={
        <Button
          variant="ghost"
          size="sm"
          data-testid="button-model-selector"
          className={cn(
            "h-8 gap-1.5 rounded-[var(--m3-shape-full)] px-3 text-xs font-medium transition-all duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-standard)]",
            "border border-border/60 bg-card/50 text-muted-foreground hover:bg-card/80 hover:text-foreground",
            current.provider === "dashscope" &&
              "[color:var(--app-status-accent)] [border-color:var(--app-status-accent)] [background:var(--app-status-accent-container)] hover:[color:var(--app-status-accent)] hover:[border-color:var(--app-status-accent)] hover:[background:var(--app-status-accent-container)]",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <Cpu className="h-3 w-3" />
          <span>{current.label}</span>
          {current.provider === "dashscope" && triggerQuota !== undefined ? (
            <span
              title={quota ? quotaTitle(quota) : undefined}
              className={cn(
                "rounded-[var(--m3-shape-full)] border px-1.5 py-0.5 text-[10px] leading-none tabular-nums",
                quotaTone(triggerQuota),
              )}
            >
              {triggerQuotaLabel} {formatQuotaPercent(triggerQuota)}%
            </span>
          ) : null}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      }
      title="モデルを選択"
      description="使用するAIモデルを選択します"
      disabled={disabled}
      contentTestId="dropdown-model-list"
      desktopContentClassName="w-64"
      desktopContent={desktopContent}
      mobileContent={(close) => (
        <div className="space-y-1">
          <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
            {PROVIDER_LABELS["openai"]}
          </div>
          {openaiModels.map((model) =>
            renderModelOption(model, "mobile", close),
          )}
          <div className="my-2 h-px bg-[var(--m3-outline-variant)]" />
          <div className="px-2 pb-1 pt-1">{providerQuota}</div>
          {qwenModels.map((model) => renderModelOption(model, "mobile", close))}
        </div>
      )}
    />
  );
}

export { MODELS };
