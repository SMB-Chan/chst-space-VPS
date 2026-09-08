import { Check, Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import { Chip } from "@/design-system/chip";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import type { TranslationModeSetting } from "@/lib/settings";
import { ResponsiveSelection } from "./responsive-selection";

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

export function translationModeLabel(mode: TranslationModeSetting): string {
  return (
    TRANSLATION_MODES.find((candidate) => candidate.id === mode)?.label ??
    "翻訳"
  );
}

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

  const renderModeOption = (
    mode: (typeof TRANSLATION_MODES)[number],
    surface: "desktop" | "mobile",
    close?: () => void,
  ) => {
    const selected = value === mode.id;
    const optionContent = (
      <>
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
      </>
    );

    if (surface === "mobile") {
      return (
        <button
          key={mode.id}
          type="button"
          onClick={() => {
            onSelect(mode.id);
            close?.();
          }}
          aria-current={selected ? "true" : undefined}
          className={cn(
            "flex min-h-14 w-full items-center gap-3 rounded-[var(--m3-shape-sm)] px-4 py-3 text-left text-sm outline-none transition-[background-color,color,transform] duration-[var(--m3-duration-short)] ease-[var(--m3-motion-standard)] hover:bg-[var(--m3-surface-container-highest)] focus-visible:ring-2 focus-visible:ring-[var(--m3-primary)] active:scale-[0.99]",
            selected &&
              "[background:var(--m3-primary-container)] [color:var(--m3-on-primary-container)]",
          )}
        >
          {optionContent}
        </button>
      );
    }

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
        {optionContent}
      </DropdownMenuItem>
    );
  };

  const selectionHeader = (
    <DropdownMenuLabel className="font-normal">
      <span className="block text-xs font-medium text-foreground">
        翻訳モード
      </span>
      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
        入力を指定した言語へ自動変換して送信します
      </span>
    </DropdownMenuLabel>
  );

  return (
    <ResponsiveSelection
      trigger={
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
      }
      title="翻訳モード"
      description="入力を指定した言語へ自動変換して送信します"
      disabled={disabled}
      contentTestId="dropdown-translation-list"
      desktopContentClassName="w-72"
      desktopContent={
        <>
          {selectionHeader}
          {TRANSLATION_MODES.map((mode) => renderModeOption(mode, "desktop"))}
        </>
      }
      mobileContent={(close) => (
        <div className="space-y-1">
          <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
            入力の変換方法を選択
          </div>
          {TRANSLATION_MODES.map((mode) =>
            renderModeOption(mode, "mobile", close),
          )}
        </div>
      )}
    />
  );
}
