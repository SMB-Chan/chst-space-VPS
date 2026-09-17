import { useState, useRef, useCallback, useEffect } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { openMobileModelSheet } from "@/components/mobile/mobile-shell";
import { formatModelChipLabel } from "@/components/mobile/model-settings-sheet";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AlertTriangle,
  Paperclip,
  Send,
  X,
  File as FileIcon,
  Image as ImageIcon,
  FileText,
  FileSpreadsheet,
  Presentation,
  Music as MusicIcon,
  Video as VideoIcon,
  Code2,
  Settings2,
  Scale,
  ChevronDown,
  Loader2,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { compressImageFile, formatBytes } from "@/lib/compress-image";
import { Chip } from "@/design-system/chip";
import { QwenAudioRealtime } from "./qwen-audio-realtime";
import {
  ModelSelector,
  useAvailableModels,
  type ModelInfo,
} from "./model-selector";
import { ReasoningSelector } from "./reasoning-selector";
import {
  TranslationModeSelector,
  translationModeLabel,
} from "./translation-selector";
import type { ReasoningLevel } from "@/lib/reasoning";
import type { TranslationModeSetting } from "@/lib/settings";

export interface OutgoingAttachment {
  name: string;
  content: string;
  isBase64: boolean;
  /** "image" only for real images; binary documents/audio travel as kind "file". */
  kind?: "image" | "file";
}

export type FileFormat = "pdf" | "docx" | "xlsx" | "pptx";
export type VideoMode = "t2v" | "i2v" | "r2v";
export type VideoGenerationInput = {
  prompt: string;
  mode: VideoMode;
  referenceImages?: OutgoingAttachment[];
  resolution: "720P" | "1080P";
  ratio:
    "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "4:5" | "5:4" | "9:21" | "21:9";
  duration: number;
};

export type CodingSendOptions = {
  codingMode?: boolean;
  projectId?: number | null;
};

interface MessageInputProps {
  onSend: (
    content: string,
    files?: OutgoingAttachment[],
    fileFormat?: FileFormat,
    coding?: CodingSendOptions,
  ) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
  /** Separates private/new conversation lifetimes as well as saved chats. */
  draftScope?: string;
  isStreaming?: boolean;
  onStop?: () => void;
  fileGenerationEnabled?: boolean;
  codingEnabled?: boolean;
  placeholder?: string;
  conversationId?: number | null;
  selectedModel?: string;
  onSelectModel?: (model: string) => void;
  reasoningLevel?: ReasoningLevel;
  onReasoningChange?: (level: ReasoningLevel) => void;
  translationMode?: TranslationModeSetting;
  onTranslationModeChange?: (mode: TranslationModeSetting) => void;
  auditEnabled?: boolean;
  onAuditToggle?: () => void;
  auditModel?: string;
  activeSkills?: { id: string; label: string }[];
  videoGenerationEnabled?: boolean;
  onGenerateVideo?: (
    input: VideoGenerationInput,
  ) => void | boolean | Promise<void | boolean>;
}

const ACCEPTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];
const ACCEPTED_TEXT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];
const ACCEPTED_DOCUMENT_TYPES = [
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];
const ACCEPTED_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".zip",
  ".docx",
  ".xlsx",
  ".pptx",
];
const ACCEPTED_AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".flac",
  ".webm",
];
const MAX_DOCUMENT_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_FILE_SIZE_BYTES = 1 * 1024 * 1024;
const MAX_TOTAL_TEXT_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5;

type StagedFile = { file: File; note: string | null; error?: string };

const FORMAT_BUTTONS: {
  format: FileFormat;
  label: string;
  icon: React.ElementType;
}[] = [
  { format: "pdf", label: "PDF", icon: FileText },
  { format: "docx", label: "Word", icon: FileText },
  { format: "xlsx", label: "Excel", icon: FileSpreadsheet },
  { format: "pptx", label: "PPT", icon: Presentation },
];

function isTextFile(file: Pick<File, "type" | "name">): boolean {
  const lowerName = file.name.toLowerCase();
  return (
    ACCEPTED_TEXT_TYPES.includes(file.type) ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".json")
  );
}

function hasExtension(file: Pick<File, "name">, extensions: string[]): boolean {
  const lowerName = file.name.toLowerCase();
  return extensions.some((extension) => lowerName.endsWith(extension));
}

function isDocumentFile(file: Pick<File, "type" | "name">): boolean {
  return (
    ACCEPTED_DOCUMENT_TYPES.includes(file.type) ||
    hasExtension(file, ACCEPTED_DOCUMENT_EXTENSIONS)
  );
}

function isAudioFile(file: Pick<File, "type" | "name">): boolean {
  return (
    file.type.startsWith("audio/") ||
    hasExtension(file, ACCEPTED_AUDIO_EXTENSIONS)
  );
}

function validateFile(file: File): string | null {
  const isImage = ACCEPTED_IMAGE_TYPES.includes(file.type);
  const isText = isTextFile(file);
  const isDocument = isDocumentFile(file);
  const isAudio = isAudioFile(file);
  if (!isImage && !isText && !isDocument && !isAudio) {
    return `${file.name} は対応していないファイル形式です。画像（JPEG・PNG・GIF・WebP）、テキスト（TXT・MD・CSV・JSON）、文書（PDF・ZIP・DOCX・XLSX・PPTX）、音声（MP3・WAV・M4A・OGG・FLAC・WebM）を添付できます。`;
  }
  const limit = isText
    ? MAX_TEXT_FILE_SIZE_BYTES
    : MAX_DOCUMENT_FILE_SIZE_BYTES;
  if (file.size > limit) {
    const limitMb = limit / 1024 / 1024;
    const label = isImage
      ? "画像"
      : isText
        ? "テキストファイル"
        : isDocument
          ? "文書ファイル"
          : "音声ファイル";
    return `${file.name} は大きすぎます（${(file.size / 1024 / 1024).toFixed(1)}MB）。${label}は1件${limitMb}MB以下にしてください。`;
  }
  return null;
}

function totalSize(files: StagedFile[]): number {
  return files.reduce((sum, item) => sum + item.file.size, 0);
}

function totalTextSize(files: StagedFile[]): number {
  return files.reduce(
    (sum, item) => sum + (isTextFile(item.file) ? item.file.size : 0),
    0,
  );
}

function readOne(file: File): Promise<OutgoingAttachment> {
  const isImage = ACCEPTED_IMAGE_TYPES.includes(file.type);
  const asDataUrl = isImage || !isTextFile(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result !== "string") {
        reject(new Error("ファイルの読み込みに失敗しました。"));
        return;
      }
      resolve({
        name: file.name,
        content: result,
        isBase64: asDataUrl,
        kind: isImage ? "image" : "file",
      });
    };
    reader.onerror = () =>
      reject(new Error("ファイルの読み込みに失敗しました。"));
    if (asDataUrl) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function MessageInput(props: MessageInputProps) {
  return (
    <Composer
      key={props.draftScope ?? props.conversationId ?? "new"}
      {...props}
    />
  );
}

function Composer({
  onSend,
  disabled,
  isStreaming = false,
  onStop,
  fileGenerationEnabled = true,
  codingEnabled = false,
  placeholder,
  conversationId = null,
  selectedModel = "",
  onSelectModel,
  reasoningLevel = "medium",
  onReasoningChange,
  translationMode = "off",
  onTranslationModeChange,
  auditEnabled = false,
  onAuditToggle,
  auditModel,
  activeSkills = [],
  videoGenerationEnabled = false,
  onGenerateVideo,
}: MessageInputProps) {
  const models = useAvailableModels();
  const isMobile = useIsMobile() === true;
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileFormat, setFileFormat] = useState<FileFormat | null>(null);
  const [codingMode, setCodingMode] = useState(false);
  const [codingProjectId, setCodingProjectId] = useState<number | null>(null);
  const [codingProjects, setCodingProjects] = useState<
    { id: number; name: string }[]
  >([]);
  const [compressing, setCompressing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [videoMode, setVideoMode] = useState<VideoMode | null>(null);
  const [videoResolution, setVideoResolution] = useState<"720P" | "1080P">(
    "720P",
  );
  const [videoRatio, setVideoRatio] =
    useState<VideoGenerationInput["ratio"]>("16:9");
  const [videoDuration, setVideoDuration] = useState(5);
  const [toolsOpen, setToolsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isSendingRef = useRef(false);
  const preparingRef = useRef(false);
  const composingRef = useRef(false);
  const mountedRef = useRef(false);
  const controlsDisabled = disabled || isStreaming || compressing || submitting;

  useEffect(() => {
    if (!codingEnabled) {
      setCodingMode(false);
      return;
    }
    let cancelled = false;
    void fetch(`${BASE}/api/projects`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { projects?: { id: number; name: string }[] } | null) => {
        if (cancelled || !data?.projects) return;
        setCodingProjects(data.projects);
        setCodingProjectId((current) => {
          if (
            current &&
            data.projects?.some((project) => project.id === current)
          ) {
            return current;
          }
          return data.projects?.[0]?.id ?? null;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [codingEnabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!fileGenerationEnabled) setFileFormat(null);
  }, [fileGenerationEnabled]);

  useEffect(() => {
    if (!videoGenerationEnabled) setVideoMode(null);
  }, [videoGenerationEnabled]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !composingRef.current &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const selected = Array.from(event.target.files ?? []);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (selected.length === 0) return;
    if (controlsDisabled || preparingRef.current || isSendingRef.current)
      return;

    preparingRef.current = true;
    setFileError(null);
    setCompressing(true);
    try {
      const next = [...files];
      const errors: string[] = [];
      for (const item of selected) {
        if (!mountedRef.current) return;
        if (next.length >= MAX_FILES) {
          errors.push(`添付は最大${MAX_FILES}件までです。`);
          break;
        }
        const error = validateFile(item);
        if (error) {
          errors.push(error);
          continue;
        }
        if (
          next.some(
            (existing) =>
              existing.file.name === item.name &&
              existing.file.size === item.size,
          )
        ) {
          continue;
        }
        try {
          const { file: compressed, reduced } = await compressImageFile(item);
          if (!mountedRef.current) return;
          const candidate = {
            file: compressed,
            note: reduced
              ? `${formatBytes(item.size)} → ${formatBytes(compressed.size)} に軽量化`
              : null,
          };
          if (totalSize([...next, candidate]) > MAX_TOTAL_SIZE_BYTES) {
            errors.push(
              `添付の合計が20MBを超えます。${item.name} を追加できませんでした。`,
            );
            continue;
          }
          if (totalTextSize([...next, candidate]) > MAX_TOTAL_TEXT_SIZE_BYTES) {
            errors.push(
              `テキスト添付の合計が2MBを超えます。${item.name} を追加できませんでした。`,
            );
            continue;
          }
          next.push(candidate);
        } catch {
          const candidate = { file: item, note: null };
          if (totalSize([...next, candidate]) > MAX_TOTAL_SIZE_BYTES) {
            errors.push(
              `添付の合計が20MBを超えます。${item.name} を追加できませんでした。`,
            );
            continue;
          }
          if (totalTextSize([...next, candidate]) > MAX_TOTAL_TEXT_SIZE_BYTES) {
            errors.push(
              `テキスト添付の合計が2MBを超えます。${item.name} を追加できませんでした。`,
            );
            continue;
          }
          next.push(candidate);
        }
      }
      if (!mountedRef.current) return;
      setFiles(next);
      if (errors.length > 0) setFileError(errors.join("\n"));
    } finally {
      preparingRef.current = false;
      if (mountedRef.current) {
        setCompressing(false);
        textareaRef.current?.focus();
      }
    }
  };

  const handleSubmit = async () => {
    if (
      (!content.trim() && files.length === 0) ||
      controlsDisabled ||
      preparingRef.current
    )
      return;
    if (isSendingRef.current) return;
    isSendingRef.current = true;
    setSubmitting(true);
    setFileError(null);
    setToolsOpen(false);

    const readAttachments = async (items: StagedFile[]) => {
      const results = await Promise.all(
        items.map(async (item) => {
          try {
            return {
              item,
              attachment: await readOne(item.file),
              error: undefined,
            };
          } catch {
            return {
              item,
              attachment: undefined,
              error: "読み込みに失敗しました",
            };
          }
        }),
      );
      if (!mountedRef.current) return null;
      setFiles((previous) =>
        previous.map((item) => {
          const result = results.find((result) => result.item === item);
          return result ? { ...item, error: result.error } : item;
        }),
      );
      if (results.some((result) => result.error)) {
        throw new Error(
          "読み込めない添付があります。該当ファイルを外すか選び直して、もう一度送信してください。本文と添付は保持しています。",
        );
      }
      return results.map((result) => result.attachment!);
    };

    try {
      if (videoMode && onGenerateVideo) {
        const nonImages = files.filter(
          (item) => !ACCEPTED_IMAGE_TYPES.includes(item.file.type),
        );
        const imageFiles = files.filter((item) =>
          ACCEPTED_IMAGE_TYPES.includes(item.file.type),
        );
        const expected =
          videoMode === "t2v"
            ? "画像を添付しない"
            : videoMode === "i2v"
              ? "先頭画像を1枚"
              : "参照画像を1〜9枚";
        if (nonImages.length > 0) {
          setFileError(
            "動画生成では画像ファイルだけを参照素材に指定できます。",
          );
          return;
        }
        if (
          (videoMode === "t2v" && imageFiles.length !== 0) ||
          (videoMode === "i2v" && imageFiles.length !== 1) ||
          (videoMode === "r2v" &&
            (imageFiles.length < 1 || imageFiles.length > 9))
        ) {
          setFileError(
            `${videoMode.toUpperCase()} は ${expected} 指定してください。`,
          );
          return;
        }
        const confirmed = window.confirm(
          `${videoMode.toUpperCase()}動画（${videoDuration}秒・${videoResolution}）を生成します。\n高コストの処理です。実行しますか？`,
        );
        if (!confirmed) return;
        const references = imageFiles.length
          ? await readAttachments(imageFiles)
          : undefined;
        if (!mountedRef.current || references === null) return;
        const result = await onGenerateVideo({
          prompt: content.trim(),
          mode: videoMode,
          referenceImages: references,
          resolution: videoResolution,
          ratio: videoRatio,
          duration: videoDuration,
        });
        if (!mountedRef.current || result === false) return;
        setContent("");
        setFiles([]);
        setFileError(null);
        setVideoMode(null);
        return;
      }
      if (files.length > 5) {
        setFileError(
          "通常のチャット添付は最大5件までです。動画生成では動画モードを選択してください。",
        );
        return;
      }
      if (codingEnabled && codingMode && codingProjectId == null) {
        setFileError("コーディングモードではプロジェクトを選んでください。");
        return;
      }
      const attachments =
        files.length > 0 ? await readAttachments(files) : undefined;
      if (!mountedRef.current || attachments === null) return;

      const result = await onSend(
        content.trim() || "添付ファイルの内容を説明してください。",
        attachments,
        codingMode ? undefined : (fileFormat ?? undefined),
        codingEnabled && codingMode
          ? { codingMode: true, projectId: codingProjectId }
          : undefined,
      );
      if (!mountedRef.current || result === false) return;

      setContent("");
      setFiles([]);
      setFileError(null);
      setFileFormat(null);

      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setFileError(
        error instanceof Error ? error.message : "送信に失敗しました。",
      );
    } finally {
      isSendingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const adjustHeight = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const element = event.target;
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
      setContent(element.value);
    },
    [],
  );

  const hasFiles = files.length > 0;
  const hasActiveSkills = activeSkills.length > 0;
  const canSend = (content.trim().length > 0 || hasFiles) && !controlsDisabled;
  const showModelSelector = onSelectModel != null;
  const showReasoning =
    onReasoningChange != null &&
    (models.find((model) => model.id === selectedModel)?.supportsReasoning ??
      true);
  const showTranslation = onTranslationModeChange != null;
  const showAudit = onAuditToggle != null;
  const hasTools =
    showModelSelector ||
    showReasoning ||
    showTranslation ||
    showAudit ||
    fileGenerationEnabled ||
    videoGenerationEnabled ||
    codingEnabled;
  const codingProjectName = codingProjects.find(
    (project) => project.id === codingProjectId,
  )?.name;
  const activeModes = [
    auditEnabled ? "監査 ON" : null,
    codingMode
      ? codingProjectName
        ? `コーディング · ${codingProjectName}`
        : "コーディング"
      : null,
    fileFormat && !codingMode ? `${fileFormat.toUpperCase()} 出力` : null,
    videoMode ? `${videoMode.toUpperCase()} 動画` : null,
  ].filter((label): label is string => label !== null);
  const translationActive = translationMode !== "off";
  const hasComposerStatus =
    hasActiveSkills || activeModes.length > 0 || translationActive;

  const modelChipLabel = formatModelChipLabel(
    models.find((model) => model.id === selectedModel)?.label ?? selectedModel,
    reasoningLevel,
  );

  useEffect(() => {
    if (!isMobile) return;
    const onSubmit = () => {
      void handleSubmit();
    };
    window.addEventListener("mobile-submit-composer", onSubmit);
    return () => window.removeEventListener("mobile-submit-composer", onSubmit);
  }, [isMobile, handleSubmit]);

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-[var(--m3-shape-xl)] border border-transparent transition-[border-color,box-shadow,background-color,transform] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-emphasized)] focus-within:ring-2 focus-within:ring-primary/30",
        toolsOpen && "ring-1 ring-primary/15",
        isMobile &&
          "mobile-composer-dock border-[rgba(255,255,255,0.06)] [background:var(--mx-panel)] [border-radius:var(--mx-radius-input)] shadow-[0_12px_40px_rgba(0,0,0,0.45)] focus-within:ring-0",
      )}
      data-testid="composer"
      data-mobile-composer-root={isMobile ? "" : undefined}
      aria-label={
        translationActive
          ? `翻訳モード: ${translationModeLabel(translationMode)}`
          : "通常チャット入力"
      }
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        className="hidden"
        accept="image/jpeg,image/png,image/gif,image/webp,.txt,.md,.csv,.json,.pdf,.zip,.docx,.xlsx,.pptx,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/ogg,audio/flac,audio/webm,.mp3,.wav,.m4a,.ogg,.flac,.webm"
        multiple
      />

      {hasComposerStatus && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-0 pt-3">
          {hasActiveSkills && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] [color:var(--app-status-success)]">
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-[var(--m3-shape-full)] [background:var(--app-status-success)]"
                aria-hidden="true"
              />
              <span className="font-semibold uppercase tracking-[0.14em]">
                スキル
              </span>
              {activeSkills.map((skill) => (
                <Chip
                  key={skill.id}
                  asChild
                  className="min-h-6 max-w-40 px-2 text-[10px] [background:var(--app-status-success-container)] [border-color:var(--app-status-success)] [color:var(--app-status-success)]"
                >
                  <span className="truncate">{skill.label}</span>
                </Chip>
              ))}
            </div>
          )}
          {activeModes.map((mode) => (
            <Chip
              key={mode}
              asChild
              selected
              className="min-h-6 px-2 text-[10px]"
            >
              <span>{mode}</span>
            </Chip>
          ))}
          {translationActive && (
            <Chip
              asChild
              selected
              className="min-h-6 border-[var(--m3-tertiary)] bg-[var(--m3-tertiary-container)] px-2 text-[10px] text-[var(--m3-on-tertiary-container)]"
              data-testid="composer-translation-direction"
            >
              <span>方向: {translationModeLabel(translationMode)}</span>
            </Chip>
          )}
        </div>
      )}

      {fileError && (
        <div className="flex items-start gap-2 px-4 pb-0 pt-3">
          <div
            role="alert"
            className="flex min-w-0 w-full animate-in items-start gap-2 rounded-[var(--m3-shape-md)] border [border-color:var(--m3-error)] [background:var(--m3-error-container)] px-3 py-2 text-xs [color:var(--m3-on-error-container)] fade-in slide-in-from-bottom-2 whitespace-pre-wrap"
          >
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 break-words">{fileError}</span>
            <button
              type="button"
              onClick={() => setFileError(null)}
              className="m3-focus-ring shrink-0 rounded-[var(--m3-shape-full)] p-0.5 transition-colors hover:bg-foreground/10"
              aria-label="エラーを閉じる"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      {compressing && (
        <div
          role="status"
          className="px-4 pb-0 pt-3 text-xs text-muted-foreground"
        >
          添付を準備しています…
        </div>
      )}

      {hasFiles && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-0 pt-3">
          {files.map((item, index) => (
            <Chip
              key={`${item.file.name}-${item.file.size}-${index}`}
              asChild
              className="min-h-8 max-w-full justify-start px-3 text-xs animate-in fade-in slide-in-from-bottom-2"
            >
              <span>
                {item.file.type.startsWith("image/") ? (
                  <ImageIcon
                    className="h-3.5 w-3.5 shrink-0 [color:var(--m3-primary)]"
                    aria-hidden="true"
                  />
                ) : isAudioFile(item.file) ? (
                  <MusicIcon
                    className="h-3.5 w-3.5 shrink-0 [color:var(--m3-primary)]"
                    aria-hidden="true"
                  />
                ) : (
                  <FileIcon
                    className="h-3.5 w-3.5 shrink-0 [color:var(--m3-primary)]"
                    aria-hidden="true"
                  />
                )}
                <span
                  title={item.file.name}
                  className="min-w-0 max-w-[8rem] truncate font-medium sm:max-w-[12rem]"
                >
                  {item.file.name}
                </span>
                {item.error && (
                  <span className="text-xs text-destructive" role="status">
                    読込失敗
                  </span>
                )}
                {item.note && (
                  <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">
                    {item.note}
                  </span>
                )}
                <button
                  type="button"
                  disabled={controlsDisabled}
                  onClick={() =>
                    setFiles((previous) =>
                      previous.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                  className="m3-focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--m3-shape-full)] disabled:opacity-50 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                  aria-label={`${item.file.name} を外す`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </Chip>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        aria-label="メッセージ入力"
        value={content}
        onChange={adjustHeight}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        placeholder={
          placeholder ??
          (codingMode
            ? "変更したいファイルや内容を指示..."
            : fileFormat
              ? `この内容を ${fileFormat.toUpperCase()} で生成...`
              : "メッセージ")
        }
        className={cn(
          "max-h-[200px] min-h-[52px] w-full flex-1 resize-none bg-transparent px-4 pb-1 pt-3 font-sans text-base leading-relaxed outline-none placeholder:text-muted-foreground/55 scrollbar-none",
          isMobile &&
            "min-h-[48px] max-h-[140px] px-[18px] pb-0 pt-4 text-[var(--mx-ink)] placeholder:text-[var(--mx-ink-dim)]",
        )}
        rows={1}
        disabled={controlsDisabled}
        data-testid="composer-textarea"
      />

      {isMobile ? (
        <div className="mobile-composer-actions">
          <button
            type="button"
            className="mobile-plus-btn"
            aria-label="ファイルを添付"
            disabled={controlsDisabled}
            onClick={() => fileInputRef.current?.click()}
            data-testid="composer-attach"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden
            >
              <path
                d="M10 3.5v13M3.5 10h13"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>

          <button
            type="button"
            className="mobile-model-chip"
            onClick={() => {
              if (showModelSelector) openMobileModelSheet();
              else setToolsOpen(true);
            }}
            data-testid="mobile-model-chip"
          >
            <span>{modelChipLabel}</span>
          </button>

          <div className="text-[var(--mx-ink)]">
            <QwenAudioRealtime
              conversationId={conversationId}
              selectedModel={selectedModel}
              disabled={controlsDisabled}
              onTranscript={(transcript) => {
                void onSend(transcript);
              }}
            />
          </div>

          {isStreaming && onStop ? (
            <button
              type="button"
              className="mobile-send-btn"
              data-ready="true"
              onClick={onStop}
              aria-label="生成を停止"
              data-testid="composer-stop"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              className="mobile-send-btn"
              data-ready={canSend}
              onClick={() => void handleSubmit()}
              disabled={!canSend}
              aria-label={submitting ? "送信準備中" : "送信"}
              aria-busy={submitting}
              data-testid="composer-send"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M12 19V5M12 5l-6 6M12 5l6 6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          )}
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            className="h-11 w-11 shrink-0 rounded-[var(--m3-shape-full)] text-muted-foreground hover:[background:var(--m3-primary-container)] hover:[color:var(--m3-on-primary-container)]"
            disabled={controlsDisabled}
            aria-label="ファイルを添付"
            data-testid="composer-attach"
          >
            <Paperclip className="h-[18px] w-[18px]" />
          </Button>

          <QwenAudioRealtime
            conversationId={conversationId}
            selectedModel={selectedModel}
            disabled={controlsDisabled}
            onTranscript={(transcript) => {
              void onSend(transcript);
            }}
          />

          <span className="hidden pl-1 text-[10px] text-muted-foreground/55 lg:inline">
            Enterで送信 · Shift + Enterで改行
          </span>

          <div className="flex-1" />

          {showModelSelector && (
            <div className="hidden sm:block">
              <ModelSelector
                selectedModel={selectedModel}
                onSelect={onSelectModel!}
                disabled={controlsDisabled}
              />
            </div>
          )}

          {hasTools && (
            <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
              <PopoverTrigger asChild>
                <Chip
                  disabled={controlsDisabled}
                  selected={toolsOpen}
                  className="h-11 min-w-11 gap-1.5 px-3"
                  aria-label="追加ツール"
                  aria-expanded={toolsOpen}
                  data-testid="composer-tools-toggle"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">ツール</span>
                  <ChevronDown
                    className={cn(
                      "h-3 w-3 transition-transform duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-expressive)]",
                      toolsOpen && "rotate-180",
                    )}
                  />
                </Chip>
              </PopoverTrigger>

              <PopoverContent
                side="top"
                align="end"
                sideOffset={10}
                collisionPadding={12}
                className="flex w-72 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-0 sm:w-80 max-h-[min(60dvh,var(--radix-popover-content-available-height))]"
                aria-label="追加ツール"
                data-testid="composer-tools-panel"
              >
                <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-3">
                  {showModelSelector && (
                    <div className="sm:hidden">
                      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        モデル
                      </label>
                      <ModelSelector
                        selectedModel={selectedModel}
                        onSelect={onSelectModel!}
                        disabled={controlsDisabled}
                      />
                    </div>
                  )}

                  {showReasoning && (
                    <div>
                      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        推論レベル
                      </label>
                      <ReasoningSelector
                        value={reasoningLevel}
                        onSelect={onReasoningChange!}
                        disabled={controlsDisabled}
                      />
                    </div>
                  )}

                  {showTranslation && (
                    <div>
                      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        翻訳
                      </label>
                      <TranslationModeSelector
                        value={translationMode}
                        onSelect={onTranslationModeChange!}
                        disabled={controlsDisabled}
                      />
                    </div>
                  )}

                  {showAudit && (
                    <div>
                      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        監査
                      </label>
                      <Chip
                        disabled={controlsDisabled}
                        selected={auditEnabled}
                        onClick={onAuditToggle}
                        className={cn(
                          "h-8 justify-start",
                          auditEnabled &&
                            "[background:var(--app-status-info-container)] [border-color:var(--app-status-info)] [color:var(--app-status-info)]",
                        )}
                        title={
                          auditEnabled && auditModel
                            ? `監査: ${auditModel}`
                            : auditEnabled
                              ? "監査 ON（監査モデルが選択されていません）"
                              : "監査モード"
                        }
                        aria-pressed={auditEnabled}
                        data-testid="composer-audit-toggle"
                      >
                        <Scale className="h-3.5 w-3.5" />
                        {auditEnabled ? "ON" : "OFF"}
                        {auditEnabled && auditModel && (
                          <span className="ml-1 max-w-32 truncate text-[10px] opacity-70">
                            {auditModel}
                          </span>
                        )}
                      </Chip>
                    </div>
                  )}

                  {codingEnabled && (
                    <div>
                      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        コーディング
                      </label>
                      <div className="space-y-2">
                        <Chip
                          selected={codingMode}
                          onClick={() => {
                            setCodingMode((current) => {
                              const next = !current;
                              if (next) setFileFormat(null);
                              return next;
                            });
                          }}
                          disabled={controlsDisabled}
                          className="h-8"
                          aria-pressed={codingMode}
                          data-testid="composer-coding-toggle"
                        >
                          <Code2 className="h-3.5 w-3.5" />
                          {codingMode ? "ON" : "OFF"}
                        </Chip>
                        {codingMode ? (
                          codingProjects.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {codingProjects.map((project) => (
                                <Chip
                                  key={project.id}
                                  selected={codingProjectId === project.id}
                                  onClick={() => setCodingProjectId(project.id)}
                                  disabled={controlsDisabled}
                                  className="h-8 max-w-full"
                                  aria-pressed={codingProjectId === project.id}
                                >
                                  <span className="truncate">
                                    {project.name}
                                  </span>
                                </Chip>
                              ))}
                            </div>
                          ) : (
                            <p className="text-[11px] text-muted-foreground">
                              ファイルタブでプロジェクトを作成してください。
                            </p>
                          )
                        ) : null}
                      </div>
                    </div>
                  )}

                  {fileGenerationEnabled && !videoMode && !codingMode && (
                    <div>
                      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        ファイル出力
                      </label>
                      <div className="m3-control-group">
                        {FORMAT_BUTTONS.map(({ format, label, icon: Icon }) => {
                          const active = fileFormat === format;
                          return (
                            <Chip
                              key={format}
                              selected={active}
                              onClick={() =>
                                setFileFormat(active ? null : format)
                              }
                              disabled={controlsDisabled}
                              className="h-8"
                              aria-pressed={active}
                              data-testid={`composer-format-${format}`}
                            >
                              <Icon className="h-3.5 w-3.5" />
                              {label}
                            </Chip>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {videoGenerationEnabled && (
                    <div>
                      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        動画生成
                      </label>
                      <div className="space-y-2">
                        <Chip
                          selected={videoMode != null}
                          onClick={() =>
                            setVideoMode((current) => (current ? null : "t2v"))
                          }
                          disabled={controlsDisabled}
                          className={cn(
                            "h-8",
                            videoMode &&
                              "[background:var(--app-status-accent-container)] [border-color:var(--app-status-accent)] [color:var(--app-status-accent)]",
                          )}
                          aria-pressed={videoMode != null}
                          data-testid="composer-video-toggle"
                        >
                          <VideoIcon className="h-3.5 w-3.5" />
                          {videoMode ? videoMode.toUpperCase() : "動画生成"}
                        </Chip>
                        {videoMode && (
                          <div className="grid grid-cols-2 gap-2">
                            <select
                              value={videoMode}
                              onChange={(event) =>
                                setVideoMode(event.target.value as VideoMode)
                              }
                              className="m3-field h-9 px-2 text-xs outline-none"
                              aria-label="動画生成モード"
                            >
                              <option value="t2v">T2V・テキスト</option>
                              <option value="i2v">I2V・先頭画像</option>
                              <option value="r2v">R2V・参照画像</option>
                            </select>
                            <select
                              value={videoDuration}
                              onChange={(event) =>
                                setVideoDuration(Number(event.target.value))
                              }
                              className="m3-field h-9 px-2 text-xs outline-none"
                              aria-label="動画の長さ"
                            >
                              {[3, 5, 8, 10, 15].map((seconds) => (
                                <option key={seconds} value={seconds}>
                                  {seconds}秒
                                </option>
                              ))}
                            </select>
                            <select
                              value={videoResolution}
                              onChange={(event) =>
                                setVideoResolution(
                                  event.target.value as "720P" | "1080P",
                                )
                              }
                              className="m3-field h-9 px-2 text-xs outline-none"
                              aria-label="動画の解像度"
                            >
                              <option value="720P">720P</option>
                              <option value="1080P">1080P</option>
                            </select>
                            <select
                              value={videoRatio}
                              disabled={videoMode === "i2v"}
                              onChange={(event) =>
                                setVideoRatio(
                                  event.target
                                    .value as VideoGenerationInput["ratio"],
                                )
                              }
                              className="m3-field h-9 px-2 text-xs outline-none disabled:opacity-50"
                              aria-label="動画の比率"
                            >
                              {[
                                "16:9",
                                "9:16",
                                "1:1",
                                "4:3",
                                "3:4",
                                "4:5",
                                "5:4",
                                "9:21",
                                "21:9",
                              ].map((ratio) => (
                                <option key={ratio} value={ratio}>
                                  {ratio}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {isStreaming && onStop ? (
            <Button
              type="button"
              size="icon"
              onClick={onStop}
              className="h-11 w-11 shrink-0 rounded-[var(--m3-shape-full)] border border-destructive/30 [background:var(--m3-error-container)] text-destructive hover:bg-destructive/20"
              aria-label="生成を停止"
              data-testid="composer-stop"
            >
              <Square className="h-4 w-4 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              onClick={handleSubmit}
              disabled={!canSend}
              className={cn(
                "h-11 w-11 shrink-0 rounded-[var(--m3-shape-full)]",
                canSend
                  ? "bg-primary [color:var(--m3-on-primary)]"
                  : "[background:var(--m3-surface-container-high)] text-muted-foreground shadow-none",
              )}
              aria-label={submitting ? "送信準備中" : "送信"}
              aria-busy={submitting}
              data-testid="composer-send"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="ml-0.5 h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
