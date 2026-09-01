import { Check, Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import { Chip } from "@/design-system/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TranslationModeSetting } from "@/lib/settings";

const TRANSLATION_MODES: {
  id: TranslationModeSetting;
  label: string;
  hint: string;
}[] = [
  { id: "off", label: "OFF", hint: "通常の会話" },
  {
    id: "auto",
    label: "自動（日⇄英）",
    hint: "日本語は英語へ、それ以外は日本語へ",
  },
  { id: "ja-en", label: "日本語 → 英語", hint: "常に英語へ翻訳" },
  { id: "en-ja", label: "英語 → 日本語", hint: "常に日本語へ翻訳" },
  {
    id: "auto-ko",
    label: "自動（日⇄韓）",
    hint: "日本語は韓国語へ、韓国語は日本語へ",
  },
  { id: "ja-ko", label: "日本語 → 韓国語", hint: "常に韓国語へ翻訳" },
  { id: "ko-ja", label: "韓国語 → 日本語", hint: "常に日本語へ翻訳" },
  {
    id: "auto-zh",
    label: "自動（日⇄中）",
    hint: "日本語は中国語へ、中国語は日本語へ",
  },
  { id: "ja-zh", label: "日本語 → 中国語", hint: "簡体字・本土表現へ翻訳" },
  { id: "zh-ja", label: "中国語 → 日本語", hint: "常に日本語へ翻訳" },
];

interface TranslationModeSelectorProps {
  value: TranslationModeSetting;
  onSelect: (mode: TranslationModeSetting) => void;
  disabled?: boolean;
}

export function TranslationModeSelector({
  value,
  onSelect,
  disabled,
}: TranslationModeSelectorProps) {
  const current =
    TRANSLATION_MODES.find((mode) => mode.id === value) ?? TRANSLATION_MODES[0];
  const active = value !== "off";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Chip
          selected={active}
          disabled={disabled}
          data-testid="button-translation-selector"
          className="h-8 justify-start"
          aria-label={`翻訳モード: ${current.label}`}
        >
          <Languages className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{active ? `翻訳 ${current.label}` : "翻訳"}</span>
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-xs font-medium text-foreground">
            翻訳モード
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            入力を指定した言語へ自動変換して送信します
          </span>
        </DropdownMenuLabel>
        {TRANSLATION_MODES.map((mode) => {
          const selected = value === mode.id;
          return (
            <DropdownMenuItem
              key={mode.id}
              onClick={() => onSelect(mode.id)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "min-h-11 cursor-pointer items-center gap-3 rounded-[var(--m3-shape-sm)]",
                selected &&
                  "[background:var(--m3-primary-container)] [color:var(--m3-on-primary-container)]",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{mode.label}</span>
                <span
                  className={cn(
                    "block text-[11px] leading-relaxed text-muted-foreground",
                    selected && "text-current/70",
                  )}
                >
                  {mode.hint}
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
