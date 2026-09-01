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

export type FactualityVerdict = "supported" | "contradicted" | "unknown";
export type FactualityStatus = "verified" | "mixed" | "insufficient";

export interface FactualityClaim {
  claim: string;
  verdict: FactualityVerdict;
  sourceIds: number[];
  reason: string;
}

export interface FactualityReport {
  status: FactualityStatus;
  summary: string;
  claims: FactualityClaim[];
  modelId: string;
  corrected: boolean;
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
  };
}

const statusUi: Record<
  FactualityStatus,
  { label: string; className: string; icon: typeof ShieldCheck }
> = {
  verified: {
    label: "根拠対応済み",
    className:
      "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
    icon: ShieldCheck,
  },
  mixed: {
    label: "一部は追加確認が必要",
    className:
      "border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300",
    icon: AlertTriangle,
  },
  insufficient: {
    label: "根拠不足",
    className:
      "border-slate-400/35 bg-slate-500/8 text-slate-700 dark:text-slate-300",
    icon: CircleHelp,
  },
};

const verdictUi: Record<
  FactualityVerdict,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  supported: {
    label: "根拠あり",
    className: "text-emerald-700 dark:text-emerald-300",
    icon: CheckCircle2,
  },
  contradicted: {
    label: "矛盾あり",
    className: "text-red-700 dark:text-red-300",
    icon: AlertTriangle,
  },
  unknown: {
    label: "確認不能",
    className: "text-amber-700 dark:text-amber-300",
    icon: CircleHelp,
  },
};

export function FactualityCard({ report }: { report: FactualityReport }) {
  const [expanded, setExpanded] = useState(report.status !== "verified");
  const ui = statusUi[report.status];
  const StatusIcon = ui.icon;
  const supportedCount = report.claims.filter(
    (claim) => claim.verdict === "supported",
  ).length;

  return (
    <section
      className={cn(
        "w-full overflow-hidden rounded-2xl border text-xs backdrop-blur-xl",
        ui.className,
      )}
      aria-label="回答の根拠チェック"
    >
      <button
        type="button"
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <StatusIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 font-medium">
            <span>{ui.label}</span>
            {report.claims.length > 0 && (
              <span className="font-normal opacity-75">
                {supportedCount}/{report.claims.length}件
              </span>
            )}
            {report.corrected && (
              <span className="inline-flex items-center gap-1 rounded-full border border-current/20 px-1.5 py-0.5 text-[10px] font-normal">
                <Wrench className="h-2.5 w-2.5" /> 本文修正済み
              </span>
            )}
          </span>
          <span className="mt-0.5 block leading-relaxed opacity-85">
            {report.summary}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 transition-transform",
            expanded && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {expanded && report.claims.length > 0 && (
        <ol className="space-y-2 border-t border-current/10 px-3 py-2.5">
          {report.claims.map((claim, index) => {
            const claimUi = verdictUi[claim.verdict];
            const ClaimIcon = claimUi.icon;
            return (
              <li key={`${claim.claim}-${index}`} className="flex gap-2">
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
                        className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-[10px] underline-offset-2 hover:underline"
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
                    <p className="mt-0.5 leading-relaxed opacity-70">
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
