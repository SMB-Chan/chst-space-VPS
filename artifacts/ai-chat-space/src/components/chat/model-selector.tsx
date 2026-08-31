import { useEffect, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

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
  supportsReasoning?: boolean;
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
    typeof v.supportsVision === "boolean"
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
  if (remaining <= 20) return "border-red-500/40 bg-red-500/10 text-red-400";
  if (remaining <= 35)
    return "border-amber-500/40 bg-amber-500/10 text-amber-400";
  return "border-emerald-500/35 bg-emerald-500/10 text-emerald-400";
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          size="sm"
          data-testid="button-model-selector"
          className={cn(
            "h-7 gap-1.5 px-2.5 rounded-full text-xs font-medium transition-all",
            "border border-border/50 text-muted-foreground hover:text-foreground hover:border-border",
            "hover:bg-muted/40",
            current.provider === "dashscope" &&
              "text-amber-400/80 border-amber-500/30 hover:text-amber-400 hover:border-amber-500/50",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          <Cpu className="w-3 h-3" />
          <span>{current.label}</span>
          {current.provider === "dashscope" && triggerQuota !== undefined ? (
            <span
              title={quota ? quotaTitle(quota) : undefined}
              className={cn(
                "rounded-full border px-1.5 py-0.5 text-[10px] leading-none tabular-nums",
                quotaTone(triggerQuota),
              )}
            >
              {triggerQuotaLabel} {formatQuotaPercent(triggerQuota)}%
            </span>
          ) : null}
          <ChevronDown className="w-3 h-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="w-64"
        data-testid="dropdown-model-list"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          {PROVIDER_LABELS["openai"]}
        </DropdownMenuLabel>
        {openaiModels.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onClick={() => onSelect(model.id)}
            data-testid={`model-option-${model.id}`}
            className={cn(
              "flex items-center justify-between cursor-pointer rounded-md",
              selectedModel === model.id && "bg-primary/10 text-primary",
            )}
          >
            <span className="font-medium">{model.label}</span>
            <span className="text-xs text-muted-foreground">
              {model.description}
            </span>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="flex items-center gap-2 text-xs text-amber-400/70 font-normal">
          <span>{PROVIDER_LABELS["dashscope"]}</span>
          {quota?.weeklyRemainingPercent !== undefined ? (
            <span
              title={quotaTitle(quota)}
              className={cn(
                "rounded-full border px-1.5 py-0.5 text-[10px] tabular-nums",
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
                "rounded-full border px-1.5 py-0.5 text-[10px] tabular-nums",
                quotaTone(quota.fiveHourRemainingPercent),
              )}
            >
              5h {formatQuotaPercent(quota.fiveHourRemainingPercent)}%
            </span>
          ) : null}
        </DropdownMenuLabel>
        {qwenModels.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onClick={() => onSelect(model.id)}
            data-testid={`model-option-${model.id}`}
            className={cn(
              "flex items-center justify-between cursor-pointer rounded-md",
              selectedModel === model.id && "bg-amber-500/10 text-amber-400",
            )}
          >
            <span className="font-medium">{model.label}</span>
            <span className="text-xs text-muted-foreground">
              {model.description}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { MODELS };
