import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { surfaceVariants } from "@/design-system/surface";

export type FactualityVerdict = "supported" | "contradicted" | "unknown";
export type FactualityStatus = "verified" | "mixed" | "insufficient";

export interface FactualityClaim {
  claim: string;
  verdict: FactualityVerdict;
  sourceIds: number[];
  reason: string;
}

export interface NewsQualityReport {
  kind: "news";
  quality: "good" | "partial" | "poor";
  taskSuccess: "succeeded" | "failed" | "unknown";
  acceptedSourceCount: number;
  freshSourceCount: number;
  independentDomainCount: number;
  officialOrMajorSourceCount: number;
  queries: string[];
}

export interface FactualityReport {
  status: FactualityStatus;
  summary: string;
  claims: FactualityClaim[];
  modelId: string;
  corrected: boolean;
  researchQuality?: NewsQualityReport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeFactualityReport(
  value: unknown,
): FactualityReport | null {
  if (typeof value === "string") {
    try {
      return normalizeFactualityReport(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || !Array.isArray(value.claims)) return null;
  if (
    value.status !== "verified" &&
    value.status !== "mixed" &&
    value.status !== "insufficient"
  ) {
    return null;
  }
  if (typeof value.summary !== "string" || typeof value.modelId !== "string") {
    return null;
  }
  const claims = value.claims.slice(0, 8).flatMap((item) => {
    if (!isRecord(item)) return [];
    if (
      typeof item.claim !== "string" ||
      typeof item.reason !== "string" ||
      (item.verdict !== "supported" &&
        item.verdict !== "contradicted" &&
        item.verdict !== "unknown")
    ) {
      return [];
    }
    const sourceIds = Array.isArray(item.sourceIds)
      ? item.sourceIds.filter(
          (id): id is number =>
            typeof id === "number" && Number.isSafeInteger(id) && id > 0,
        )
      : [];
    return [
      {
        claim: item.claim.slice(0, 320),
        verdict: item.verdict,
        sourceIds,
        reason: item.reason.slice(0, 240),
      } satisfies FactualityClaim,
    ];
  });
  return {
    status: value.status,
    summary: value.summary.slice(0, 400),
    claims,
    modelId: value.modelId.slice(0, 200),
    corrected: value.corrected === true,
    researchQuality: normalizeNewsQuality(value.researchQuality),
  };
}

function normalizeNewsQuality(value: unknown): NewsQualityReport | undefined {
  if (!isRecord(value) || value.kind !== "news") return undefined;
  if (
    value.quality !== "good" &&
    value.quality !== "partial" &&
    value.quality !== "poor"
  ) {
    return undefined;
  }
  if (
    value.taskSuccess !== "succeeded" &&
    value.taskSuccess !== "failed" &&
    value.taskSuccess !== "unknown"
  ) {
    return undefined;
  }
  const count = (input: unknown) =>
    typeof input === "number" && Number.isSafeInteger(input)
      ? Math.max(0, Math.min(100, input))
      : 0;
  const queries = Array.isArray(value.queries)
    ? value.queries
        .filter((query): query is string => typeof query === "string")
        .map((query) => query.slice(0, 240))
        .slice(0, 3)
    : [];
  return {
    kind: "news",
    quality: value.quality,
    taskSuccess: value.taskSuccess,
    acceptedSourceCount: count(value.acceptedSourceCount),
    freshSourceCount: count(value.freshSourceCount),
    independentDomainCount: count(value.independentDomainCount),
    officialOrMajorSourceCount: count(value.officialOrMajorSourceCount),
    queries,
  };
}

const statusUi: Record<
  FactualityStatus,
  {
    label: string;
    containerClassName: string;
    accentClassName: string;
    icon: typeof ShieldCheck;
  }
> = {
  verified: {
    label: "根拠対応済み",
    containerClassName:
      "[background:var(--app-status-success-container)] [border-color:var(--app-status-success)]",
    accentClassName: "[color:var(--app-status-success)]",
    icon: ShieldCheck,
  },
  mixed: {
    label: "一部は追加確認が必要",
    containerClassName:
      "[background:var(--app-status-warning-container)] [border-color:var(--app-status-warning)]",
    accentClassName: "[color:var(--app-status-warning)]",
    icon: AlertTriangle,
  },
  insufficient: {
    label: "根拠不足",
    containerClassName:
      "[background:var(--app-status-info-container)] [border-color:var(--app-status-info)]",
    accentClassName: "[color:var(--app-status-info)]",
    icon: CircleHelp,
  },
};

const verdictUi: Record<
  FactualityVerdict,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  supported: {
    label: "根拠あり",
    className: "[color:var(--app-status-success)]",
    icon: CheckCircle2,
  },
  contradicted: {
    label: "矛盾あり",
    className: "[color:var(--m3-error)]",
    icon: AlertTriangle,
  },
  unknown: {
    label: "確認不能",
    className: "[color:var(--app-status-warning)]",
    icon: CircleHelp,
  },
};

export function FactualityCard({ report }: { report: FactualityReport }) {
  const quality = report.researchQuality;
  const overallStatus =
    quality &&
    (quality.quality !== "good" || quality.taskSuccess !== "succeeded")
      ? "mixed"
      : report.status;
  const [expanded, setExpanded] = useState(overallStatus !== "verified");
  const ui = statusUi[overallStatus];
  const StatusIcon = ui.icon;
  const supportedCount = report.claims.filter(
    (claim) => claim.verdict === "supported",
  ).length;

  return (
    <section
      className={cn(
        surfaceVariants({ tone: "outlined", shape: "large" }),
        "w-full overflow-hidden text-xs transition-[border-color,background-color] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-standard)]",
        ui.containerClassName,
      )}
      aria-label="回答の根拠チェック"
      data-status={overallStatus}
    >
      <button
        type="button"
        className="m3-focus-ring flex w-full items-start gap-2.5 px-3.5 py-3 text-left transition-colors hover:bg-foreground/[0.04]"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <StatusIcon
          className={cn("mt-0.5 h-4 w-4 shrink-0", ui.accentClassName)}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 font-medium text-foreground">
            <span>{ui.label}</span>
            {report.claims.length > 0 && (
              <span className="font-normal text-muted-foreground">
                {supportedCount}/{report.claims.length}件
              </span>
            )}
            {report.corrected && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-[var(--m3-shape-full)] border border-current/25 px-1.5 py-0.5 text-[10px] font-normal",
                  ui.accentClassName,
                )}
              >
                <Wrench className="h-2.5 w-2.5" aria-hidden="true" />
                本文修正済み
              </span>
            )}
          </span>
          <span className="mt-0.5 block leading-relaxed text-muted-foreground">
            {report.summary}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-expressive)]",
            expanded && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {quality && (
        <div className="grid gap-2 border-t border-[var(--m3-outline-variant)] px-3.5 py-3 sm:grid-cols-3">
          <QualityMetric
            label="根拠整合"
            value={
              report.status === "verified"
                ? "成功"
                : report.status === "mixed"
                  ? "一部確認"
                  : "不足"
            }
            good={report.status === "verified"}
          />
          <QualityMetric
            label="質問達成"
            value={
              quality.taskSuccess === "succeeded"
                ? "成功"
                : quality.taskSuccess === "failed"
                  ? "未達"
                  : "不明"
            }
            good={quality.taskSuccess === "succeeded"}
          />
          <QualityMetric
            label="検索品質"
            value={
              quality.quality === "good"
                ? `${quality.freshSourceCount}件・${quality.independentDomainCount}ドメイン`
                : quality.quality === "partial"
                  ? "一部のみ"
                  : "不足"
            }
            good={quality.quality === "good"}
          />
        </div>
      )}

      {expanded && report.claims.length > 0 && (
        <ol className="space-y-2 border-t border-[var(--m3-outline-variant)] px-3.5 py-3">
          {report.claims.map((claim, index) => {
            const claimUi = verdictUi[claim.verdict];
            const ClaimIcon = claimUi.icon;
            return (
              <li
                key={`${claim.claim}-${index}`}
                className="flex gap-2 rounded-[var(--m3-shape-sm)] px-1 py-0.5"
              >
                <ClaimIcon
                  className={cn(
                    "mt-0.5 h-3.5 w-3.5 shrink-0",
                    claimUi.className,
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={cn("font-medium", claimUi.className)}>
                      {claimUi.label}
                    </span>
                    {claim.sourceIds.map((sourceId) => (
                      <a
                        key={sourceId}
                        href={`#source-${sourceId}`}
                        className="m3-focus-ring rounded-[var(--m3-shape-xs)] [background:var(--m3-surface-container-high)] px-1.5 py-0.5 font-mono text-[10px] text-foreground underline-offset-2 transition-colors hover:[background:var(--m3-surface-container-highest)] hover:underline"
                        aria-label={`出典 ${sourceId} へ移動`}
                      >
                        [{sourceId}]
                      </a>
                    ))}
                  </div>
                  <p className="mt-0.5 leading-relaxed text-foreground/85">
                    {claim.claim}
                  </p>
                  {claim.reason && (
                    <p className="mt-0.5 leading-relaxed text-muted-foreground">
                      {claim.reason}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function QualityMetric({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good: boolean;
}) {
  return (
    <div className="rounded-[var(--m3-shape-sm)] bg-foreground/[0.04] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-xs font-medium",
          good
            ? "[color:var(--app-status-success)]"
            : "[color:var(--app-status-warning)]",
        )}
      >
        {value}
      </div>
    </div>
  );
}
