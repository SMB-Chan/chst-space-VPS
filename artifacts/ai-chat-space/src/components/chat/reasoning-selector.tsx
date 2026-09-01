import { Brain } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
    REASONING_LEVELS.find((l) => l.id === value) ?? REASONING_LEVELS[2];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          size="sm"
          data-testid="button-reasoning-selector"
          className={cn(
            "h-8 gap-1.5 px-3 rounded-full text-xs font-medium transition-all duration-200 backdrop-blur-xl",
            "border border-border/60 bg-card/50 text-muted-foreground hover:text-foreground hover:bg-card/80",
            value !== "off" &&
              "text-violet-400/90 border-violet-500/30 bg-violet-500/8 hover:text-violet-300 hover:border-violet-500/50 hover:bg-violet-500/12",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          <Brain className="w-3 h-3" />
          <span>推論 {current.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          推論レベル
        </DropdownMenuLabel>
        {REASONING_LEVELS.map((level) => (
          <DropdownMenuItem
            key={level.id}
            onClick={() => onSelect(level.id)}
            className={cn(
              "flex items-center justify-between cursor-pointer rounded-md",
              value === level.id && "bg-violet-500/10 text-violet-300",
            )}
          >
            <span className="font-medium">{level.label}</span>
            <span className="text-xs text-muted-foreground">{level.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
