import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { MODELS, useAvailableModels } from "@/components/chat/model-selector";
import { REASONING_LEVELS, type ReasoningLevel } from "@/lib/reasoning";
import { cn } from "@/lib/utils";

export type SpeedPreference = "standard" | "fast";

const SPEED_OPTIONS: { id: SpeedPreference; label: string }[] = [
  { id: "fast", label: "高速" },
  { id: "standard", label: "標準" },
];

const REASONING_DISPLAY: Record<ReasoningLevel, string> = {
  off: "オフ",
  low: "軽",
  medium: "標準",
  high: "深",
};

interface ModelSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  reasoningLevel: ReasoningLevel;
  onReasoningChange: (level: ReasoningLevel) => void;
  speed: SpeedPreference;
  onSpeedChange: (speed: SpeedPreference) => void;
}

export function ModelSettingsSheet({
  open,
  onOpenChange,
  selectedModel,
  onSelectModel,
  reasoningLevel,
  onReasoningChange,
  speed,
  onSpeedChange,
}: ModelSettingsSheetProps) {
  const available = useAvailableModels();
  const [picking, setPicking] = useState<null | "reasoning" | "speed">(null);

  const models = useMemo(() => available, [available]);

  const defaultEntry = useMemo(
    () => ({
      id: "default",
      label: "デフォルト",
      description: "おすすめのフロンティアモデルセット",
    }),
    [],
  );

  const rows = useMemo(() => {
    const catalog = models.length > 0 ? models : MODELS;
    return [
      defaultEntry,
      ...catalog.map((model) => ({
        id: model.id,
        label: model.label,
        description: model.description,
      })),
    ];
  }, [defaultEntry, models]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="mobile-sheet-content"
        data-testid="mobile-model-sheet"
      >
        <div className="mobile-sheet-handle" aria-hidden />
        <DrawerHeader className="p-0">
          <DrawerTitle className="mobile-sheet-title">設定</DrawerTitle>
        </DrawerHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mobile-sheet-section" role="listbox" aria-label="モデル">
            {rows.map((row) => {
              const selected =
                row.id === "default"
                  ? !selectedModel || selectedModel === "default"
                  : selectedModel === row.id;
              return (
                <button
                  key={row.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="mobile-option-row"
                  onClick={() => onSelectModel(row.id === "default" ? models[0]?.id ?? selectedModel : row.id)}
                  data-testid={`mobile-model-option-${row.id}`}
                >
                  <span className="min-w-0">
                    <span className="block font-medium">{row.label}</span>
                    {"description" in row && row.description ? (
                      <span className="sub">{row.description}</span>
                    ) : null}
                  </span>
                  {selected ? (
                    <Check className="check h-5 w-5" aria-hidden />
                  ) : (
                    <span className="w-5" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>

          <div className="mobile-sheet-section">
            <button
              type="button"
              className="mobile-select-row"
              aria-expanded={picking === "reasoning"}
              onClick={() =>
                setPicking((current) =>
                  current === "reasoning" ? null : "reasoning",
                )
              }
              data-testid="mobile-reasoning-row"
            >
              <span>推論レベル</span>
              <span className="value">
                {REASONING_DISPLAY[reasoningLevel]}
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform",
                    picking === "reasoning" && "rotate-180",
                  )}
                />
              </span>
            </button>
            {picking === "reasoning" && (
              <div className="pb-2" role="listbox" aria-label="推論レベル">
                {REASONING_LEVELS.map((level) => (
                  <button
                    key={level.id}
                    type="button"
                    role="option"
                    aria-selected={reasoningLevel === level.id}
                    className="mobile-option-row"
                    onClick={() => {
                      onReasoningChange(level.id);
                      setPicking(null);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block">{REASONING_DISPLAY[level.id]}</span>
                      <span className="sub">{level.hint}</span>
                    </span>
                    {reasoningLevel === level.id ? (
                      <Check className="check h-5 w-5" aria-hidden />
                    ) : (
                      <span className="w-5" aria-hidden />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mobile-sheet-section">
            <button
              type="button"
              className="mobile-select-row"
              aria-expanded={picking === "speed"}
              onClick={() =>
                setPicking((current) => (current === "speed" ? null : "speed"))
              }
              data-testid="mobile-speed-row"
            >
              <span>速度</span>
              <span className="value">
                {SPEED_OPTIONS.find((option) => option.id === speed)?.label}
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform",
                    picking === "speed" && "rotate-180",
                  )}
                />
              </span>
            </button>
            {picking === "speed" && (
              <div className="pb-2" role="listbox" aria-label="速度">
                {SPEED_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={speed === option.id}
                    className="mobile-option-row"
                    onClick={() => {
                      onSpeedChange(option.id);
                      setPicking(null);
                    }}
                  >
                    <span>{option.label}</span>
                    {speed === option.id ? (
                      <Check className="check h-5 w-5" aria-hidden />
                    ) : (
                      <span className="w-5" aria-hidden />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          className="mobile-done-btn"
          onClick={() => onOpenChange(false)}
          data-testid="mobile-sheet-done"
        >
          完了
        </button>
      </DrawerContent>
    </Drawer>
  );
}

export function formatModelChipLabel(
  modelLabel: string | undefined,
  reasoning: ReasoningLevel,
): string {
  const name = modelLabel?.replace(/^GPT-/, "") ?? "モデル";
  return `${name} ${REASONING_DISPLAY[reasoning]}`;
}
