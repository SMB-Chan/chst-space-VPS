import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Paperclip, Send, X, File as FileIcon, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { compressImageFile, formatBytes } from "@/lib/compress-image";

interface MessageInputProps {
  // 戻り値がfalseの場合は送信がブロックされた（入力・添付は保持する）
  onSend: (
    content: string,
    file?: { name: string; content: string; isBase64: boolean },
  ) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
}

// 画像のみ対応（PDFなどバイナリは非対応）
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
const ACCEPTED_TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json"];
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `ファイルサイズが大きすぎます（${(file.size / 1024 / 1024).toFixed(1)}MB）。15MB以下のファイルを選択してください。`;
  }
  const isImage = ACCEPTED_IMAGE_TYPES.includes(file.type) || file.type.startsWith("image/");
  const isText = ACCEPTED_TEXT_TYPES.includes(file.type) ||
    file.name.endsWith(".txt") || file.name.endsWith(".md") ||
    file.name.endsWith(".csv") || file.name.endsWith(".json");
  if (!isImage && !isText) {
    return `${file.name} は対応していないファイル形式です。画像（JPEG・PNG・GIF・WebP）またはテキストファイル（TXT・MD・CSV・JSON）を添付してください。`;
  }
  return null;
}

export function MessageInput({ onSend, disabled }: MessageInputProps) {
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
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
    const selected = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!selected) return;

    const error = validateFile(selected);
    if (error) {
      setFileError(error);
      setFile(null);
      setFileNote(null);
      return;
    }

    setFileError(null);
    setCompressing(true);
    try {
      const { file: next, reduced } = await compressImageFile(selected);
      setFile(next);
      setFileNote(
        reduced
          ? `${formatBytes(selected.size)} → ${formatBytes(next.size)} に軽量化`
          : null,
      );
    } catch {
      setFile(selected);
      setFileNote(null);
    } finally {
      setCompressing(false);
      setTimeout(() => textareaRef.current?.focus(), 10);
    }
  };

  const handleSubmit = async () => {
    if ((!content.trim() && !file) || disabled || compressing) return;
    // 実行中ガード（二重送信防止）
    if (isSendingRef.current) return;
    isSendingRef.current = true;

    try {
      let fileData = undefined;

      if (file) {
        const isImage = file.type.startsWith("image/");
        const reader = new FileReader();

        const readFile = new Promise<{ content: string; isBase64: boolean }>((resolve, reject) => {
          reader.onload = (e) => {
            const result = e.target?.result;
            if (typeof result !== "string") {
              reject(new Error("ファイルの読み込みに失敗しました。"));
              return;
            }
            resolve({ content: result, isBase64: isImage });
          };
          reader.onerror = () => {
            reject(new Error("ファイルの読み込みに失敗しました。"));
          };
          if (isImage) {
            reader.readAsDataURL(file);
          } else {
            reader.readAsText(file);
          }
        });

        fileData = {
          name: file.name,
          ...(await readFile),
        };
      }

      const result = await onSend(content.trim() || "このファイルの内容を説明してください。", fileData);
      // 送信がブロックされた場合（例: 画像非対応モデル）は入力・添付を保持する
      if (result === false) return;

      setContent("");
      setFile(null);
      setFileNote(null);
      setFileError(null);

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

  return (
    <div className="relative bg-card rounded-3xl border border-border shadow-lg shadow-black/5 flex flex-col transition-all focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20">
      {fileError && (
        <div className="flex items-start gap-2 px-4 pt-3 pb-1">
          <div className="flex items-start gap-2 px-3 py-2 rounded-2xl bg-destructive/10 border border-destructive/20 text-xs text-destructive w-full animate-in fade-in slide-in-from-bottom-2">
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
      {file && (
        <div className="flex items-center gap-3 px-4 pt-3 pb-1">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-background border border-border text-xs text-foreground max-w-full animate-in fade-in slide-in-from-bottom-2">
            {file.type.startsWith("image/") ? (
              <ImageIcon className="w-3.5 h-3.5 text-primary" />
            ) : (
              <FileIcon className="w-3.5 h-3.5 text-primary" />
            )}
            <span className="truncate font-medium">{file.name}</span>
            {fileNote && (
              <span className="text-muted-foreground shrink-0">{fileNote}</span>
            )}
            <button 
              onClick={() => {
                setFile(null);
                setFileNote(null);
              }}
              className="ml-1 p-0.5 rounded-full hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
      
      <div className="flex items-end gap-2 px-2 py-2">
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleFileChange} 
          className="hidden" 
          accept="image/*,.txt,.md,.csv,.json"
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
          placeholder="メッセージを入力..."
          className="flex-1 max-h-[200px] min-h-[44px] w-full resize-none bg-transparent py-3 px-1 text-base outline-none placeholder:text-muted-foreground/60 scrollbar-none font-sans"
          rows={1}
          disabled={disabled || compressing}
        />
        
        <Button 
          type="button"
          size="icon"
          onClick={handleSubmit}
          disabled={(!content.trim() && !file) || disabled || compressing}
          className={cn(
            "mb-1 w-10 h-10 rounded-full flex-shrink-0 transition-all duration-300",
            content.trim() || file 
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
