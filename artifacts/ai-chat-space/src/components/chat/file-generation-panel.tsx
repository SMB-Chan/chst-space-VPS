import { FileText, Eye, RefreshCw, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type FileGenerationPhase =
  "generating-file" | "reviewing-layout" | "revising-layout";

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
        "relative w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all duration-500",
        state === "completed"
          ? "bg-primary border-primary text-primary-foreground"
          : state === "active"
            ? "bg-primary/10 border-primary text-primary scale-110"
            : "bg-muted border-border text-muted-foreground",
      )}
    >
      {state === "completed" ? (
        <Check className="w-4 h-4" />
      ) : state === "active" ? (
        <Icon className="w-4 h-4 animate-pulse" />
      ) : (
        <Icon className="w-4 h-4" />
      )}
      {state === "active" && (
        <span className="absolute inset-0 rounded-full border-2 border-primary opacity-40 animate-ping" />
      )}
    </div>
  );
}

export function FileGenerationPanel({ phase }: { phase: FileGenerationPhase }) {
  const activeIndex = STEPS.findIndex((s) => s.id === phase);

  return (
    <div className="w-full rounded-3xl border border-border/60 bg-card/60 backdrop-blur-xl shadow-lg p-4 space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0 overflow-hidden">
          <FileText className="w-5 h-5 relative z-10" />
          <div className="absolute inset-0 bg-gradient-to-tr from-primary/20 to-transparent animate-pulse" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground flex items-center gap-2">
            ファイルを生成中
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {STEPS[activeIndex]?.label ?? "準備中"}
          </div>
        </div>
      </div>

      {/* Progress bar with shimmer */}
      <div className="relative h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-primary/60 via-primary to-primary/60 transition-all duration-700",
            phase === "generating-file" && "w-1/3",
            phase === "reviewing-layout" && "w-2/3",
            phase === "revising-layout" && "w-full",
          )}
          style={{
            backgroundSize: "200% 100%",
            animation: "shimmer 2s linear infinite",
          }}
        />
      </div>

      {/* Step indicator */}
      <div className="relative flex items-start justify-between">
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
              className="flex flex-col items-center gap-2 z-10"
            >
              <StepIcon step={step} state={state} />
              <span
                className={cn(
                  "text-[10px] font-medium transition-colors duration-300",
                  state === "active"
                    ? "text-primary"
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
        {/* Connecting line */}
        <div className="absolute top-4 left-0 right-0 h-0.5 bg-muted -z-0 mx-4" />
        <div
          className="absolute top-4 left-0 h-0.5 bg-primary -z-0 mx-4 transition-all duration-700"
          style={{
            width:
              activeIndex === 0 ? "16%" : activeIndex === 1 ? "50%" : "84%",
          }}
        />
      </div>
    </div>
  );
}
