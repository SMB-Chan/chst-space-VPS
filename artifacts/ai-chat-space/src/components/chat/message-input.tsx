import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Paperclip,
  Send,
  X,
  File as FileIcon,
  Image as ImageIcon,
  FileText,
  FileSpreadsheet,
  Presentation,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { compressImageFile, formatBytes } from "@/lib/compress-image";

export interface OutgoingAttachment {
  name: string;
  content: string;
  isBase64: boolean;
}

export type FileFormat = "pdf" | "docx" | "xlsx" | "pptx";

interface MessageInputProps {
  // 戻り値がfalseの場合は送信がブロックされた（入力・添付は保持する）
  onSend: (
    content: string,
    files?: OutgoingAttachment[],
    fileFormat?: FileFormat,
  ) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
}

// 画像のみ対応（PDFなどバイナリは非対応）
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
const ACCEPTED_TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json"];
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB / file
const MAX_TOTAL_SIZE_BYTES = 20 * 1024 * 1024; // server-side message cap
const MAX_FILES = 5;

type StagedFile = { file: File; note: string | null };

const FORMAT_BUTTONS: { format: FileFormat; label: string; icon: React.ElementType }[] = [
  { format: "pdf", label: "PDF", icon: FileText },
  { format: "docx", label: "Word", icon: FileText },
  { format: "xlsx", label: "Excel", icon: FileSpreadsheet },
  { format: "pptx", label: "PPT", icon: Presentation },
];

function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `ファイルサイズが大きすぎます（${(file.size / 1024 / 1024).toFixed(1)}MB）。1件15MB以下のファイルを選択してください。`;
  }
  const isImage = ACCEPTED_IMAGE_TYPES.includes(file.type);
  const isText = ACCEPTED_TEXT_TYPES.includes(file.type) ||
    file.name.endsWith(".txt") || file.name.endsWith(".md") ||
    file.name.endsWith(".csv") || file.name.endsWith(".json");
  if (!isImage && !isText) {
    return `${file.name} は対応していないファイル形式です。画像（JPEG・PNG・GIF・WebP・SVG）またはテキストファイル（TXT・MD・CSV・JSON）を添付してください。`;
  }
  return null;
}

function totalSize(files: StagedFile[]): number {
  return files.reduce((sum, item) => sum + item.file.size, 0);
}

function readOne(file: File): Promise<OutgoingAttachment> {
  const isImage = ACCEPTED_IMAGE_TYPES.includes(file.type);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result;
      if (typeof result !== "string") {
        reject(new Error("ファイルの読み込みに失敗しました。"));
        return;
      }
      resolve({ name: file.name, content: result, isBase64: isImage });
    };
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました。"));
    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

export function MessageInput({ onSend, disabled }: MessageInputProps) {
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileFormat, setFileFormat] = useState<FileFormat | null>(null);
  const [compressing, setCompressing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 送信処理中フラグ（二重送信防止）
  const isSendingRef = useRef(false);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME変換確定のEnterは無視する
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (selected.length === 0) return;

    setFileError(null);
    setCompressing(true);
    try {
      const next = [...files];
      const errors: string[] = [];
      for (const item of selected) {
        if (next.length >= MAX_FILES) {
          errors.push(`添付は最大${MAX_FILES}件までです。`);
          break;
        }
        const error = validateFile(item);
        if (error) {
          errors.push(error);
          continue;
        }
        if (next.some((existing) => existing.file.name === item.name && existing.file.size === item.size)) {
          continue;
        }
        try {
          const { file: compressed, reduced } = await compressImageFile(item);
          const candidate = {
            file: compressed,
            note: reduced ? `${formatBytes(item.size)} → ${formatBytes(compressed.size)} に軽量化` : null,
          };
          if (totalSize([...next, candidate]) > MAX_TOTAL_SIZE_BYTES) {
            errors.push(`添付の合計が20MBを超えます。${item.name} を追加できませんでした。`);
            continue;
          }
          next.push(candidate);
        } catch {
          const candidate = { file: item, note: null };
          if (totalSize([...next, candidate]) > MAX_TOTAL_SIZE_BYTES) {
            errors.push(`添付の合計が20MBを超えます。${item.name} を追加できませんでした。`);
            continue;
          }
          next.push(candidate);
        }
      }
      setFiles(next);
      if (errors.length > 0) setFileError(errors.join("\n"));
    } finally {
      setCompressing(false);
      setTimeout(() => textareaRef.current?.focus(), 10);
    }
  };

  const handleSubmit = async () => {
    if ((!content.trim() && files.length === 0) || disabled || compressing) return;
    // 実行中ガード（二重送信防止）
    if (isSendingRef.current) return;
    isSendingRef.current = true;

    try {
      const attachments = files.length > 0
        ? await Promise.all(files.map((item) => readOne(item.file)))
        : undefined;

      const result = await onSend(
        content.trim() || "添付ファイルの内容を説明してください。",
        attachments,
        fileFormat ?? undefined,
      );
      // 送信がブロックされた場合（例: 画像非対応モデル）は入力・添付を保持する
      if (result === false) return;

      setContent("");
      setFiles([]);
      setFileError(null);
      setFileFormat(null);

      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "送信に失敗しました。");
    } finally {
      isSendingRef.current = false;
    }
  };

  const adjustHeight = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    setContent(el.value);
  }, []);

  const hasFiles = files.length > 0;

  return (
    <div className="relative bg-card rounded-3xl border border-border shadow-lg shadow-black/5 flex flex-col transition-all focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20">
      {fileError && (
        <div className="flex items-start gap-2 px-4 pt-3 pb-1">
          <div className="flex items-start gap-2 px-3 py-2 rounded-2xl bg-destructive/10 border border-destructive/20 text-xs text-destructive w-full animate-in fade-in slide-in-from-bottom-2 whitespace-pre-wrap">
            <span className="shrink-0 mt-0.5">⚠️</span>
            <span>{fileError}</span>
            <button
              onClick={() => setFileError(null)}
              className="ml-auto p-0.5 rounded-full hover:bg-destructive/20 transition-colors shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
      {compressing && (
        <div className="px-4 pt-3 pb-1 text-xs text-muted-foreground">画像を軽量化しています...</div>
      )}
      {hasFiles && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-1">
          {files.map((item, index) => (
            <div
              key={`${item.file.name}-${item.file.size}-${index}`}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-background border border-border text-xs text-foreground max-w-full animate-in fade-in slide-in-from-bottom-2"
            >
              {item.file.type.startsWith("image/") ? (
                <ImageIcon className="w-3.5 h-3.5 text-primary shrink-0" />
              ) : (
                <FileIcon className="w-3.5 h-3.5 text-primary shrink-0" />
              )}
              <span className="truncate font-medium max-w-[10rem]">{item.file.name}</span>
              {item.note && (
                <span className="text-muted-foreground shrink-0 hidden sm:inline">{item.note}</span>
              )}
              <button
                onClick={() => {
                  setFiles((prev) => prev.filter((_, i) => i !== index));
                }}
                className="ml-1 p-0.5 rounded-full hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition-colors shrink-0"
                aria-label={`${item.file.name} を外す`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1 px-3 pt-2 pb-0 flex-wrap">
        {FORMAT_BUTTONS.map(({ format, label, icon: Icon }) => {
          const active = fileFormat === format;
          return (
            <button
              key={format}
              type="button"
              onClick={() => setFileFormat(active ? null : format)}
              disabled={disabled || compressing}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border transition-colors",
                active
                  ? "bg-primary/10 border-primary/40 text-primary"
                  : "bg-background border-border text-muted-foreground hover:text-foreground hover:border-foreground/20",
                (disabled || compressing) && "opacity-50 cursor-not-allowed",
              )}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          );
        })}
      </div>

      <div className="flex items-end gap-2 px-2 py-2">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="hidden"
          accept="image/*,.txt,.md,.csv,.json"
          multiple
        />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          className="mb-1 w-10 h-10 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-full flex-shrink-0 transition-colors"
          disabled={disabled || compressing}
        >
          <Paperclip className="w-5 h-5" />
        </Button>

        <textarea
          ref={textareaRef}
          value={content}
          onChange={adjustHeight}
          onKeyDown={handleKeyDown}
          placeholder={fileFormat ? `この内容を ${fileFormat.toUpperCase()} で生成...` : "メッセージを入力..."}
          className="flex-1 max-h-[200px] min-h-[44px] w-full resize-none bg-transparent py-3 px-1 text-base outline-none placeholder:text-muted-foreground/60 scrollbar-none font-sans"
          rows={1}
          disabled={disabled || compressing}
        />

        <Button
          type="button"
          size="icon"
          onClick={handleSubmit}
          disabled={(!content.trim() && !hasFiles) || disabled || compressing}
          className={cn(
            "mb-1 w-10 h-10 rounded-full flex-shrink-0 transition-all duration-300",
            content.trim() || hasFiles
              ? "bg-primary text-primary-foreground shadow-md hover:bg-primary/90 hover:scale-105"
              : "bg-muted text-muted-foreground"
          )}
        >
          <Send className="w-4 h-4 ml-0.5" />
        </Button>
      </div>
    </div>
  );
}
