import { Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TranslationModeSetting } from "@/lib/settings";

const TRANSLATION_MODES: { id: TranslationModeSetting; label: string; hint: string }[] = [
  { id: "off", label: "OFF", hint: "通常の会話" },
  { id: "auto", label: "自動（日⇄英）", hint: "日本語は英語へ、それ以外は日本語へ" },
  { id: "ja-en", label: "日本語 → 英語", hint: "常に英語へ翻訳" },
  { id: "en-ja", label: "英語 → 日本語", hint: "常に日本語へ翻訳" },
];

interface TranslationModeSelectorProps {
  value: TranslationModeSetting;
  onSelect: (mode: TranslationModeSetting) => void;
  disabled?: boolean;
}

export function TranslationModeSelector({ value, onSelect, disabled }: TranslationModeSelectorProps) {
  const current = TRANSLATION_MODES.find((m) => m.id === value) ?? TRANSLATION_MODES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          size="sm"
          data-testid="button-translation-selector"
          className={cn(
            "h-7 gap-1.5 px-2.5 rounded-full text-xs font-medium transition-all",
            "border border-border/50 text-muted-foreground hover:text-foreground hover:border-border",
            "hover:bg-muted/40",
            value !== "off" && "text-emerald-400/90 border-emerald-500/30 hover:text-emerald-300 hover:border-emerald-500/50",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          <Languages className="w-3 h-3" />
          <span>翻訳 {current.id === "off" ? "" : current.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          翻訳モード — 送るだけで翻訳します
        </DropdownMenuLabel>
        {TRANSLATION_MODES.map((mode) => (
          <DropdownMenuItem
            key={mode.id}
            onClick={() => onSelect(mode.id)}
            className={cn(
              "flex items-center justify-between cursor-pointer rounded-md",
              value === mode.id && "bg-emerald-500/10 text-emerald-300",
            )}
          >
            <span className="font-medium">{mode.label}</span>
            <span className="text-xs text-muted-foreground">{mode.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
