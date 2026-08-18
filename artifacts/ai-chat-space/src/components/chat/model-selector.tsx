import { ChevronDown, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export interface ModelInfo {
  id: string;
  label: string;
  provider: "openai" | "dashscope";
  description: string;
}

const MODELS: ModelInfo[] = [
  { id: "gpt-5.6-terra",   label: "GPT-5.6 Terra",   provider: "openai", description: "高性能・汎用" },
  { id: "gpt-5.6-luna",    label: "GPT-5.6 Luna",    provider: "openai", description: "高速・低コスト" },
  { id: "o4-mini",         label: "o4-mini",          provider: "openai", description: "高度な推論" },
  { id: "qwen3.8-max",     label: "Qwen3.8 Max",     provider: "dashscope", description: "Alibaba最高性能" },
  { id: "qwen3.7-plus",    label: "Qwen3.7 Plus",    provider: "dashscope", description: "高速・バランス" },
  { id: "qwen3.6-flash",   label: "Qwen3.6 Flash",   provider: "dashscope", description: "最速・低コスト" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "dashscope", description: "推論特化" },
  { id: "glm-5.2",         label: "GLM-5.2",         provider: "dashscope", description: "汎用" },
];

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  dashscope: "Alibaba Cloud (Qwen)",
};

interface ModelSelectorProps {
  selectedModel: string;
  onSelect: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ selectedModel, onSelect, disabled }: ModelSelectorProps) {
  const current = MODELS.find((m) => m.id === selectedModel) ?? MODELS[0];

  const openaiModels = MODELS.filter((m) => m.provider === "openai");
  const qwenModels = MODELS.filter((m) => m.provider === "dashscope");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          size="sm"
          data-testid="button-model-selector"
          className={cn(
            "h-7 gap-1.5 px-2.5 rounded-full text-xs font-medium transition-all",
            "border border-border/50 text-muted-foreground hover:text-foreground hover:border-border",
            "hover:bg-muted/40",
            current.provider === "dashscope" && "text-amber-400/80 border-amber-500/30 hover:text-amber-400 hover:border-amber-500/50",
            disabled && "opacity-50 cursor-not-allowed"
          )}
        >
          <Cpu className="w-3 h-3" />
          <span>{current.label}</span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-56" data-testid="dropdown-model-list">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          {PROVIDER_LABELS["openai"]}
        </DropdownMenuLabel>
        {openaiModels.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onClick={() => onSelect(model.id)}
            data-testid={`model-option-${model.id}`}
            className={cn(
              "flex items-center justify-between cursor-pointer rounded-md",
              selectedModel === model.id && "bg-primary/10 text-primary"
            )}
          >
            <span className="font-medium">{model.label}</span>
            <span className="text-xs text-muted-foreground">{model.description}</span>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs text-amber-400/70 font-normal">
          {PROVIDER_LABELS["dashscope"]}
        </DropdownMenuLabel>
        {qwenModels.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onClick={() => onSelect(model.id)}
            data-testid={`model-option-${model.id}`}
            className={cn(
              "flex items-center justify-between cursor-pointer rounded-md",
              selectedModel === model.id && "bg-amber-500/10 text-amber-400"
            )}
          >
            <span className="font-medium">{model.label}</span>
            <span className="text-xs text-muted-foreground">{model.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { MODELS };
