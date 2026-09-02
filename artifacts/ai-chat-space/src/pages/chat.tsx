import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetOpenaiConversation,
  useCreateOpenaiConversation,
  getGetOpenaiConversationQueryKey,
  getListOpenaiConversationsQueryKey,
  OpenaiMessage,
  OpenaiArtifact,
  OpenaiVideoJob,
  createOpenaiVideoJob,
  getOpenaiVideoJob,
  cancelOpenaiVideoJob,
} from "@workspace/api-client-react";
import { MessageFeed, type ChatArtifact } from "@/components/chat/message-feed";
import {
  MessageInput,
  type OutgoingAttachment,
  type FileFormat,
  type VideoGenerationInput,
} from "@/components/chat/message-input";
import { useAvailableModels } from "@/components/chat/model-selector";
import {
  conversationTitle,
  timeGreeting,
  OPTIMISTIC_USER_ID,
  STREAMING_ASSISTANT_ID,
} from "@/lib/chat";
import { type ReasoningLevel } from "@/lib/reasoning";
import {
  loadSettings,
  pickAuditModel,
  saveSettings,
  subscribeSettings,
  type TranslationModeSetting,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { applyClientPatch } from "@/lib/audit-patch";
import {
  normalizeFactualityReport,
  type FactualityReport,
} from "@/components/chat/factuality-card";
import {
  compactAttachmentMessageForHistory,
  serializeAttachmentMessage,
} from "@/lib/attachments";
import { Sparkles, X, Shield } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripArtifactBlocks(content: string): string {
  const cleaned = content
    .replace(/```artifact\s*[^\n]*\n[\s\S]*?```/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return cleaned.trim()
    ? cleaned
    : "ファイルを作成しました。下のカードからダウンロードできます。";
}

async function streamMessage(
  conversationId: number,
  content: string,
  model: string,
  reasoning: ReasoningLevel,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error, turnSaved?: boolean) => void,
  onStatus: (status: string | null, query?: string) => void,
  onSpecialist: (event: {
    capability: string;
    phase: string;
    message?: string;
  }) => void,
  onSearchWarning: (message: string) => void,
  onResearchStep: (step: { step: number; maxSteps: number }) => void,
  onSources: (
    sources: {
      title: string;
      url: string;
      publishedAt?: string | null;
      fetchedAt?: string | null;
    }[],
  ) => void,
  onFactuality: (report: FactualityReport) => void,
  onSkills: (skills: { id: string; label: string }[]) => void,
  onAudit: (text: string) => void,
  onArtifacts: (artifacts: ChatArtifact[]) => void,
  onResetContent: () => void,
  onPatch: (operations: unknown) => void,
  onFile: (file: { id: number; filename: string; mimeType: string }) => void,
  artifactBlobUrlCache: React.MutableRefObject<Map<string, string>>,
  signal?: AbortSignal,
  extra?: {
    ephemeral?: boolean;
    history?: { role: "user" | "assistant"; content: string }[];
    auditModel?: string;
    fileFormat?: FileFormat;
    attachments?: OutgoingAttachment[];
    translationMode?: string;
  },
) {
  try {
    const path = extra?.ephemeral
      ? `${BASE}/api/openai/ephemeral/messages`
      : `${BASE}/api/openai/conversations/${conversationId}/messages`;
    const auditQuery = extra?.auditModel
      ? `&auditModel=${encodeURIComponent(extra.auditModel)}&auditReasoning=${encodeURIComponent(loadSettings().auditReasoning)}`
      : "";
    const translateQuery = extra?.translationMode
      ? `&translate=${encodeURIComponent(extra.translationMode)}`
      : "";
    const res = await fetch(
      `${path}?model=${encodeURIComponent(model)}&reasoning=${encodeURIComponent(reasoning)}${auditQuery}${translateQuery}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          modelId: model,
          ...(extra?.fileFormat ? { fileFormat: extra.fileFormat } : {}),
          ...(extra?.attachments?.length
            ? {
                attachments: extra.attachments.map((attachment) => ({
                  // バイナリ文書・音声は base64 でも kind "file"（画像のみ "image"）
                  kind:
                    attachment.kind ?? (attachment.isBase64 ? "image" : "file"),
                  name: attachment.name,
                  content: attachment.content,
                  isBase64: attachment.isBase64,
                })),
              }
            : {}),
          ...(extra?.ephemeral && extra.history
            ? { history: extra.history }
            : {}),
        }),
        credentials: "include",
        signal,
      },
    );

    if (!res.ok) {
      // JSONエラー本文を読み取り、具体的なメッセージを表示する
      let errorMessage: string;
      try {
        const errorBody = await res.json();
        errorMessage = errorBody.error ?? errorBody.message ?? res.statusText;
      } catch {
        errorMessage = res.statusText || `エラー (HTTP ${res.status})`;
      }
      throw new Error(errorMessage);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("応答ストリームを開けませんでした。");
    const decoder = new TextDecoder();
    let buffer = "";
    let doneCalled = false;
    let failed = false;
    let receivedContent = false;
    const callDoneOnce = () => {
      if (!doneCalled && !failed) {
        doneCalled = true;
        onDone();
      }
    };

    const handleSseLine = (line: string) => {
      if (!line.startsWith("data: ")) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (parsed.status === "skill" && Array.isArray(parsed.skills)) {
        onSkills(
          parsed.skills.filter(
            (s): s is { id: string; label: string } =>
              !!s &&
              typeof s === "object" &&
              typeof (s as { id?: unknown }).id === "string" &&
              typeof (s as { label?: unknown }).label === "string",
          ),
        );
      }
      if (parsed.status === "searching")
        onStatus("searching", parsed.query as string | undefined);
      if (parsed.status === "fetching") onStatus("fetching");
      if (parsed.status === "researching") {
        onStatus("researching");
        if (
          typeof parsed.step === "number" &&
          typeof parsed.maxSteps === "number"
        ) {
          onResearchStep({ step: parsed.step, maxSteps: parsed.maxSteps });
        }
      }
      if (parsed.status === "reading-images") onStatus("reading-images");
      if (parsed.status === "reading-files") onStatus("reading-files");
      if (parsed.status === "thinking") onStatus("thinking");
      if (parsed.status === "generating") onStatus("generating");
      if (
        (parsed.status === "specialist" ||
          parsed.status === "specialist_warning") &&
        typeof parsed.capability === "string" &&
        typeof parsed.phase === "string"
      ) {
        onSpecialist({
          capability: parsed.capability,
          phase: parsed.phase,
          message:
            typeof parsed.message === "string" ? parsed.message : undefined,
        });
        onStatus("specialist");
        if (
          parsed.status === "specialist_warning" &&
          typeof parsed.message === "string"
        ) {
          onSearchWarning(parsed.message);
        }
      }
      if (parsed.status === "auditing") onStatus("auditing");
      if (parsed.status === "verifying") onStatus("verifying");
      if (parsed.status === "revising") {
        onStatus("revising");
        if (parsed.resetContent) onResetContent();
        if (Array.isArray(parsed.patch)) onPatch(parsed.patch);
      }
      if (typeof parsed.audit === "string" && parsed.audit) {
        onStatus("auditing");
        onAudit(parsed.audit);
      }
      if (parsed.status === "generating-file") onStatus("generating-file");
      if (parsed.status === "reviewing-layout") onStatus("reviewing-layout");
      if (parsed.status === "revising-layout") onStatus("revising-layout");
      if (
        parsed.status === "file_warning" &&
        typeof parsed.message === "string"
      ) {
        onSearchWarning(parsed.message);
      }
      if (
        parsed.status === "search_warning" &&
        typeof parsed.message === "string"
      ) {
        onSearchWarning(parsed.message);
      }
      if (
        parsed.file &&
        typeof parsed.file === "object" &&
        parsed.file !== null
      ) {
        const f = parsed.file as {
          id?: unknown;
          filename?: unknown;
          mimeType?: unknown;
        };
        if (
          typeof f.id === "number" &&
          typeof f.filename === "string" &&
          typeof f.mimeType === "string"
        ) {
          onFile({ id: f.id, filename: f.filename, mimeType: f.mimeType });
        }
      }
      if (Array.isArray(parsed.sources)) {
        onSources(
          parsed.sources as {
            title: string;
            url: string;
            publishedAt?: string | null;
            fetchedAt?: string | null;
          }[],
        );
      }
      if (parsed.factuality) {
        const report = normalizeFactualityReport(parsed.factuality);
        if (report) onFactuality(report);
      }
      if (Array.isArray(parsed.artifacts)) {
        const artifacts = parsed.artifacts.flatMap((item): ChatArtifact[] => {
          if (!item || typeof item !== "object") return [];
          const raw = item as Record<string, unknown>;
          if (typeof raw.filename !== "string" || typeof raw.mime !== "string")
            return [];
          const artifact: ChatArtifact = {
            id: typeof raw.id === "number" ? raw.id : undefined,
            filename: raw.filename,
            mime: raw.mime,
            size: typeof raw.size === "number" ? raw.size : 0,
            downloadUrl:
              typeof raw.downloadUrl === "string" ? raw.downloadUrl : undefined,
            content: typeof raw.content === "string" ? raw.content : undefined,
          };
          if (!artifact.downloadUrl && artifact.content) {
            if (
              (artifact.mime.startsWith("image/") ||
                artifact.mime.startsWith("audio/")) &&
              artifact.content.startsWith("data:")
            ) {
              artifact.downloadUrl = artifact.content;
            } else {
              const cacheKey = `${artifact.filename}:${artifact.content.length}:${artifact.mime}`;
              let url = artifactBlobUrlCache.current.get(cacheKey);
              if (!url) {
                url = URL.createObjectURL(
                  new Blob([artifact.content], { type: artifact.mime }),
                );
                artifactBlobUrlCache.current.set(cacheKey, url);
              }
              artifact.downloadUrl = url;
            }
          }
          return artifact.downloadUrl ? [artifact] : [];
        });
        if (artifacts.length > 0) onArtifacts(artifacts);
      }
      if (typeof parsed.content === "string" && parsed.content) {
        receivedContent = true;
        if (parsed.status === "revising") {
          onStatus("revising");
        } else {
          onStatus("generating");
        }
        onChunk(parsed.content);
      }
      if (typeof parsed.error === "string" && parsed.error) {
        failed = true;
        onError(new Error(parsed.error), parsed.turnSaved === true);
        return;
      }
      if (parsed.done) callDoneOnce();
    };

    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      }
      if (done) {
        buffer += decoder.decode();
        break;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        handleSseLine(line);
        if (failed) break;
      }
      if (failed) break;
    }
    if (!failed && buffer.trim()) handleSseLine(buffer.trim());
    if (!failed && !doneCalled) {
      if (receivedContent) {
        // The server closed the HTTP response without emitting {done:true}.
        // As long as we received content, treat the turn as complete rather
        // than showing a misleading "connection lost" error.
        callDoneOnce();
      } else {
        failed = true;
        onError(new Error("応答が空でした。もう一度お試しください。"));
        return;
      }
    }
    if (!failed) callDoneOnce();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    if (err instanceof Error && err.name === "AbortError") return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export function ChatPage() {
  const params = useParams();
  const [location, setLocation] = useLocation();
  const isPrivate = location === "/private" || location.startsWith("/private?");
  const [initialSettings] = useState(loadSettings);
  const rawId = params.id;
  const parsedId = rawId ? Number.parseInt(rawId, 10) : NaN;
  const invalidConversationId = rawId != null && !Number.isFinite(parsedId);
  const conversationId = Number.isFinite(parsedId) ? parsedId : null;
  const queryClient = useQueryClient();
  const models = useAvailableModels();
  const greeting = timeGreeting();
  const abortRef = useRef<AbortController | null>(null);
  const sendingToRef = useRef<number | null>(null);

  const [selectedModel, setSelectedModel] = useState(
    initialSettings.defaultModel,
  );
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(
    initialSettings.defaultReasoning,
  );
  const [privateMessages, setPrivateMessages] = useState<OpenaiMessage[]>([]);
  const streamSnapshotRef = useRef({
    content: "",
    sources: [] as {
      title: string;
      url: string;
      publishedAt?: string | null;
      fetchedAt?: string | null;
    }[],
    audit: "",
    factuality: null as FactualityReport | null,
    artifacts: [] as ChatArtifact[],
  });
  const artifactBlobUrlCache = useRef(new Map<string, string>());
  const [modelRestoredForConv, setModelRestoredForConv] = useState<
    number | null
  >(null);
  const [streamingContent, setStreamingContent] = useState<string>("");
  const [streamingSources, setStreamingSources] = useState<
    {
      title: string;
      url: string;
      publishedAt?: string | null;
      fetchedAt?: string | null;
    }[]
  >([]);
  const [streamingArtifacts, setStreamingArtifacts] = useState<ChatArtifact[]>(
    [],
  );
  const [streamingFiles, setStreamingFiles] = useState<
    { id: number; filename: string; mimeType: string }[]
  >([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<{
    kind: string;
    query?: string;
  } | null>(null);
  const [specialistProgress, setSpecialistProgress] = useState<{
    capability: string;
    phase: string;
    message?: string;
  } | null>(null);
  const [searchWarning, setSearchWarning] = useState<string | null>(null);
  const [researchStep, setResearchStep] = useState<{
    step: number;
    maxSteps: number;
  } | null>(null);
  const [activeSkills, setActiveSkills] = useState<
    { id: string; label: string }[]
  >([]);
  const [auditEnabled, setAuditEnabled] = useState(
    initialSettings.auditEnabled,
  );
  const [translationMode, setTranslationMode] =
    useState<TranslationModeSetting>(initialSettings.translationMode);
  const [auditModelId, setAuditModelId] = useState(
    initialSettings.auditModelId,
  );
  const [streamingAudit, setStreamingAudit] = useState("");
  const [streamingFactuality, setStreamingFactuality] =
    useState<FactualityReport | null>(null);
  const resolvedAuditModel = auditEnabled
    ? pickAuditModel(selectedModel, models, auditModelId)
    : undefined;
  const auditModel =
    resolvedAuditModel && resolvedAuditModel !== selectedModel
      ? resolvedAuditModel
      : undefined;
  const [optimisticUserMessage, setOptimisticUserMessage] =
    useState<OpenaiMessage | null>(null);
  const [videoJob, setVideoJob] = useState<OpenaiVideoJob | null>(null);
  const videoBusy =
    videoJob != null &&
    (videoJob.status === "SUBMITTING" ||
      videoJob.status === "PENDING" ||
      videoJob.status === "RUNNING");

  const stopStreaming = () => {
    const targetId = sendingToRef.current ?? conversationId;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setSearchStatus(null);
    setResearchStep(null);
    setSpecialistProgress(null);
    setStreamingAudit("");
    setStreamingFactuality(null);
    setStreamError(null);
    setSearchWarning(
      streamingContent
        ? "生成を停止しました。表示済みの回答を保持しています。"
        : "生成を停止しました。",
    );

    if (isPrivate) {
      const now = new Date().toISOString();
      const stoppedMessages: OpenaiMessage[] = [];
      if (optimisticUserMessage) stoppedMessages.push(optimisticUserMessage);
      if (streamingContent) {
        stoppedMessages.push({
          id: STREAMING_ASSISTANT_ID - privateMessages.length - 1,
          conversationId: 0,
          role: "assistant",
          content: stripArtifactBlocks(streamingContent),
          sources: streamingSources.length > 0 ? streamingSources : null,
          factuality: streamSnapshotRef.current.factuality,
          createdAt: now,
        } as OpenaiMessage);
      }
      if (stoppedMessages.length > 0) {
        setPrivateMessages((previous) => [...previous, ...stoppedMessages]);
      }
      setStreamingContent("");
      setStreamingSources([]);
      setStreamingArtifacts([]);
      setStreamingFiles([]);
      setStreamingFactuality(null);
      setOptimisticUserMessage(null);
      return;
    }

    if (targetId) {
      window.setTimeout(() => {
        void queryClient
          .invalidateQueries({
            queryKey: getGetOpenaiConversationQueryKey(targetId),
          })
          .finally(() => {
            setStreamingContent("");
            setStreamingSources([]);
            setStreamingArtifacts([]);
            setStreamingFiles([]);
            setStreamingFactuality(null);
            setOptimisticUserMessage(null);
          });
      }, 1_000);
    }
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Drop in-flight stream state when switching threads.
  // Skip the reset when we just created this conversation and started sending to it.
  useEffect(() => {
    if (
      sendingToRef.current != null &&
      sendingToRef.current === conversationId
    ) {
      sendingToRef.current = null;
      return;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setStreamingContent("");
    setStreamingSources([]);
    setStreamingArtifacts([]);
    setStreamingFiles([]);
    setOptimisticUserMessage(null);
    setStreamError(null);
    setSearchStatus(null);
    setResearchStep(null);
    setSearchWarning(null);
    setActiveSkills([]);
    setStreamingAudit("");
    setStreamingFactuality(null);
    setVideoJob(null);
    // Revoke object URLs created for ephemeral artifact downloads so we do not
    // leak memory when the user switches conversations.
    artifactBlobUrlCache.current.forEach((url) => URL.revokeObjectURL(url));
    artifactBlobUrlCache.current.clear();
  }, [conversationId]);

  const {
    data: conversation,
    isLoading,
    isError: conversationLoadError,
  } = useGetOpenaiConversation(conversationId as number, {
    query: {
      enabled: !!conversationId && !isPrivate,
      queryKey: getGetOpenaiConversationQueryKey(conversationId as number),
    },
  });

  useEffect(() => {
    if (!isPrivate) setPrivateMessages([]);
  }, [isPrivate]);

  useEffect(
    () =>
      subscribeSettings((s) => {
        setAuditEnabled(s.auditEnabled);
        setAuditModelId(s.auditModelId);
        setTranslationMode(s.translationMode);
      }),
    [],
  );

  // Revoke blob URLs when streaming artifacts are cleared (e.g. after done/error)
  // to prevent memory growth during long sessions.
  useEffect(() => {
    if (streamingArtifacts.length === 0) {
      artifactBlobUrlCache.current.forEach((url) => URL.revokeObjectURL(url));
      artifactBlobUrlCache.current.clear();
    }
  }, [streamingArtifacts]);

  // Safety net: if streaming gets stuck for too long, force-reset the input.
  const STREAMING_TIMEOUT_MS = 5 * 60 * 1000;
  useEffect(() => {
    if (!isStreaming) return;
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      abortRef.current = null;
      setIsStreaming(false);
      setSearchStatus(null);
      setResearchStep(null);
      setStreamingContent("");
      setStreamingSources([]);
      setStreamingArtifacts([]);
      setStreamingFiles([]);
      setStreamingAudit("");
      setStreamingFactuality(null);
      setSpecialistProgress(null);
      setOptimisticUserMessage(null);
      streamSnapshotRef.current = {
        content: "",
        sources: [],
        artifacts: [],
        audit: "",
        factuality: null,
      };
      setStreamError(
        "応答がタイムアウトしました。入力を解放しましたので、もう一度お試しください。",
      );
    }, STREAMING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isStreaming]);

  // Restore the last used model when opening an existing conversation
  useEffect(() => {
    if (isPrivate || !conversation || modelRestoredForConv === conversation.id)
      return;
    const msgs = conversation.messages ?? [];
    const lastAssistant = [...msgs]
      .reverse()
      .find((m) => m.role === "assistant" && m.modelId);
    if (
      lastAssistant?.modelId &&
      models.some((m) => m.id === lastAssistant.modelId)
    ) {
      setSelectedModel(lastAssistant.modelId);
    }
    setModelRestoredForConv(conversation.id);
  }, [conversation, modelRestoredForConv, models, isPrivate]);

  const createConversation = useCreateOpenaiConversation();

  useEffect(() => {
    if (
      !videoJob ||
      !["SUBMITTING", "PENDING", "RUNNING"].includes(videoJob.status)
    )
      return;
    let disposed = false;
    const poll = async () => {
      try {
        const latest = await getOpenaiVideoJob(videoJob.id);
        if (disposed) return;
        setVideoJob(latest);
        if (
          latest.status === "SUCCEEDED" ||
          latest.status === "FAILED" ||
          latest.status === "CANCELED" ||
          latest.status === "UNKNOWN"
        ) {
          await queryClient.invalidateQueries({
            queryKey: getGetOpenaiConversationQueryKey(latest.conversationId),
          });
          setOptimisticUserMessage(null);
        }
      } catch (error) {
        if (!disposed) {
          setStreamError(
            error instanceof Error
              ? error.message
              : "動画ジョブの状態を取得できませんでした。",
          );
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [videoJob?.id, videoJob?.status, queryClient]);

  const handleGenerateVideo = async (
    input: VideoGenerationInput,
  ): Promise<boolean> => {
    if (isPrivate) {
      setStreamError("動画生成は通常の会話で利用してください。");
      return false;
    }
    let targetId = conversationId;
    if (!targetId) {
      try {
        const newConv = await createConversation.mutateAsync({
          data: { title: conversationTitle(input.prompt) },
        });
        targetId = newConv.id;
        await queryClient.invalidateQueries({
          queryKey: getListOpenaiConversationsQueryKey(),
        });
        setLocation(`/conversations/${newConv.id}`, { replace: true });
      } catch (error) {
        setStreamError(
          error instanceof Error ? error.message : "会話の作成に失敗しました。",
        );
        return false;
      }
    }

    setStreamError(null);
    setOptimisticUserMessage({
      id: OPTIMISTIC_USER_ID,
      conversationId: targetId,
      role: "user",
      content: input.prompt,
      createdAt: new Date().toISOString(),
    });
    try {
      const created = await createOpenaiVideoJob(targetId, {
        prompt: input.prompt,
        mode: input.mode,
        ...(input.referenceImages?.length
          ? {
              referenceImages: input.referenceImages.map(
                (image) => image.content,
              ),
            }
          : {}),
        resolution: input.resolution,
        ...(input.mode !== "i2v" ? { ratio: input.ratio } : {}),
        duration: input.duration,
        confirmation: true,
        idempotencyKey: crypto.randomUUID(),
      });
      setVideoJob(created);
      await queryClient.invalidateQueries({
        queryKey: getGetOpenaiConversationQueryKey(targetId),
      });
      // The request message is now in the server response. Do not keep the
      // optimistic copy around while the async job is polling.
      setOptimisticUserMessage(null);
      return true;
    } catch (error) {
      setOptimisticUserMessage(null);
      setStreamError(
        error instanceof Error
          ? error.message
          : "動画生成を開始できませんでした。",
      );
      return false;
    }
  };

  const handleCancelVideo = async () => {
    if (!videoJob || videoJob.status !== "PENDING") return;
    try {
      const canceled = await cancelOpenaiVideoJob(videoJob.id);
      setVideoJob(canceled);
      await queryClient.invalidateQueries({
        queryKey: getGetOpenaiConversationQueryKey(canceled.conversationId),
      });
    } catch (error) {
      setStreamError(
        error instanceof Error
          ? error.message
          : "動画生成をキャンセルできませんでした。",
      );
    }
  };

  const handleRegenerate = () => {
    if (isStreaming) return;
    const allMessages = conversation?.messages ?? [];
    const lastUserMessage = [...allMessages]
      .reverse()
      .find((m) => m.role === "user");
    if (!lastUserMessage) return;
    handleSend(lastUserMessage.content).catch((err) => {
      setStreamError(
        err instanceof Error ? err.message : "再生成に失敗しました。",
      );
    });
  };

  // 戻り値: false = 送信ブロック（入力・添付は保持される）
  const handleSend = async (
    content: string,
    files?: OutgoingAttachment[],
    fileFormat?: FileFormat,
  ): Promise<boolean> => {
    let finalContent = content;
    let visionBridgeNote: string | null = null;

    if (files && files.length > 0) {
      // 画像非対応モデルでも、サーバー側の vision ブリッジが画像をテキスト化する
      // ため送信自体は許可する。精度が落ちる可能性だけ通知する。
      // （文書・音声のバイナリ添付も base64 なので、画像だけを選り分ける）
      const hasImage = files.some(
        (file) => (file.kind ?? (file.isBase64 ? "image" : "file")) === "image",
      );
      if (hasImage) {
        const model = models.find((m) => m.id === selectedModel);
        if (model && !model.supportsVision) {
          visionBridgeNote = `${model.label} は画像を直接読み取れないため、画像対応モデルが内容をテキストに書き起こしてから回答します。`;
        }
      }
      finalContent = serializeAttachmentMessage(content, files);
    }

    let targetId = conversationId;

    if (!isPrivate && !targetId) {
      try {
        const newConv = await createConversation.mutateAsync({
          data: { title: conversationTitle(content) },
        });
        targetId = newConv.id;
        queryClient.invalidateQueries({
          queryKey: getListOpenaiConversationsQueryKey(),
        });
        setLocation(`/conversations/${newConv.id}`, { replace: true });
      } catch (err) {
        setStreamError(
          err instanceof Error
            ? err.message
            : "会話の作成に失敗しました。もう一度お試しください。",
        );
        return false;
      }
    }

    if (!isPrivate && !targetId) return false;

    sendingToRef.current = targetId ?? 0;
    setStreamError(null);
    setSearchWarning(visionBridgeNote);
    setActiveSkills([]);
    setStreamingAudit("");
    setStreamingFactuality(null);
    setStreamingArtifacts([]);
    setOptimisticUserMessage({
      id: OPTIMISTIC_USER_ID,
      conversationId: targetId ?? 0,
      role: "user",
      content: finalContent,
      createdAt: new Date().toISOString(),
    });

    setIsStreaming(true);
    setStreamingContent("");
    setStreamingSources([]);
    setStreamingArtifacts([]);
    setStreamingFiles([]);
    setSearchStatus({ kind: "starting" });
    setSpecialistProgress(null);
    streamSnapshotRef.current = {
      content: "",
      sources: [],
      audit: "",
      factuality: null,
      artifacts: [],
    };

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const privateHistory = isPrivate
      ? privateMessages.flatMap((message) => {
          if (message.role !== "user" && message.role !== "assistant")
            return [];
          return [
            {
              role: message.role as "user" | "assistant",
              content:
                message.role === "user"
                  ? compactAttachmentMessageForHistory(message.content)
                  : message.content,
            },
          ];
        })
      : undefined;

    // ストリーム開始を待たずに true を返し、入力欄をすぐクリアさせる。
    // 完了・失敗は各コールバックと isStreaming で制御する。
    void streamMessage(
      targetId ?? 0,
      content,
      selectedModel,
      reasoningLevel,
      (chunk) => {
        streamSnapshotRef.current.content += chunk;
        setStreamingContent((prev) => prev + chunk);
      },
      async () => {
        setSearchStatus(null);
        setResearchStep(null);
        try {
          if (isPrivate) {
            const now = new Date().toISOString();
            const finalAssistantContent = stripArtifactBlocks(
              streamSnapshotRef.current.content,
            );
            setPrivateMessages((prev) => [
              ...prev,
              {
                id: OPTIMISTIC_USER_ID - prev.length - 1,
                conversationId: 0,
                role: "user",
                content: finalContent,
                createdAt: now,
              },
              {
                id: STREAMING_ASSISTANT_ID - prev.length - 1,
                conversationId: 0,
                role: "assistant",
                content: finalAssistantContent,
                sources:
                  streamSnapshotRef.current.sources.length > 0
                    ? streamSnapshotRef.current.sources
                    : null,
                artifacts:
                  streamSnapshotRef.current.artifacts.length > 0
                    ? streamSnapshotRef.current.artifacts
                    : null,
                assetIds:
                  streamingFiles.length > 0
                    ? streamingFiles.map((f) => f.id)
                    : null,
                modelId: selectedModel,
                auditContent: streamSnapshotRef.current.audit || null,
                auditModelId: streamSnapshotRef.current.audit
                  ? auditModel
                  : null,
                factuality: streamSnapshotRef.current.factuality,
                createdAt: now,
              } as OpenaiMessage,
            ]);
          } else {
            await queryClient.invalidateQueries({
              queryKey: getGetOpenaiConversationQueryKey(targetId!),
            });
          }
        } catch (err) {
          setStreamError(
            err instanceof Error
              ? err.message
              : "会話の保存に失敗しました。リロードして確認してください。",
          );
        } finally {
          setIsStreaming(false);
          setStreamingContent("");
          setStreamingSources([]);
          setStreamingArtifacts([]);
          setStreamingFiles([]);
          setStreamingAudit("");
          setStreamingFactuality(null);
          setSpecialistProgress(null);
          setOptimisticUserMessage(null);
        }
      },
      (err, turnSaved) => {
        setIsStreaming(false);
        setSearchStatus(null);
        setResearchStep(null);
        setSpecialistProgress(null);
        setStreamError(err.message);

        if (isPrivate) {
          const now = new Date().toISOString();
          const partialContent = stripArtifactBlocks(
            streamSnapshotRef.current.content,
          );
          setPrivateMessages((previous) => [
            ...previous,
            {
              id: OPTIMISTIC_USER_ID - previous.length - 1,
              conversationId: 0,
              role: "user",
              content: finalContent,
              createdAt: now,
            },
            ...(streamSnapshotRef.current.content.trim()
              ? [
                  {
                    id: STREAMING_ASSISTANT_ID - previous.length - 1,
                    conversationId: 0,
                    role: "assistant" as const,
                    content: partialContent,
                    sources:
                      streamSnapshotRef.current.sources.length > 0
                        ? streamSnapshotRef.current.sources
                        : null,
                    createdAt: now,
                  } as OpenaiMessage,
                ]
              : []),
          ]);
          setStreamingContent("");
          setStreamingSources([]);
          setStreamingArtifacts([]);
          setStreamingFiles([]);
          setStreamingAudit("");
          setStreamingFactuality(null);
          setOptimisticUserMessage(null);
        } else if (turnSaved && targetId) {
          void queryClient
            .invalidateQueries({
              queryKey: getGetOpenaiConversationQueryKey(targetId),
            })
            .finally(() => {
              setStreamingContent("");
              setStreamingSources([]);
              setStreamingArtifacts([]);
              setStreamingFiles([]);
              setStreamingAudit("");
              setStreamingFactuality(null);
              setOptimisticUserMessage(null);
            });
        }
        // If persistence also failed, retain the optimistic question and any
        // streamed answer locally. A transient backend error must never erase
        // text the user has already submitted or seen.
      },
      (status, query) => {
        setSearchStatus(status ? { kind: status, query } : null);
      },
      (event) => {
        setSpecialistProgress(event);
      },
      (message) => {
        setSearchWarning(message);
      },
      (step) => {
        setResearchStep(step);
      },
      (sources) => {
        streamSnapshotRef.current.sources = sources;
        setStreamingSources(sources);
      },
      (report) => {
        streamSnapshotRef.current.factuality = report;
        setStreamingFactuality(report);
      },
      (skills) => {
        setActiveSkills(skills);
      },
      (chunk) => {
        streamSnapshotRef.current.audit += chunk;
        setStreamingAudit((prev) => prev + chunk);
      },
      (artifacts) => {
        streamSnapshotRef.current.artifacts = artifacts;
        setStreamingArtifacts(artifacts);
      },
      () => {
        streamSnapshotRef.current.content = "";
        setStreamingContent("");
      },
      (operations) => {
        const patched = applyClientPatch(
          streamSnapshotRef.current.content,
          operations,
        );
        if (patched !== null) {
          streamSnapshotRef.current.content = patched;
          setStreamingContent(patched);
        }
      },
      (file) => {
        setStreamingFiles((prev) => [...prev, file]);
      },
      artifactBlobUrlCache,
      controller.signal,
      {
        ...(isPrivate ? { ephemeral: true, history: privateHistory } : {}),
        ...(auditModel ? { auditModel } : {}),
        ...(translationMode !== "off" ? { translationMode } : {}),
        ...(fileFormat ? { fileFormat } : {}),
        ...(files && files.length > 0 ? { attachments: files } : {}),
      },
    );
    return true;
  };

  // サーバー側に既に同じユーザーメッセージが保存済みなら楽観的表示を重複させない
  const serverMessages = isPrivate
    ? privateMessages
    : conversation?.messages || [];
  const optimisticAlreadyOnServer =
    optimisticUserMessage != null &&
    serverMessages.some(
      (m) =>
        m.role === "user" &&
        m.content === optimisticUserMessage.content &&
        Math.abs(
          new Date(m.createdAt).getTime() -
            new Date(optimisticUserMessage.createdAt).getTime(),
        ) <= 2_000,
    );

  // ストリーミング中の内容がサーバーに保存済みなら、ストリーミング吹き出しも重複させない
  const streamingAlreadyOnServer =
    streamingContent.length > 0 &&
    serverMessages.some(
      (m) => m.role === "assistant" && m.content === streamingContent,
    );

  const allMessages = [
    ...serverMessages,
    ...(optimisticUserMessage && !optimisticAlreadyOnServer
      ? [optimisticUserMessage]
      : []),
    ...((isStreaming ||
      streamingContent ||
      streamingArtifacts.length > 0 ||
      streamingFiles.length > 0) &&
    !streamingAlreadyOnServer
      ? [
          {
            id: STREAMING_ASSISTANT_ID,
            conversationId: conversationId || 0,
            role: "assistant",
            content: streamingContent,
            sources: streamingSources.length > 0 ? streamingSources : null,
            factuality: streamingFactuality,
            artifacts:
              streamingArtifacts.length > 0
                ? (streamingArtifacts as unknown as OpenaiArtifact[])
                : null,
            assetIds:
              streamingFiles.length > 0
                ? streamingFiles.map((f) => f.id)
                : null,
            createdAt: new Date().toISOString(),
          } as OpenaiMessage,
        ]
      : []),
  ];

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex flex-1 flex-col overflow-hidden">
        {!isPrivate &&
        (invalidConversationId ||
          (conversationLoadError && !optimisticUserMessage && !isStreaming)) ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <h2 className="text-xl font-serif font-medium mb-2">
              会話が見つかりません
            </h2>
            <p className="text-muted-foreground text-sm">
              URL
              が正しくないか、この会話にアクセスできません。左の履歴から選び直してください。
            </p>
          </div>
        ) : !conversationId &&
          !optimisticUserMessage &&
          privateMessages.length === 0 ? (
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-10 text-center sm:px-8">
            <div
              className={cn(
                "relative mb-7 flex h-20 w-20 items-center justify-center rounded-[var(--m3-shape-xl)] border shadow-[var(--m3-elevation-3)] before:absolute before:inset-0 before:-z-10 before:rounded-[var(--m3-shape-xl)] before:blur-2xl",
                isPrivate
                  ? "[background:var(--app-status-accent-container)] [border-color:var(--app-status-accent)] before:[background:var(--app-status-accent-container)]"
                  : "[background:var(--m3-primary-container)] [border-color:var(--m3-primary)] before:[background:var(--m3-primary-container)]",
              )}
            >
              {isPrivate ? (
                <Shield className="w-9 h-9 [color:var(--app-status-accent)]" />
              ) : (
                <Sparkles className="w-9 h-9 text-primary" />
              )}
            </div>
            <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-primary/70">
              {isPrivate ? "Ephemeral workspace" : "Ready when you are"}
            </div>
            <h2 className="text-balance mb-3 font-serif text-3xl font-medium tracking-[-0.025em] text-foreground sm:text-4xl">
              {isPrivate ? "プライベートセッション" : greeting.title}
            </h2>
            <p className="text-balance mb-8 max-w-lg font-sans text-base font-light leading-7 text-muted-foreground sm:text-lg">
              {isPrivate
                ? "この会話はサーバーに保存されません。タブを閉じると履歴は消えます。"
                : greeting.subtitle}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] text-muted-foreground">
              {["Webリサーチ", "画像・文書解析", "資料生成", "複数モデル"].map(
                (capability) => (
                  <span
                    key={capability}
                    className="rounded-[var(--m3-shape-full)] border border-[var(--m3-outline-variant)] [background:var(--m3-surface-container-low)] px-3 py-1.5 shadow-[var(--m3-elevation-0)]"
                  >
                    {capability}
                  </span>
                ),
              )}
            </div>
          </div>
        ) : (
          <MessageFeed
            messages={allMessages}
            isLoading={isLoading && !isStreaming && allMessages.length === 0}
            streamingPhase={
              isStreaming
                ? searchStatus?.kind === "thinking"
                  ? "thinking"
                  : searchStatus?.kind === "reading-images"
                    ? "reading-images"
                    : searchStatus?.kind === "reading-files"
                      ? "reading-files"
                      : searchStatus?.kind === "revising"
                        ? "revising"
                        : searchStatus?.kind === "auditing"
                          ? "auditing"
                          : searchStatus?.kind === "verifying"
                            ? "verifying"
                            : searchStatus?.kind === "researching"
                              ? "researching"
                              : searchStatus?.kind === "searching" ||
                                  searchStatus?.kind === "fetching"
                                ? "searching"
                                : searchStatus?.kind === "generating-file"
                                  ? "generating-file"
                                  : searchStatus?.kind === "reviewing-layout"
                                    ? "reviewing-layout"
                                    : searchStatus?.kind === "revising-layout"
                                      ? "revising-layout"
                                      : streamingContent
                                        ? "generating"
                                        : "starting"
                : null
            }
            researchStep={researchStep}
            streamingAudit={streamingAudit}
            streamingFactuality={streamingFactuality}
            specialistProgress={specialistProgress}
            streamingFiles={streamingFiles}
            videoJob={videoJob}
            onCancelVideo={() => void handleCancelVideo()}
            isStreaming={isStreaming}
            onStop={stopStreaming}
            streamingWarning={searchWarning}
            onDismissWarning={() => setSearchWarning(null)}
            onRegenerate={!isPrivate ? handleRegenerate : undefined}
          />
        )}
      </div>

      {streamError && (
        <div className="mx-auto mb-2 w-full max-w-4xl px-4 md:px-6">
          <div className="flex items-start gap-2 rounded-[var(--m3-shape-lg)] border [border-color:var(--m3-error)] [background:var(--m3-error-container)] px-4 py-2 text-sm [color:var(--m3-on-error-container)]">
            <span className="flex-1">エラー: {streamError}</span>
            <button
              type="button"
              onClick={() => setStreamError(null)}
              className="shrink-0 p-0.5 rounded hover:bg-destructive/20"
              aria-label="エラーを閉じる"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="bg-gradient-to-t from-background via-background/95 to-transparent px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-8 sm:px-5 md:px-6 md:pb-5 md:pt-10">
        <div className="mx-auto max-w-4xl">
          <MessageInput
            onSend={handleSend}
            disabled={isStreaming || videoBusy || createConversation.isPending}
            conversationId={conversationId}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
            reasoningLevel={reasoningLevel}
            onReasoningChange={setReasoningLevel}
            translationMode={translationMode}
            onTranslationModeChange={(mode) => {
              setTranslationMode(mode);
              saveSettings({ translationMode: mode });
            }}
            auditEnabled={auditEnabled}
            onAuditToggle={() => {
              const next = !auditEnabled;
              setAuditEnabled(next);
              saveSettings({ auditEnabled: next });
            }}
            auditModel={auditModel}
            activeSkills={activeSkills}
            fileGenerationEnabled={!isPrivate && translationMode === "off"}
            videoGenerationEnabled={!isPrivate}
            onGenerateVideo={handleGenerateVideo}
            placeholder={
              translationMode !== "off"
                ? "翻訳するテキストをそのまま入力..."
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
