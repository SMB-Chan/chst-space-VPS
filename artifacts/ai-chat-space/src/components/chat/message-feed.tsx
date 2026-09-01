import { useRef, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  OpenaiMessage,
  OpenaiVideoJob,
  getGetOpenaiAssetUrl,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { surfaceVariants } from "@/design-system/surface";
import { SafeMarkdown } from "./safe-markdown";
import { SourceCards } from "./source-cards";
import {
  FactualityCard,
  normalizeFactualityReport,
  type FactualityReport,
} from "./factuality-card";
import {
  FileGenerationPanel,
  type FileGenerationPhase,
} from "./file-generation-panel";
import {
  Loader2,
  Paperclip,
  ChevronDown,
  FileText,
  Download,
  ArrowDown,
  Square,
  Sparkles,
  Volume2,
  Video,
  Ban,
  Copy,
  RotateCcw,
  Check,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useUser } from "@clerk/react";
import { getModelLabel } from "./model-selector";
import { STREAMING_ASSISTANT_ID } from "@/lib/chat";
import { parseAttachmentMessageForDisplay } from "@/lib/attachments";

export type StreamingPhase =
  | "starting"
  | "searching"
  | "researching"
  | "reading-images"
  | "reading-files"
  | "thinking"
  | "generating"
  | "generating-file"
  | "reviewing-layout"
  | "revising-layout"
  | "auditing"
  | "verifying"
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
  factuality?: FactualityReport | string | null;
  artifacts?: ChatArtifact[] | null;
  assetIds?: number[] | null;
  generatedAssets?:
    | {
        id: number;
        filename: string;
        mimeType: string;
        size: number;
        downloadUrl?: string;
      }[]
    | null;
};

function normalizeSources(
  value: unknown,
): { title: string; url: string }[] | null {
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
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => typeof id === "number")
      : null;
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
  specialistProgress?: {
    capability: string;
    phase: string;
    message?: string;
  } | null;
  streamingFiles?: { id: number; filename: string; mimeType: string }[];
  streamingAudit?: string;
  streamingFactuality?: FactualityReport | null;
  isStreaming?: boolean;
  onStop?: () => void;
  streamingWarning?: string | null;
  onDismissWarning?: () => void;
  videoJob?: OpenaiVideoJob | null;
  onCancelVideo?: () => void;
  onRegenerate?: () => void;
  researchStep?: { step: number; maxSteps: number } | null;
}

function VideoJobCard({
  job,
  onCancel,
}: {
  job: OpenaiVideoJob;
  onCancel?: () => void;
}) {
  const busy =
    job.status === "SUBMITTING" ||
    job.status === "PENDING" ||
    job.status === "RUNNING";
  const statusLabel: Record<OpenaiVideoJob["status"], string> = {
    SUBMITTING: "送信中",
    PENDING: "待機中",
    RUNNING: "生成中",
    SUCCEEDED: "完了",
    FAILED: "失敗",
    CANCELED: "キャンセル済み",
    UNKNOWN: "不明",
  };
  const asset = job.resultAsset;
  return (
    <div
      className={cn(
        surfaceVariants({ tone: "outlined", shape: "large" }),
        "px-4 py-4 shadow-[var(--m3-elevation-1)]",
        busy
          ? "[background:var(--app-status-accent-container)] [border-color:var(--app-status-accent)]"
          : job.status === "FAILED" || job.status === "UNKNOWN"
            ? "[background:var(--app-status-warning-container)] [border-color:var(--app-status-warning)]"
            : "",
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin [color:var(--app-status-accent)]" />
        ) : (
          <Video className="h-4 w-4 [color:var(--app-status-accent)]" />
        )}
        <span className="font-medium">HappyHorse 動画生成</span>
        <span className="text-xs text-muted-foreground">
          {job.mode.toUpperCase()}・{statusLabel[job.status]}
        </span>
        {job.status === "PENDING" && onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto inline-flex items-center gap-1 rounded-[var(--m3-shape-full)] border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/20"
          >
            <Ban className="h-3 w-3" /> キャンセル
          </button>
        ) : null}
      </div>
      {busy ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {job.status === "SUBMITTING"
            ? "生成サービスに送信しています。"
            : job.status === "PENDING"
              ? "生成キューで順番を待っています。"
              : "動画を生成しています。完了するとここに表示されます。"}
        </p>
      ) : null}
      {job.failureMessage ? (
        <p className="mt-2 text-xs [color:var(--app-status-warning)]">
          {job.failureMessage}
        </p>
      ) : null}
      {asset ? (
        <div className="mt-3 grid gap-2">
          <video
            controls
            preload="metadata"
            src={asset.downloadUrl || getGetOpenaiAssetUrl(asset.id)}
            className="w-full max-w-2xl rounded-[var(--m3-shape-lg)] border border-[var(--m3-outline-variant)] bg-black"
            aria-label={`生成動画 ${asset.filename}`}
          />
          <a
            href={asset.downloadUrl || getGetOpenaiAssetUrl(asset.id)}
            download={asset.filename}
            className={cn(
              surfaceVariants({ tone: "outlined", shape: "small" }),
              "m3-focus-ring inline-flex w-fit items-center gap-2 px-3 py-2 text-sm transition-colors hover:[background:var(--m3-surface-container-high)] hover:[border-color:var(--m3-outline)]",
            )}
          >
            <Download className="h-4 w-4 text-primary" />
            <span className="max-w-[240px] truncate">{asset.filename}</span>
          </a>
        </div>
      ) : null}
    </div>
  );
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
        surfaceVariants({ tone: "outlined", shape: "small" }),
        "flex items-center gap-2 px-3 py-2 text-xs",
        failed
          ? "[background:var(--app-status-warning-container)] [border-color:var(--app-status-warning)] [color:var(--app-status-warning)]"
          : "[background:var(--app-status-accent-container)] [border-color:var(--app-status-accent)] [color:var(--app-status-accent)]",
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
      <span className="w-1.5 h-1.5 rounded-[var(--m3-shape-full)] bg-current animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 rounded-[var(--m3-shape-full)] bg-current animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 rounded-[var(--m3-shape-full)] bg-current animate-bounce" />
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
    <div
      className={cn(
        surfaceVariants({ tone: "outlined", shape: "medium" }),
        "w-full overflow-hidden [background:var(--app-status-info-container)] [border-color:var(--app-status-info)]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="m3-focus-ring flex w-full items-center gap-2 px-3 py-2 text-xs [color:var(--app-status-info)] transition-colors hover:bg-foreground/[0.04]"
      >
        <span className="font-medium">{live ? "監査中" : "点検メモ"}</span>
        {modelId ? <span className="opacity-70">{modelId}</span> : null}
        {live ? <PhaseDots /> : null}
        <ChevronDown
          className={cn(
            "w-3.5 h-3.5 ml-auto transition-transform",
            open && "rotate-180",
          )}
        />
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
        <div
          key={artifact.id ?? `${artifact.filename}-${index}`}
          className="grid gap-2"
        >
          {artifact.mime.startsWith("image/") && artifact.downloadUrl ? (
            <img
              src={artifact.downloadUrl}
              alt={artifact.filename}
              className="max-h-80 w-auto max-w-full rounded-[var(--m3-shape-lg)] border border-[var(--m3-outline-variant)] object-contain"
            />
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
              surfaceVariants({ tone: "outlined", shape: "medium" }),
              "flex items-center gap-3 px-3 py-3 shadow-[var(--m3-elevation-1)] transition-colors",
              artifact.downloadUrl
                ? "hover:border-primary/40 hover:bg-primary/5"
                : "opacity-70 pointer-events-none",
            )}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--m3-shape-sm)] [background:var(--m3-primary-container)] [color:var(--m3-on-primary-container)]">
              {artifact.mime.startsWith("audio/") ? (
                <Volume2 className="w-[1.125rem] h-[1.125rem]" />
              ) : (
                <FileText className="w-[1.125rem] h-[1.125rem]" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">
                {artifact.filename}
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                {artifact.mime} ・ {formatBytes(artifact.size)}
              </div>
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
          className="max-h-80 w-auto max-w-full rounded-[var(--m3-shape-lg)] border border-[var(--m3-outline-variant)] object-contain"
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
        className={cn(
          surfaceVariants({ tone: "outlined", shape: "small" }),
          "m3-focus-ring inline-flex items-center gap-2 px-3 py-2 text-sm shadow-[var(--m3-elevation-1)] transition-colors hover:[background:var(--m3-surface-container-high)] hover:[border-color:var(--m3-outline)]",
        )}
      >
        {mimeType?.startsWith("audio/") ? (
          <Volume2 className="w-4 h-4 text-primary" />
        ) : (
          <FileText className="w-4 h-4 text-primary" />
        )}
        <span className="font-medium truncate max-w-[180px]">
          {filename ?? "生成ファイルをダウンロード"}
        </span>
        <Download className="w-3.5 h-3.5 text-muted-foreground" />
      </a>
    </div>
  );
}

function GenerationBadge({
  phase,
  researchStep,
}: {
  phase: StreamingPhase;
  researchStep?: { step: number; maxSteps: number } | null;
}) {
  if (!phase) return null;
  const label =
    phase === "thinking"
      ? "推論中"
      : phase === "researching"
        ? researchStep
          ? `情報を収集中 (${researchStep.step}/${researchStep.maxSteps})`
          : "情報を収集中"
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
                        : phase === "verifying"
                          ? "根拠を検証中"
                          : phase === "revising"
                            ? "最終報告を作成中"
                            : "準備中";
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-[var(--m3-shape-full)] bg-primary opacity-60" />
        <span className="relative inline-flex rounded-[var(--m3-shape-full)] h-2 w-2 bg-primary" />
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
  streamingFactuality = null,
  isStreaming = false,
  onStop,
  streamingWarning,
  onDismissWarning,
  videoJob = null,
  onCancelVideo,
  onRegenerate,
  researchStep = null,
}: MessageFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [copiedId, setCopiedId] = useState<number | string | null>(null);
  const { user } = useUser();
  const userInitial =
    user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "U";

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
      role="log"
      aria-live="polite"
      aria-label="会話メッセージ"
      onScroll={() => {
        const el = containerRef.current;
        if (!el) return;
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const atBottom = distance < 96;
        stickToBottomRef.current = atBottom;
        setAwayFromBottom(!atBottom);
      }}
      className="relative flex-1 overflow-y-auto px-3 py-5 sm:px-5 md:px-8 md:py-7 pb-[calc(6rem+env(safe-area-inset-bottom))]"
    >
      {awayFromBottom && (
        <button
          type="button"
          onClick={() => {
            stickToBottomRef.current = true;
            setAwayFromBottom(false);
            bottomRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "end",
            });
          }}
          className="m3-floating-surface m3-focus-ring sticky top-2 z-10 mx-auto flex items-center gap-1.5 rounded-[var(--m3-shape-full)] px-3 py-1.5 text-xs"
        >
          <ArrowDown className="h-3.5 w-3.5" /> 最新へ戻る
        </button>
      )}
      <div className="mx-auto max-w-4xl space-y-8 md:space-y-10">
        {messages.map((message) => {
          const display = message as DisplayMessage;
          const isUser = message.role === "user";
          const parsedUser = isUser
            ? parseAttachmentMessageForDisplay(message.content)
            : null;
          let displayContent = parsedUser?.displayContent ?? message.content;
          const attachments = parsedUser?.attachments ?? [];

          // For assistant messages: prefer DB-persisted sources; fall back to parsing
          // the legacy inline "参照元:" Markdown block so old messages still show cards.
          let sources = normalizeSources(message.sources);
          const factuality = normalizeFactualityReport(display.factuality);
          const assetIds = normalizeAssetIds(message.assetIds);
          const generatedAssets = display.generatedAssets ?? [];
          if (!isUser) {
            if (!sources || sources.length === 0) {
              // Try to extract legacy sources from the inline block
              const legacyMatch = displayContent
                .trimEnd()
                .match(/\n\n参照元:\n((?:- \[.*?\]\(.*?\)\n?)+)/s);
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
            displayContent = displayContent
              .replace(/\n\n参照元:\n(?:- \[.*?\]\(.*?\)\n?)+$/s, "")
              .trimEnd();
          }

          return (
            <motion.div
              key={message.id}
              initial={{ opacity: 0, y: 14, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 340, damping: 30 }}
              className={cn(
                "group flex gap-2.5 sm:gap-3.5 md:gap-4",
                isUser ? "flex-row-reverse" : "flex-row",
              )}
            >
              <div className="flex-shrink-0 mt-1">
                {isUser ? (
                  <Avatar className="w-8 h-8 md:w-9 md:h-9 border border-primary/25 bg-primary/10 text-primary shadow-sm">
                    {user?.imageUrl ? (
                      <AvatarImage src={user.imageUrl} alt="" />
                    ) : null}
                    <AvatarFallback className="bg-transparent font-medium">
                      {userInitial.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                ) : (
                  <Avatar className="w-8 h-8 md:w-9 md:h-9 border border-primary/20 [background:var(--m3-primary-container)] shadow-sm">
                    <AvatarFallback className="bg-transparent text-primary">
                      <Sparkles className="w-4 h-4" />
                    </AvatarFallback>
                  </Avatar>
                )}
              </div>

              <div
                className={cn(
                  "flex min-w-0 flex-col gap-2",
                  isUser
                    ? "items-end max-w-[90%] md:max-w-[72%]"
                    : "items-start w-full max-w-full md:max-w-[92%]",
                )}
              >
                <div
                  className={cn(
                    "flex items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/65",
                    isUser && "flex-row-reverse",
                  )}
                >
                  <span>{isUser ? "You" : "AI Space"}</span>
                  {!isUser && message.modelId ? (
                    <>
                      <span className="h-1 w-1 rounded-[var(--m3-shape-full)] bg-muted-foreground/30" />
                      <span className="normal-case tracking-normal text-muted-foreground/55">
                        {getModelLabel(message.modelId)}
                      </span>
                    </>
                  ) : null}
                </div>
                {isUser && attachments.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-2 max-w-full">
                    {attachments.map((attachment, index) => (
                      <div
                        key={`${attachment.name}-${index}`}
                        className={cn(
                          surfaceVariants({ tone: "low", shape: "full" }),
                          "flex max-w-full items-center gap-2 px-3.5 py-2 text-sm text-muted-foreground shadow-[var(--m3-elevation-0)]",
                        )}
                      >
                        <Paperclip className="w-4 h-4 text-primary shrink-0" />
                        <span className="font-medium text-foreground truncate">
                          {attachment.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {!isUser &&
                message.id === STREAMING_ASSISTANT_ID &&
                !displayContent ? (
                  <div
                    className={cn(
                      surfaceVariants({ tone: "container", shape: "large" }),
                      "rounded-tl-[var(--m3-shape-xs)] px-5 py-4",
                    )}
                  >
                    <GenerationBadge
                      phase={streamingPhase}
                      researchStep={researchStep}
                    />
                  </div>
                ) : (
                  <div
                    className={cn(
                      "break-words rounded-[var(--m3-shape-lg)] px-4 py-3 text-[15px] leading-relaxed [overflow-wrap:anywhere] md:px-5 md:py-4",
                      isUser
                        ? "rounded-tr-[var(--m3-shape-xs)] bg-primary text-primary-foreground font-sans font-normal shadow-[var(--m3-elevation-2)]"
                        : "m3-surface-container rounded-tl-[var(--m3-shape-xs)] font-sans text-foreground prose-p:leading-loose",
                    )}
                  >
                    {isUser ? (
                      <div className="whitespace-pre-wrap">
                        {displayContent}
                      </div>
                    ) : (
                      <>
                        <SafeMarkdown content={displayContent} />
                        {message.id === STREAMING_ASSISTANT_ID &&
                          (streamingPhase === "generating" ||
                            streamingPhase === "revising") && (
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
                  (streamingPhase === "generating" ||
                    streamingPhase === "revising") && (
                    <GenerationBadge
                      phase={streamingPhase}
                      researchStep={researchStep}
                    />
                  )}

                {!isUser &&
                  message.id === STREAMING_ASSISTANT_ID &&
                  specialistProgress && (
                    <SpecialistProgress progress={specialistProgress} />
                  )}

                {!isUser &&
                  message.id === STREAMING_ASSISTANT_ID &&
                  (streamingPhase === "generating-file" ||
                    streamingPhase === "reviewing-layout" ||
                    streamingPhase === "revising-layout") && (
                    <FileGenerationPanel
                      phase={streamingPhase as FileGenerationPhase}
                    />
                  )}

                {!isUser &&
                  message.id === STREAMING_ASSISTANT_ID &&
                  isStreaming &&
                  onStop && (
                    <button
                      type="button"
                      onClick={onStop}
                      className="inline-flex items-center gap-2 rounded-[var(--m3-shape-full)] border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/20"
                      aria-label="この回答を停止"
                    >
                      <Square className="h-3 w-3 fill-current" /> 停止
                    </button>
                  )}

                {!isUser &&
                  message.id === STREAMING_ASSISTANT_ID &&
                  streamingWarning && (
                    <div className="flex items-start gap-2 rounded-[var(--m3-shape-sm)] border [border-color:var(--app-status-warning)] [background:var(--app-status-warning-container)] px-3 py-2 text-xs [color:var(--app-status-warning)]">
                      <span className="shrink-0">⚠️</span>
                      <span className="flex-1">{streamingWarning}</span>
                      <button
                        type="button"
                        onClick={onDismissWarning}
                        className="m3-focus-ring shrink-0 rounded-[var(--m3-shape-xs)] p-0.5 transition-colors hover:bg-foreground/[0.08]"
                        aria-label="警告を閉じる"
                      >
                        <span aria-hidden>×</span>
                      </button>
                    </div>
                  )}

                {!isUser &&
                  (display.auditContent ||
                    (message.id === STREAMING_ASSISTANT_ID &&
                      (streamingAudit || streamingPhase === "auditing"))) && (
                    <AuditCard
                      content={
                        message.id === STREAMING_ASSISTANT_ID
                          ? streamingAudit || display.auditContent || ""
                          : display.auditContent || ""
                      }
                      modelId={display.auditModelId}
                      live={
                        message.id === STREAMING_ASSISTANT_ID &&
                        streamingPhase === "auditing"
                      }
                    />
                  )}

                {!isUser &&
                  (message.id === STREAMING_ASSISTANT_ID
                    ? streamingFactuality || factuality
                    : factuality) && (
                    <div className="w-full px-1">
                      <FactualityCard
                        report={
                          (message.id === STREAMING_ASSISTANT_ID
                            ? streamingFactuality || factuality
                            : factuality)!
                        }
                      />
                    </div>
                  )}

                {!isUser && sources && sources.length > 0 && (
                  <div className="w-full px-1">
                    <SourceCards sources={sources} />
                  </div>
                )}

                {!isUser &&
                  display.artifacts &&
                  display.artifacts.length > 0 && (
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
                {!isUser &&
                  generatedAssets.length === 0 &&
                  assetIds &&
                  assetIds.length > 0 && (
                    <div className="flex flex-wrap gap-2 px-1">
                      {assetIds.map((assetId) => (
                        <FileDownloadButton
                          key={assetId}
                          assetId={assetId}
                          filename={
                            streamingFiles.find((file) => file.id === assetId)
                              ?.filename
                          }
                          mimeType={
                            streamingFiles.find((file) => file.id === assetId)
                              ?.mimeType
                          }
                        />
                      ))}
                    </div>
                  )}

                {!isUser &&
                  message.id !== STREAMING_ASSISTANT_ID &&
                  displayContent && (
                    <div className="flex items-center gap-1.5 px-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(displayContent);
                          setCopiedId(message.id);
                          setTimeout(() => setCopiedId(null), 2000);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-[var(--m3-shape-full)] px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="メッセージをコピー"
                      >
                        {copiedId === message.id ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        {copiedId === message.id ? "コピー済み" : "コピー"}
                      </button>
                      {onRegenerate &&
                        messages
                          .filter(
                            (m) =>
                              m.role === "assistant" &&
                              m.id !== STREAMING_ASSISTANT_ID,
                          )
                          .at(-1)?.id === message.id && (
                          <button
                            type="button"
                            onClick={onRegenerate}
                            className="inline-flex items-center gap-1.5 rounded-[var(--m3-shape-full)] px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="回答を再生成"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            再生成
                          </button>
                        )}
                    </div>
                  )}
              </div>
            </motion.div>
          );
        })}
        {videoJob ? (
          <VideoJobCard job={videoJob} onCancel={onCancelVideo} />
        ) : null}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
