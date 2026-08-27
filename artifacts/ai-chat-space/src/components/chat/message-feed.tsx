import { useRef, useEffect, useState } from "react";
import { OpenaiMessage, getGetOpenaiAssetUrl } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { SafeMarkdown } from "./safe-markdown";
import { SourceCards } from "./source-cards";
import { FileGenerationPanel, type FileGenerationPhase } from "./file-generation-panel";
import { Loader2, Paperclip, Bot, ChevronDown, FileText, Download, ArrowDown, Square, Sparkles, Volume2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useUser } from "@clerk/react";
import { getModelLabel } from "./model-selector";
import { STREAMING_ASSISTANT_ID } from "@/lib/chat";
import { parseAttachmentMessageForDisplay } from "@/lib/attachments";

export type StreamingPhase =
  | "starting"
  | "searching"
  | "reading-images"
  | "reading-files"
  | "thinking"
  | "generating"
  | "generating-file"
  | "reviewing-layout"
  | "revising-layout"
  | "auditing"
  | "revising"
  | null;

export type ChatArtifact = {
  id?: number;
  filename: string;
  mime: string;
  size: number;
  downloadUrl?: string;
  content?: string;
};

type DisplayMessage = OpenaiMessage & {
  auditContent?: string | null;
  auditModelId?: string | null;
  artifacts?: ChatArtifact[] | null;
  assetIds?: number[] | null;
  generatedAssets?: {
    id: number;
    filename: string;
    mimeType: string;
    size: number;
    downloadUrl?: string;
  }[] | null;
};

function normalizeSources(value: unknown): { title: string; url: string }[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeAssetIds(value: unknown): number[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === "number") : null;
  } catch {
    return null;
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

interface MessageFeedProps {
  messages: OpenaiMessage[];
  isLoading: boolean;
  streamingPhase?: StreamingPhase;
  specialistProgress?: { capability: string; phase: string; message?: string } | null;
  streamingFiles?: { id: number; filename: string; mimeType: string }[];
  streamingAudit?: string;
  isStreaming?: boolean;
  onStop?: () => void;
  streamingWarning?: string | null;
  onDismissWarning?: () => void;
}

function SpecialistProgress({
  progress,
}: {
  progress: { capability: string; phase: string; message?: string };
}) {
  const labels: Record<string, string> = {
    generate_image: "画像生成",
    edit_image: "画像編集",
    transcribe_audio: "音声認識",
    synthesize_speech: "音声合成",
  };
  const label = labels[progress.capability] ?? "専門能力";
  const failed = progress.phase === "failed";
  const completed = progress.phase === "completed";
  const phaseLabel =
    progress.phase === "planned"
      ? "準備中"
      : progress.phase === "running"
        ? "実行中"
        : completed
          ? "完了"
          : "失敗";
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        failed
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
      )}
    >
      {failed || completed ? (
        <Sparkles className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      )}
      <span className="font-medium">{label}</span>
      <span className="text-current/80">{progress.message ?? phaseLabel}</span>
    </div>
  );
}

function PhaseDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" />
    </span>
  );
}

function AuditCard({
  content,
  modelId,
  live,
}: {
  content: string;
  modelId?: string | null;
  live?: boolean;
}) {
  const [open, setOpen] = useState(!!live);
  if (!content && !live) return null;
  return (
    <div className="w-full rounded-xl border border-sky-500/25 bg-sky-500/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-sky-300/90 hover:bg-sky-500/10"
      >
        <span className="font-medium">{live ? "監査中" : "点検メモ"}</span>
        {modelId ? <span className="opacity-70">{modelId}</span> : null}
        {live ? <PhaseDots /> : null}
        <ChevronDown className={cn("w-3.5 h-3.5 ml-auto transition-transform", open && "rotate-180")} />
      </button>
      {open && content ? (
        <div className="px-3 pb-3 text-[13px] leading-relaxed break-words [overflow-wrap:anywhere]">
          <SafeMarkdown content={content} />
        </div>
      ) : null}
    </div>
  );
}

function ArtifactCards({ artifacts }: { artifacts: ChatArtifact[] }) {
  return (
    <div className="w-full grid gap-2">
      {artifacts.map((artifact, index) => (
        <div key={artifact.id ?? `${artifact.filename}-${index}`} className="grid gap-2">
          {artifact.mime.startsWith("image/") && artifact.downloadUrl ? (
            <img src={artifact.downloadUrl} alt={artifact.filename} className="max-h-80 w-auto max-w-full rounded-xl border border-border object-contain" />
          ) : null}
          {artifact.mime.startsWith("audio/") && artifact.downloadUrl ? (
            <audio
              controls
              preload="metadata"
              src={artifact.downloadUrl}
              className="w-full max-w-xl"
              aria-label={`音声 ${artifact.filename}`}
            />
          ) : null}
          <a
            href={artifact.downloadUrl}
            download={artifact.filename}
            className={cn(
              "flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-3 shadow-sm transition-colors",
              artifact.downloadUrl ? "hover:border-primary/40 hover:bg-primary/5" : "opacity-70 pointer-events-none",
            )}
          >
            <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              {artifact.mime.startsWith("audio/") ? (
                <Volume2 className="w-[1.125rem] h-[1.125rem]" />
              ) : (
                <FileText className="w-[1.125rem] h-[1.125rem]" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{artifact.filename}</div>
              <div className="text-[11px] text-muted-foreground truncate">{artifact.mime} ・ {formatBytes(artifact.size)}</div>
            </div>
            <Download className="w-4 h-4 text-muted-foreground shrink-0" />
          </a>
        </div>
      ))}
    </div>
  );
}

function FileDownloadButton({
  assetId,
  filename,
  mimeType,
}: {
  assetId: number;
  filename?: string;
  mimeType?: string;
}) {
  const downloadUrl = getGetOpenaiAssetUrl(assetId);
  return (
    <div className="grid gap-2">
      {mimeType?.startsWith("image/") ? (
        <img
          src={downloadUrl}
          alt={filename ?? "生成画像"}
          className="max-h-80 w-auto max-w-full rounded-xl border border-border object-contain"
        />
      ) : null}
      {mimeType?.startsWith("audio/") ? (
        <audio
          controls
          preload="metadata"
          src={downloadUrl}
          className="w-full max-w-xl"
          aria-label={`音声 ${filename ?? "生成音声"}`}
        />
      ) : null}
      <a
        href={downloadUrl}
        download={filename}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground shadow-sm hover:bg-primary/5 hover:border-primary/30 transition-colors"
      >
        {mimeType?.startsWith("audio/") ? (
          <Volume2 className="w-4 h-4 text-primary" />
        ) : (
          <FileText className="w-4 h-4 text-primary" />
        )}
        <span className="font-medium truncate max-w-[180px]">{filename ?? "生成ファイルをダウンロード"}</span>
        <Download className="w-3.5 h-3.5 text-muted-foreground" />
      </a>
    </div>
  );
}

function GenerationBadge({ phase }: { phase: StreamingPhase }) {
  if (!phase) return null;
  const label =
    phase === "thinking"
      ? "推論中"
      : phase === "searching"
        ? "Webを検索中"
      : phase === "reading-images"
        ? "画像を読み取り中"
        : phase === "reading-files"
          ? "ファイルを解析中"
        : phase === "generating-file"
        ? "ファイルを生成中"
        : phase === "reviewing-layout"
          ? "レイアウトを確認中"
          : phase === "revising-layout"
            ? "レイアウトを修正中"
            : phase === "generating"
              ? "生成中"
              : phase === "auditing"
                ? "監査中"
                : phase === "revising"
                  ? "最終報告を作成中"
                  : "準備中";
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
      </span>
      <span>{label}</span>
      <PhaseDots />
    </div>
  );
}

export function MessageFeed({
  messages,
  isLoading,
  streamingPhase = null,
  specialistProgress = null,
  streamingFiles = [],
  streamingAudit = "",
  isStreaming = false,
  onStop,
  streamingWarning,
  onDismissWarning,
}: MessageFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const { user } = useUser();
  const userInitial =
    user?.firstName?.[0] ??
    user?.primaryEmailAddress?.emailAddress?.[0] ??
    "U";

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    bottomRef.current?.scrollIntoView({
      behavior: streamingPhase ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, streamingPhase]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary/50" />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={() => {
        const el = containerRef.current;
        if (!el) return;
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const atBottom = distance < 96;
        stickToBottomRef.current = atBottom;
        setAwayFromBottom(!atBottom);
      }}
      className="relative flex-1 overflow-y-auto p-4 md:p-8 space-y-8 pb-[calc(8rem+env(safe-area-inset-bottom))]"
    >
      {awayFromBottom && (
        <button
          type="button"
          onClick={() => {
            stickToBottomRef.current = true;
            setAwayFromBottom(false);
            bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
          }}
          className="sticky top-2 z-10 mx-auto flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs text-foreground shadow-md"
        >
          <ArrowDown className="h-3.5 w-3.5" /> 最新へ戻る
        </button>
      )}
      <div className="max-w-5xl mx-auto space-y-12">
        {messages.map((message) => {
          const display = message as DisplayMessage;
          const isUser = message.role === "user";
          const parsedUser = isUser ? parseAttachmentMessageForDisplay(message.content) : null;
          let displayContent = parsedUser?.displayContent ?? message.content;
          const attachments = parsedUser?.attachments ?? [];

          // For assistant messages: prefer DB-persisted sources; fall back to parsing
          // the legacy inline "参照元:" Markdown block so old messages still show cards.
          let sources = normalizeSources(message.sources);
          const assetIds = normalizeAssetIds(message.assetIds);
          const generatedAssets = display.generatedAssets ?? [];
          if (!isUser) {
            if (!sources || sources.length === 0) {
              // Try to extract legacy sources from the inline block
              const legacyMatch = displayContent.trimEnd().match(
                /\n\n参照元:\n((?:- \[.*?\]\(.*?\)\n?)+)/s
              );
              if (legacyMatch) {
                const extracted: { title: string; url: string }[] = [];
                const lineRe = /- \[([^\]]*)\]\(([^)]+)\)/g;
                let m: RegExpExecArray | null;
                while ((m = lineRe.exec(legacyMatch[1])) !== null) {
                  extracted.push({ title: m[1], url: m[2] });
                }
                if (extracted.length > 0) sources = extracted;
              }
            }
            // Remove the legacy block from display content (avoid duplication with cards)
            displayContent = displayContent.replace(/\n\n参照元:\n(?:- \[.*?\]\(.*?\)\n?)+$/s, "").trimEnd();
          }
          
          return (
            <div 
              key={message.id} 
              className={cn(
                "flex gap-3 md:gap-6 group",
                isUser ? "flex-row-reverse" : "flex-row"
              )}
            >
              <div className="flex-shrink-0 mt-1">
                {isUser ? (
                  <Avatar className="w-8 h-8 md:w-10 md:h-10 border border-primary/20 bg-primary/10 text-primary">
                    {user?.imageUrl ? <AvatarImage src={user.imageUrl} alt="" /> : null}
                    <AvatarFallback className="bg-transparent font-medium">
                      {userInitial.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                ) : (
                  <Avatar className="w-8 h-8 md:w-10 md:h-10 border border-border bg-card">
                    <AvatarFallback className="bg-transparent text-muted-foreground"><Bot className="w-5 h-5" /></AvatarFallback>
                  </Avatar>
                )}
              </div>
              
              <div className={cn(
                "flex flex-col gap-2 min-w-0",
                isUser
                  ? "items-end max-w-[88%] md:max-w-[70%]"
                  : "items-start w-full max-w-full md:max-w-[90%]"
              )}>
                {isUser && attachments.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-2 max-w-full">
                    {attachments.map((attachment, index) => (
                      <div
                        key={`${attachment.name}-${index}`}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card border border-border text-sm text-muted-foreground shadow-sm max-w-full"
                      >
                        <Paperclip className="w-4 h-4 text-primary shrink-0" />
                        <span className="font-medium text-foreground truncate">{attachment.name}</span>
                      </div>
                    ))}
                  </div>
                )}
                
                {(!isUser && message.id === STREAMING_ASSISTANT_ID && !displayContent) ? (
                  <div className="px-5 py-4 rounded-2xl bg-card border border-border shadow-sm">
                    <GenerationBadge phase={streamingPhase} />
                  </div>
                ) : (
                  <div className={cn(
                    "px-4 py-3 md:px-5 md:py-4 rounded-2xl text-[15px] leading-relaxed shadow-sm break-words [overflow-wrap:anywhere]",
                    isUser 
                      ? "bg-primary text-primary-foreground font-sans font-normal" 
                      : "bg-card border border-border font-serif text-foreground prose-p:leading-loose"
                  )}>
                    {isUser ? (
                      <div className="whitespace-pre-wrap">{displayContent}</div>
                    ) : (
                      <>
                        <SafeMarkdown content={displayContent} />
                        {message.id === STREAMING_ASSISTANT_ID &&
                          (streamingPhase === "generating" || streamingPhase === "revising") && (
                          <span
                            className="inline-block w-0.5 h-[1em] ml-0.5 align-[-0.1em] bg-primary animate-pulse"
                            aria-hidden
                          />
                        )}
                      </>
                    )}
                  </div>
                )}
                {!isUser &&
                  message.id === STREAMING_ASSISTANT_ID &&
                  displayContent &&
                  (streamingPhase === "generating" || streamingPhase === "revising") && (
                  <GenerationBadge phase={streamingPhase} />
                )}

                {!isUser && message.id === STREAMING_ASSISTANT_ID && specialistProgress && (
                  <SpecialistProgress progress={specialistProgress} />
                )}

                {!isUser &&
                  message.id === STREAMING_ASSISTANT_ID &&
                  (streamingPhase === "generating-file" ||
                    streamingPhase === "reviewing-layout" ||
                    streamingPhase === "revising-layout") && (
                  <FileGenerationPanel phase={streamingPhase as FileGenerationPhase} />
                )}

                {!isUser && message.id === STREAMING_ASSISTANT_ID && isStreaming && onStop && (
                  <button
                    type="button"
                    onClick={onStop}
                    className="inline-flex items-center gap-2 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/20"
                    aria-label="この回答を停止"
                  >
                    <Square className="h-3 w-3 fill-current" /> 停止
                  </button>
                )}

                {!isUser && message.id === STREAMING_ASSISTANT_ID && streamingWarning && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <span className="shrink-0">⚠️</span>
                    <span className="flex-1">{streamingWarning}</span>
                    <button type="button" onClick={onDismissWarning} className="shrink-0 rounded p-0.5 hover:bg-amber-500/20" aria-label="警告を閉じる">
                      <span aria-hidden>×</span>
                    </button>
                  </div>
                )}

                {!isUser && (display.auditContent || (message.id === STREAMING_ASSISTANT_ID && (streamingAudit || streamingPhase === "auditing"))) && (
                  <AuditCard
                    content={message.id === STREAMING_ASSISTANT_ID ? streamingAudit || display.auditContent || "" : display.auditContent || ""}
                    modelId={display.auditModelId}
                    live={message.id === STREAMING_ASSISTANT_ID && streamingPhase === "auditing"}
                  />
                )}

                {!isUser && sources && sources.length > 0 && (
                  <div className="w-full px-1">
                    <SourceCards sources={sources} />
                  </div>
                )}

                {!isUser && display.artifacts && display.artifacts.length > 0 && (
                  <ArtifactCards artifacts={display.artifacts} />
                )}
                {!isUser && generatedAssets.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-1">
                    {generatedAssets.map((asset) => (
                      <FileDownloadButton
                        key={asset.id}
                        assetId={asset.id}
                        filename={asset.filename}
                        mimeType={asset.mimeType}
                      />
                    ))}
                  </div>
                )}
                {!isUser && generatedAssets.length === 0 && assetIds && assetIds.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-1">
                    {assetIds.map((assetId) => (
                      <FileDownloadButton
                        key={assetId}
                        assetId={assetId}
                        filename={streamingFiles.find((file) => file.id === assetId)?.filename}
                        mimeType={streamingFiles.find((file) => file.id === assetId)?.mimeType}
                      />
                    ))}
                  </div>
                )}

                {!isUser && message.modelId && (
                  <div className="text-[11px] text-muted-foreground/60 px-1 select-none">
                    {getModelLabel(message.modelId)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
