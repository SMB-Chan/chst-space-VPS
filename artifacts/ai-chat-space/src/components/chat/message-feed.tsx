import { memo, useRef, useEffect, useState } from "react";
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
  shouldRenderAuditCard,
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
  Brain,
  Globe,
  Telescope,
  FileSearch,
  ListChecks,
  type LucideIcon,
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

export interface ActivityStep {
  label: string;
  at: number;
}

export interface ActivityLog {
  steps: ActivityStep[];
  totalMs: number;
  startedAtMs: number;
  finished: boolean;
}

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
  durationMs?: number | null;
  filesMeta?: { path: string; kind: string; added?: number | null; removed?: number | null }[] | null;
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
  liveActivity?: ActivityLog | null;
  finishedActivity?: ActivityLog | null;
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

function phaseLabel(
  phase: StreamingPhase,
  researchStep?: { step: number; maxSteps: number } | null,
): string {
  if (!phase) return "";
  if (phase === "thinking") return "推論中";
  if (phase === "researching") {
    return researchStep
      ? `情報を収集中 (${researchStep.step}/${researchStep.maxSteps})`
      : "情報を収集中";
  }
  if (phase === "searching") return "Webを検索中";
  if (phase === "reading-images") return "画像を読み取り中";
  if (phase === "reading-files") return "ファイルを解析中";
  if (phase === "generating-file") return "ファイルを生成中";
  if (phase === "reviewing-layout") return "レイアウトを確認中";
  if (phase === "revising-layout") return "レイアウトを修正中";
  if (phase === "generating") return "生成中";
  if (phase === "auditing") return "監査中";
  if (phase === "verifying") return "根拠を検証中";
  if (phase === "revising") return "最終報告を作成中";
  return "準備中";
}

function phaseIcon(phase: StreamingPhase): LucideIcon {
  switch (phase) {
    case "searching":
      return Globe;
    case "researching":
      return Telescope;
    case "reading-images":
    case "reading-files":
      return FileSearch;
    case "auditing":
    case "verifying":
    case "revising":
      return ListChecks;
    case "generating":
      return Sparkles;
    default:
      return Brain;
  }
}

function formatActivityDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/**
 * ChatGPT/Claude-style "thinking" row: a breathing gradient orb plus a
 * shimmer-swept phase label and a live elapsed-seconds counter.
 */
function ThinkingIndicator({
  phase,
  researchStep,
  elapsedMs,
}: {
  phase: StreamingPhase;
  researchStep?: { step: number; maxSteps: number } | null;
  elapsedMs?: number;
}) {
  if (!phase) return null;
  const Icon = phaseIcon(phase);
  const seconds = elapsedMs ? Math.floor(elapsedMs / 1000) : 0;
  return (
    <div className="flex items-center gap-2.5 px-1 py-0.5" role="status">
      <span
        className="relative flex h-7 w-7 shrink-0 items-center justify-center"
        aria-hidden
      >
        <span className="thinking-orb-halo absolute h-5 w-5 rounded-[var(--m3-shape-full)] bg-primary/35" />
        <span className="thinking-orb relative flex h-5 w-5 items-center justify-center rounded-[var(--m3-shape-full)] bg-gradient-to-br from-primary via-primary to-[color:var(--app-status-accent)] shadow-[0_0_14px_2px] shadow-primary/30">
          <Icon className="h-3 w-3 text-primary-foreground" strokeWidth={2.4} />
        </span>
      </span>
      <span className="shimmer-text text-sm font-medium">
        {phaseLabel(phase, researchStep)}
      </span>
      {seconds > 0 ? (
        <span className="text-[11px] tabular-nums text-muted-foreground/70">
          {formatActivityDuration(elapsedMs ?? 0)}
        </span>
      ) : null}
    </div>
  );
}

/** Collapsible trail of what the assistant did this turn (Claude-style). */
function ActivityTimeline({
  activity,
  live,
}: {
  activity?: ActivityLog | null;
  live?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(live));
  const steps = activity?.steps ?? [];
  if (steps.length === 0) return null;
  return (
    <div className="w-full overflow-hidden rounded-[var(--m3-shape-lg)] border border-[var(--m3-outline-variant)] [background:color-mix(in_oklab,var(--m3-surface-container-low)_65%,transparent)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.04]"
        aria-expanded={open}
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-primary/80" />
        <span className="font-medium">
          {live ? "処理の流れ" : "推論の記録"}
        </span>
        <span className="opacity-50" aria-hidden>
          ·
        </span>
        <span className="tabular-nums opacity-70">{steps.length}ステップ</span>
        {activity && activity.finished && activity.totalMs > 0 ? (
          <>
            <span className="opacity-50" aria-hidden>
              ·
            </span>
            <span className="tabular-nums opacity-70">
              {formatActivityDuration(activity.totalMs)}
            </span>
          </>
        ) : null}
        {live && steps.length > 0 ? (
          <span className="ml-1.5 flex min-w-0 items-center gap-1.5 text-primary/80">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-[var(--m3-shape-full)] bg-primary" />
            <span className="max-w-[220px] truncate">
              {steps[steps.length - 1].label}
            </span>
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <ol className="border-t border-[var(--m3-outline-variant)] px-3.5 py-2.5">
          {steps.map((step, index) => {
            const isCurrent = Boolean(live) && index === steps.length - 1;
            return (
              <li
                key={`${step.at}-${index}`}
                className="animate-step-in relative flex items-baseline gap-2.5 py-1 pl-5 text-xs"
              >
                <span
                  className="absolute left-[4.5px] top-1 h-2.5 w-2.5 rounded-[var(--m3-shape-full)] border-2"
                  style={{
                    borderColor: isCurrent
                      ? "var(--m3-primary)"
                      : "var(--m3-outline)",
                    backgroundColor: isCurrent
                      ? "color-mix(in oklab, var(--m3-primary) 35%, transparent)"
                      : "var(--m3-surface-container)",
                  }}
                  aria-hidden
                />
                {index < steps.length - 1 ? (
                  <span
                    className="absolute left-[8.5px] top-4 bottom-[-4px] w-px bg-[var(--m3-outline-variant)]"
                    aria-hidden
                  />
                ) : null}
                <span className="flex-1 text-foreground/80">{step.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground/50">
                  {new Date(step.at).toLocaleTimeString("ja-JP", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

function AuditCard({
  content,
  modelId,
  live,
  citationScope,
}: {
  content: string;
  modelId?: string | null;
  live?: boolean;
  citationScope: string;
}) {
  const [open, setOpen] = useState(!!live);
  const translationAudit = /^翻訳チェック[:：]/.test(content.trim());
  const displayContent = translationAudit
    ? content.replace(/^翻訳チェック[:：]\s*/, "").trim()
    : content;
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
        <span className="font-medium">
          {live ? "監査中" : translationAudit ? "翻訳チェック" : "点検メモ"}
        </span>
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
          <SafeMarkdown
            content={displayContent}
            citationScope={citationScope}
          />
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

interface MessageRowProps {
  message: OpenaiMessage;
  userInitial: string;
  userImageUrl?: string;
  streamingPhase: StreamingPhase;
  specialistProgress: {
    capability: string;
    phase: string;
    message?: string;
  } | null;
  streamingFiles: { id: number; filename: string; mimeType: string }[];
  streamingAudit: string;
  streamingFactuality: FactualityReport | null;
  isStreaming: boolean;
  onStop?: () => void;
  streamingWarning?: string | null;
  onDismissWarning?: () => void;
  onRegenerate?: () => void;
  isLastAssistant: boolean;
  researchStep: { step: number; maxSteps: number } | null;
  activityLog?: ActivityLog | null;
  finishedActivity?: ActivityLog | null;
}

const MessageRow = memo(function MessageRow({
  message,
  userInitial,
  userImageUrl,
  streamingPhase,
  specialistProgress,
  streamingFiles,
  streamingAudit,
  streamingFactuality,
  isStreaming,
  onStop,
  streamingWarning,
  onDismissWarning,
  onRegenerate,
  isLastAssistant,
  researchStep,
  activityLog,
  finishedActivity,
}: MessageRowProps) {
  const [copiedId, setCopiedId] = useState<number | string | null>(null);
  const display = message as DisplayMessage;
  const isUser = message.role === "user";
  const parsedUser = isUser
    ? parseAttachmentMessageForDisplay(message.content)
    : null;
  let displayContent = parsedUser?.displayContent ?? message.content;
  const attachments = parsedUser?.attachments ?? [];
  const citationScope = `message-${message.id}`;
  const isStreamingMessage = message.id === STREAMING_ASSISTANT_ID;

  // For assistant messages: prefer DB-persisted sources; fall back to parsing
  // the legacy inline "参照元:" Markdown block so old messages still show cards.
  let sources = normalizeSources(message.sources);
  const factuality = normalizeFactualityReport(display.factuality);
  const visibleFactuality = isStreamingMessage
    ? streamingFactuality || factuality
    : factuality;
  const hasResearchQuality = Boolean(visibleFactuality?.researchQuality);
  const assetIds = normalizeAssetIds(message.assetIds);
  const generatedAssets = display.generatedAssets ?? [];
  if (!isUser) {
    if (!sources || sources.length === 0) {
      const legacyMatch = displayContent
        .trimEnd()
        .match(/\n\n参照元:\n((?:- \[.*?\]\(.*?\)\n?)+)/s);
      if (legacyMatch) {
        const extracted: { title: string; url: string }[] = [];
        const lineRe = /- \[([^\]]*)\]\(([^)]+)\)/g;
        let match: RegExpExecArray | null;
        while ((match = lineRe.exec(legacyMatch[1])) !== null) {
          extracted.push({ title: match[1], url: match[2] });
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
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 180px" }}
      className={cn(
        "group flex gap-2.5 sm:gap-3.5 md:gap-4",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      <div className="flex-shrink-0 mt-1">
        {isUser ? (
          <Avatar className="w-8 h-8 md:w-9 md:h-9 border border-primary/25 bg-primary/10 text-primary shadow-sm">
            {userImageUrl ? <AvatarImage src={userImageUrl} alt="" /> : null}
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

        {!isUser && isStreamingMessage && !displayContent ? (
          <div className="flex w-full flex-col gap-3 px-1 py-1.5">
            <ThinkingIndicator
              phase={streamingPhase}
              researchStep={researchStep}
              elapsedMs={activityLog?.totalMs ?? 0}
            />
            <ActivityTimeline activity={activityLog} live />
          </div>
        ) : (
          <div
            className={cn(
              "break-words rounded-[var(--m3-shape-lg)] px-4 py-3 text-[15px] leading-relaxed [overflow-wrap:anywhere] md:px-5 md:py-4",
              isUser
                ? "rounded-tr-[var(--m3-shape-xs)] bg-gradient-to-br from-primary to-primary/85 text-primary-foreground font-sans font-normal shadow-[var(--m3-elevation-2)]"
                : "m3-surface-container rounded-[var(--m3-shape-xl)] rounded-tl-[var(--m3-shape-xs)] border border-[var(--m3-outline-variant)]/70 font-sans text-foreground prose-p:leading-loose",
            )}
          >
            {isUser ? (
              <div className="whitespace-pre-wrap">{displayContent}</div>
            ) : (
              <>
                <SafeMarkdown
                  content={displayContent}
                  citationScope={citationScope}
                  streaming={isStreamingMessage && isStreaming}
                />
                {isStreamingMessage &&
                  (streamingPhase === "generating" ||
                    streamingPhase === "revising") && (
                    <span
                      className="animate-caret-blink ml-0.5 inline-block h-[1.05em] w-[3px] translate-y-[0.12em] rounded-[2px] bg-gradient-to-b from-primary to-primary/50"
                      aria-hidden
                    />
                  )}
              </>
            )}
          </div>
        )}
        {!isUser &&
          isStreamingMessage &&
          displayContent &&
          (streamingPhase === "generating" ||
            streamingPhase === "revising") && (
            <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-[var(--m3-shape-full)] bg-primary" />
              <span className="shimmer-text text-xs font-medium">
                {phaseLabel(streamingPhase, researchStep)}
              </span>
            </div>
          )}

        {!isUser &&
          !isStreamingMessage &&
          isLastAssistant &&
          finishedActivity &&
          new Date(message.createdAt).getTime() >=
            finishedActivity.startedAtMs && (
            <ActivityTimeline activity={finishedActivity} />
          )}

        {!isUser && isStreamingMessage && specialistProgress && (
          <SpecialistProgress progress={specialistProgress} />
        )}

        {!isUser &&
          isStreamingMessage &&
          (streamingPhase === "generating-file" ||
            streamingPhase === "reviewing-layout" ||
            streamingPhase === "revising-layout") && (
            <FileGenerationPanel
              phase={streamingPhase as FileGenerationPhase}
            />
          )}

        {!isUser && isStreamingMessage && isStreaming && onStop && (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center gap-2 rounded-[var(--m3-shape-full)] border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/20"
            aria-label="この回答を停止"
          >
            <Square className="h-3 w-3 fill-current" /> 停止
          </button>
        )}

        {!isUser && isStreamingMessage && streamingWarning && (
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
          shouldRenderAuditCard({
            hasResearchQuality,
            auditContent: display.auditContent,
            isStreaming: isStreamingMessage,
            streamingAudit,
            streamingPhase,
          }) && (
            <AuditCard
              content={
                isStreamingMessage
                  ? streamingAudit || display.auditContent || ""
                  : display.auditContent || ""
              }
              modelId={display.auditModelId}
              live={isStreamingMessage && streamingPhase === "auditing"}
              citationScope={citationScope}
            />
          )}

        {!isUser && visibleFactuality && (
          <div className="w-full px-1">
            <FactualityCard report={visibleFactuality} />
          </div>
        )}

        {!isUser && sources && sources.length > 0 && (
          <div className="w-full px-1">
            <SourceCards sources={sources} citationScope={citationScope} />
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
                    streamingFiles.find((file) => file.id === assetId)?.filename
                  }
                  mimeType={
                    streamingFiles.find((file) => file.id === assetId)?.mimeType
                  }
                />
              ))}
            </div>
          )}
        {!isUser &&
          ((display.filesMeta && display.filesMeta.length > 0) ||
            (typeof display.durationMs === "number" &&
              display.durationMs > 0)) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
              {typeof display.durationMs === "number" &&
              display.durationMs > 0 ? (
                <span className="tabular-nums">
                  {formatActivityDuration(display.durationMs)}
                </span>
              ) : null}
              {display.filesMeta?.map((file) => (
                <span
                  key={`${file.path}-${file.kind}`}
                  className="inline-flex max-w-full items-center gap-1"
                >
                  <FileText className="h-3 w-3 shrink-0" />
                  <span className="truncate">{file.path}</span>
                  {typeof file.added === "number" ||
                  typeof file.removed === "number" ? (
                    <span className="tabular-nums opacity-70">
                      +{file.added ?? 0}/-{file.removed ?? 0}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          )}

        {!isUser && message.id !== STREAMING_ASSISTANT_ID && displayContent && (
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
            {onRegenerate && isLastAssistant && (
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
}, areMessageRowPropsEqual);

function areMessageRowPropsEqual(
  previous: Readonly<MessageRowProps>,
  next: Readonly<MessageRowProps>,
): boolean {
  if (
    previous.message !== next.message ||
    previous.userInitial !== next.userInitial ||
    previous.userImageUrl !== next.userImageUrl ||
    previous.isLastAssistant !== next.isLastAssistant
  ) {
    return false;
  }
  if (previous.message.id !== STREAMING_ASSISTANT_ID) {
    if (!previous.isLastAssistant) return true;
    return (
      previous.onRegenerate === next.onRegenerate &&
      previous.finishedActivity === next.finishedActivity
    );
  }
  return (
    previous.streamingPhase === next.streamingPhase &&
    previous.specialistProgress === next.specialistProgress &&
    previous.streamingFiles === next.streamingFiles &&
    previous.streamingAudit === next.streamingAudit &&
    previous.streamingFactuality === next.streamingFactuality &&
    previous.isStreaming === next.isStreaming &&
    previous.onStop === next.onStop &&
    previous.streamingWarning === next.streamingWarning &&
    previous.onDismissWarning === next.onDismissWarning &&
    previous.researchStep === next.researchStep &&
    previous.activityLog === next.activityLog
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
  liveActivity = null,
  finishedActivity = null,
}: MessageFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const { user } = useUser();
  const userInitial =
    user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "U";

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (!stickToBottomRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      if (streamingPhase) {
        container.scrollTop = container.scrollHeight;
      } else {
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      }
    });
  }, [messages, streamingPhase]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary/50" />
      </div>
    );
  }

  let lastAssistantId: number | string | null = null;
  for (const candidate of messages) {
    if (
      candidate.role === "assistant" &&
      candidate.id !== STREAMING_ASSISTANT_ID
    ) {
      lastAssistantId = candidate.id;
    }
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
          return (
            <MessageRow
              key={message.id}
              message={message}
              userInitial={userInitial}
              userImageUrl={user?.imageUrl}
              streamingPhase={streamingPhase}
              specialistProgress={specialistProgress}
              streamingFiles={streamingFiles}
              streamingAudit={streamingAudit}
              streamingFactuality={streamingFactuality}
              isStreaming={isStreaming}
              onStop={onStop}
              streamingWarning={streamingWarning}
              onDismissWarning={onDismissWarning}
              onRegenerate={onRegenerate}
              isLastAssistant={message.id === lastAssistantId}
              researchStep={researchStep}
              activityLog={
                message.id === STREAMING_ASSISTANT_ID ? liveActivity : null
              }
              finishedActivity={
                message.id === lastAssistantId ? finishedActivity : null
              }
            />
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
