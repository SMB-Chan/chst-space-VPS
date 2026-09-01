import { Check, Eye, FileText, Loader2, RefreshCw } from "lucide-react";
import { Surface } from "@/design-system/surface";
import { cn } from "@/lib/utils";

export type FileGenerationPhase =
  | "generating-file"
  | "reviewing-layout"
  | "revising-layout";

interface Step {
  id: FileGenerationPhase;
  label: string;
  icon: React.ElementType;
}

const STEPS: Step[] = [
  { id: "generating-file", label: "作成中", icon: FileText },
  { id: "reviewing-layout", label: "確認中", icon: Eye },
  { id: "revising-layout", label: "仕上げ中", icon: RefreshCw },
];

function StepIcon({
  step,
  state,
}: {
  step: Step;
  state: "pending" | "active" | "completed";
}) {
  const Icon = step.icon;
  return (
    <div
      className={cn(
        "relative flex h-9 w-9 items-center justify-center rounded-[var(--m3-shape-full)] border transition-[background-color,border-color,color,transform] duration-[var(--m3-duration-long)] ease-[var(--m3-motion-expressive)]",
        state === "completed"
          ? "[background:var(--m3-primary)] [border-color:var(--m3-primary)] [color:var(--m3-on-primary)]"
          : state === "active"
            ? "scale-110 [background:var(--m3-primary-container)] [border-color:var(--m3-primary)] [color:var(--m3-on-primary-container)]"
            : "[background:var(--m3-surface-container-high)] [border-color:var(--m3-outline-variant)] text-muted-foreground",
      )}
      aria-current={state === "active" ? "step" : undefined}
    >
      {state === "completed" ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : state === "active" ? (
        <Icon className="h-4 w-4 animate-pulse" aria-hidden="true" />
      ) : (
        <Icon className="h-4 w-4" aria-hidden="true" />
      )}
      {state === "active" && (
        <span
          className="absolute inset-0 animate-ping rounded-[var(--m3-shape-full)] border [border-color:var(--m3-primary)] opacity-30"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export function FileGenerationPanel({ phase }: { phase: FileGenerationPhase }) {
  const activeIndex = STEPS.findIndex((step) => step.id === phase);
  const progress = ((Math.max(activeIndex, 0) + 1) / STEPS.length) * 100;

  return (
    <Surface
      tone="outlined"
      shape="large"
      className="w-full space-y-4 p-4 shadow-[var(--m3-elevation-1)]"
      aria-label="ファイル生成の進捗"
    >
      <div className="flex items-center gap-3">
        <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[var(--m3-shape-lg)] [background:var(--m3-primary-container)] [color:var(--m3-on-primary-container)]">
          <FileText className="relative z-10 h-5 w-5" aria-hidden="true" />
          <div
            className="absolute inset-0 animate-pulse bg-gradient-to-tr from-primary/20 to-transparent"
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            ファイルを生成中
            <Loader2
              className="h-3.5 w-3.5 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {STEPS[activeIndex]?.label ?? "準備中"}
          </div>
        </div>
        <span className="rounded-[var(--m3-shape-full)] [background:var(--m3-primary-container)] px-2 py-1 text-[10px] font-semibold tabular-nums [color:var(--m3-on-primary-container)]">
          {Math.round(progress)}%
        </span>
      </div>

      <div
        className="relative h-1.5 overflow-hidden rounded-[var(--m3-shape-full)] [background:var(--m3-surface-container-high)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        aria-label="ファイル生成の進捗率"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-[var(--m3-shape-full)] [background:var(--m3-primary)] transition-[width] duration-[var(--m3-duration-long)] ease-[var(--m3-motion-emphasized)]"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="relative flex items-start justify-between">
        <div
          className="absolute left-4 right-4 top-[18px] h-px [background:var(--m3-outline-variant)]"
          aria-hidden="true"
        />
        <div
          className="absolute left-4 top-[18px] h-px [background:var(--m3-primary)] transition-[width] duration-[var(--m3-duration-long)] ease-[var(--m3-motion-emphasized)]"
          style={{ width: `calc((100% - 2rem) * ${Math.max(activeIndex, 0) / (STEPS.length - 1)})` }}
          aria-hidden="true"
        />
        {STEPS.map((step, index) => {
          const state =
            index < activeIndex
              ? "completed"
              : index === activeIndex
                ? "active"
                : "pending";
          return (
            <div
              key={step.id}
              className="z-10 flex min-w-16 flex-col items-center gap-2"
            >
              <StepIcon step={step} state={state} />
              <span
                className={cn(
                  "text-[10px] font-medium transition-colors duration-[var(--m3-duration-medium)]",
                  state === "active"
                    ? "[color:var(--m3-primary)]"
                    : state === "completed"
                      ? "text-foreground"
                      : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </Surface>
  );
}
