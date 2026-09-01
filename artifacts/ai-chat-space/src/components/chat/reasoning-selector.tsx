import { Brain, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Chip } from "@/design-system/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { REASONING_LEVELS, type ReasoningLevel } from "@/lib/reasoning";

interface ReasoningSelectorProps {
  value: ReasoningLevel;
  onSelect: (level: ReasoningLevel) => void;
  disabled?: boolean;
}

export function ReasoningSelector({
  value,
  onSelect,
  disabled,
}: ReasoningSelectorProps) {
  const current =
    REASONING_LEVELS.find((level) => level.id === value) ?? REASONING_LEVELS[2];
  const active = value !== "off";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Chip
          selected={active}
          disabled={disabled}
          data-testid="button-reasoning-selector"
          className="h-8 justify-start"
          aria-label={`推論レベル: ${current.label}`}
        >
          <Brain className="h-3.5 w-3.5" aria-hidden="true" />
          <span>推論 {current.label}</span>
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-xs font-medium text-foreground">
            推論レベル
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            応答速度と推論の深さを切り替えます
          </span>
        </DropdownMenuLabel>
        {REASONING_LEVELS.map((level) => {
          const selected = value === level.id;
          return (
            <DropdownMenuItem
              key={level.id}
              onClick={() => onSelect(level.id)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "min-h-11 cursor-pointer items-center gap-3 rounded-[var(--m3-shape-sm)]",
                selected &&
                  "[background:var(--m3-primary-container)] [color:var(--m3-on-primary-container)]",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{level.label}</span>
                <span
                  className={cn(
                    "block text-[11px] leading-relaxed text-muted-foreground",
                    selected && "text-current/70",
                  )}
                >
                  {level.hint}
                </span>
              </span>
              <Check
                className={cn(
                  "h-4 w-4 shrink-0 transition-opacity",
                  selected ? "opacity-100" : "opacity-0",
                )}
                aria-hidden="true"
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
