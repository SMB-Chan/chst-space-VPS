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
} from "@workspace/api-client-react";
import { MessageFeed, type ChatArtifact } from "@/components/chat/message-feed";
import { MessageInput, type OutgoingAttachment, type FileFormat } from "@/components/chat/message-input";
import { ModelSelector, useAvailableModels } from "@/components/chat/model-selector";
import { ReasoningSelector } from "@/components/chat/reasoning-selector";
import { conversationTitle, timeGreeting, OPTIMISTIC_USER_ID, STREAMING_ASSISTANT_ID } from "@/lib/chat";
import { type ReasoningLevel } from "@/lib/reasoning";
import { loadSettings, pickAuditModel, saveSettings, subscribeSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Sparkles, X, Shield, Scale } from "lucide-react";

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
  onReasoning: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onStatus: (status: string | null, query?: string) => void,
  onSearchWarning: (message: string) => void,
  onSources: (sources: { title: string; url: string }[]) => void,
  onSkills: (skills: { id: string; label: string }[]) => void,
  onAudit: (text: string) => void,
  onArtifacts: (artifacts: ChatArtifact[]) => void,
  onResetContent: () => void,
  onFile: (file: { id: number; filename: string; mimeType: string }) => void,
  signal?: AbortSignal,
  extra?: { ephemeral?: boolean; history?: { role: string; content: string }[]; auditModel?: string; fileFormat?: FileFormat },
) {
  try {
    const path = extra?.ephemeral
      ? `${BASE}/api/openai/ephemeral/messages`
      : `${BASE}/api/openai/conversations/${conversationId}/messages`;
    const auditQuery = extra?.auditModel
      ? `&auditModel=${encodeURIComponent(extra.auditModel)}&auditReasoning=${encodeURIComponent(loadSettings().auditReasoning)}`
      : "";
    const res = await fetch(
      `${path}?model=${encodeURIComponent(model)}&reasoning=${encodeURIComponent(reasoning)}${auditQuery}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          ...(extra?.fileFormat ? { fileFormat: extra.fileFormat } : {}),
          ...(extra?.ephemeral && extra.history ? { history: extra.history } : {}),
        }),
        credentials: "include",
        signal,
      }
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
              !!s && typeof s === "object" && typeof (s as { id?: unknown }).id === "string" && typeof (s as { label?: unknown }).label === "string",
          ),
        );
      }
      if (parsed.status === "searching") onStatus("searching", parsed.query as string | undefined);
      if (parsed.status === "fetching") onStatus("fetching");
      if (parsed.status === "thinking") onStatus("thinking");
      if (parsed.status === "generating") onStatus("generating");
      if (parsed.status === "auditing") onStatus("auditing");
      if (parsed.status === "revising") {
        onStatus("revising");
        if (parsed.resetContent) onResetContent();
      }
      if (typeof parsed.audit === "string" && parsed.audit) {
        onStatus("auditing");
        onAudit(parsed.audit);
      }
      if (parsed.status === "generating-file") onStatus("generating-file");
      if (parsed.status === "reviewing-layout") onStatus("reviewing-layout");
      if (parsed.status === "revising-layout") onStatus("revising-layout");
      if (parsed.status === "file_warning" && typeof parsed.message === "string") {
        onSearchWarning(parsed.message);
      }
      if (parsed.status === "search_warning" && typeof parsed.message === "string") {
        onSearchWarning(parsed.message);
      }
      if (parsed.file && typeof parsed.file === "object" && parsed.file !== null) {
        const f = parsed.file as { id?: unknown; filename?: unknown; mimeType?: unknown };
        if (
          typeof f.id === "number" &&
          typeof f.filename === "string" &&
          typeof f.mimeType === "string"
        ) {
          onFile({ id: f.id, filename: f.filename, mimeType: f.mimeType });
        }
      }
      if (Array.isArray(parsed.sources)) {
        onSources(parsed.sources as { title: string; url: string }[]);
      }
      if (Array.isArray(parsed.artifacts)) {
        const artifacts = parsed.artifacts.flatMap((item): ChatArtifact[] => {
          if (!item || typeof item !== "object") return [];
          const raw = item as Record<string, unknown>;
          if (typeof raw.filename !== "string" || typeof raw.mime !== "string") return [];
          const artifact: ChatArtifact = {
            id: typeof raw.id === "number" ? raw.id : undefined,
            filename: raw.filename,
            mime: raw.mime,
            size: typeof raw.size === "number" ? raw.size : 0,
            downloadUrl: typeof raw.downloadUrl === "string" ? raw.downloadUrl : undefined,
            content: typeof raw.content === "string" ? raw.content : undefined,
          };
          if (!artifact.downloadUrl && artifact.content) {
            artifact.downloadUrl = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mime }));
          }
          return artifact.downloadUrl ? [artifact] : [];
        });
        if (artifacts.length > 0) onArtifacts(artifacts);
      }
      if (typeof parsed.reasoning === "string" && parsed.reasoning) {
        onStatus(parsed.status === "revising" ? "revising" : "thinking");
        onReasoning(parsed.reasoning);
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
        onError(new Error(parsed.error));
        return;
      }
      if (parsed.done) callDoneOnce();
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
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
      // done を受け取らずにストリームが終わった = 途中切断。
      // サーバー側は監査・修正と保存を続行するので、開き直せば最終稿が見える。
      failed = true;
      onError(
        new Error(
          receivedContent
            ? "接続が途中で切れました。会話を開き直すと、保存された最新の回答を確認できます。"
            : "応答が空でした。もう一度お試しください。",
        ),
      );
      return;
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
  const initialSettings = loadSettings();
  const rawId = params.id;
  const parsedId = rawId ? Number.parseInt(rawId, 10) : NaN;
  const invalidConversationId = rawId != null && !Number.isFinite(parsedId);
  const conversationId = Number.isFinite(parsedId) ? parsedId : null;
  const queryClient = useQueryClient();
  const models = useAvailableModels();
  const greeting = timeGreeting();
  const abortRef = useRef<AbortController | null>(null);
  const sendingToRef = useRef<number | null>(null);

  const [selectedModel, setSelectedModel] = useState(initialSettings.defaultModel);
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(initialSettings.defaultReasoning);
  const [privateMessages, setPrivateMessages] = useState<OpenaiMessage[]>([]);
  const streamSnapshotRef = useRef({
    content: "",
    sources: [] as { title: string; url: string }[],
    audit: "",
    artifacts: [] as ChatArtifact[],
  });
  const [modelRestoredForConv, setModelRestoredForConv] = useState<number | null>(null);
  const [streamingContent, setStreamingContent] = useState<string>("");
  const [streamingReasoning, setStreamingReasoning] = useState<string>("");
  const [streamingSources, setStreamingSources] = useState<{ title: string; url: string }[]>([]);
  const [streamingArtifacts, setStreamingArtifacts] = useState<ChatArtifact[]>([]);
  const [streamingFiles, setStreamingFiles] = useState<{ id: number; filename: string; mimeType: string }[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<{ kind: string; query?: string } | null>(null);
  const [searchWarning, setSearchWarning] = useState<string | null>(null);
  const [activeSkills, setActiveSkills] = useState<{ id: string; label: string }[]>([]);
  const [auditEnabled, setAuditEnabled] = useState(initialSettings.auditEnabled);
  const [auditModelId, setAuditModelId] = useState(initialSettings.auditModelId);
  const [streamingAudit, setStreamingAudit] = useState("");
  const resolvedAuditModel = auditEnabled
    ? pickAuditModel(selectedModel, models, auditModelId)
    : undefined;
  const auditModel =
    resolvedAuditModel && resolvedAuditModel !== selectedModel ? resolvedAuditModel : undefined;
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<OpenaiMessage | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Drop in-flight stream state when switching threads.
  // Skip the reset when we just created this conversation and started sending to it.
  useEffect(() => {
    if (sendingToRef.current != null && sendingToRef.current === conversationId) {
      sendingToRef.current = null;
      return;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setStreamingContent("");
    setStreamingReasoning("");
    setStreamingSources([]);
    setStreamingArtifacts([]);
    setStreamingFiles([]);
    setOptimisticUserMessage(null);
    setStreamError(null);
    setSearchStatus(null);
    setSearchWarning(null);
    setActiveSkills([]);
    setStreamingAudit("");
  }, [conversationId]);

  const { data: conversation, isLoading, isError: conversationLoadError } = useGetOpenaiConversation(
    conversationId as number,
    { query: { enabled: !!conversationId && !isPrivate, queryKey: getGetOpenaiConversationQueryKey(conversationId as number) } }
  );

  useEffect(() => {
    if (!isPrivate) setPrivateMessages([]);
  }, [isPrivate]);

  useEffect(() => subscribeSettings((s) => {
    setAuditEnabled(s.auditEnabled);
    setAuditModelId(s.auditModelId);
  }), []);

  // Restore the last used model when opening an existing conversation
  useEffect(() => {
    if (isPrivate || !conversation || modelRestoredForConv === conversation.id) return;
    const msgs = conversation.messages ?? [];
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant" && m.modelId);
    if (lastAssistant?.modelId && models.some((m) => m.id === lastAssistant.modelId)) {
      setSelectedModel(lastAssistant.modelId);
    }
    setModelRestoredForConv(conversation.id);
  }, [conversation, modelRestoredForConv, models, isPrivate]);

  const createConversation = useCreateOpenaiConversation();

  // 戻り値: false = 送信ブロック（入力・添付は保持される）
  const handleSend = async (
    content: string,
    files?: OutgoingAttachment[],
    fileFormat?: FileFormat,
  ): Promise<boolean> => {
    let finalContent = content;

    if (files && files.length > 0) {
      // 選択中モデルが画像非対応なら、送信前に分かりやすいエラーを表示する
      const hasImage = files.some((file) => file.isBase64);
      if (hasImage) {
        const model = models.find((m) => m.id === selectedModel);
        if (model && !model.supportsVision) {
          setStreamError(
            `${model.label} は画像を読み取れません。画像を送る場合は GPT や Qwen などの画像対応モデルを選択してください。`
          );
          return false;
        }
      }
      finalContent = `CS_ATTACHMENTS_V1:${JSON.stringify({
        question: content,
        attachments: files.map((file) => ({
          kind: file.isBase64 ? "image" : "file",
          name: file.name,
          content: file.content,
          isBase64: file.isBase64,
        })),
      })}`;
    }

    let targetId = conversationId;

    if (!isPrivate && !targetId) {
      try {
        const newConv = await createConversation.mutateAsync({
          data: { title: conversationTitle(content) },
        });
        targetId = newConv.id;
        queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
        setLocation(`/conversations/${newConv.id}`, { replace: true });
      } catch (err) {
        setStreamError(
          err instanceof Error ? err.message : "会話の作成に失敗しました。もう一度お試しください。",
        );
        return false;
      }
    }

    if (!isPrivate && !targetId) return false;

    sendingToRef.current = targetId ?? 0;
    setStreamError(null);
    setSearchWarning(null);
    setActiveSkills([]);
    setStreamingAudit("");
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
    setStreamingReasoning("");
    setStreamingSources([]);
    setStreamingArtifacts([]);
    setStreamingFiles([]);
    setSearchStatus({ kind: "starting" });
    streamSnapshotRef.current = { content: "", sources: [], audit: "", artifacts: [] };

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const privateHistory = isPrivate
      ? privateMessages.map((m) => ({ role: m.role, content: m.content }))
      : undefined;

    // ストリーム開始を待たずに true を返し、入力欄をすぐクリアさせる。
    // 完了・失敗は各コールバックと isStreaming で制御する。
    void streamMessage(
      targetId ?? 0,
      finalContent,
      selectedModel,
      reasoningLevel,
      (chunk) => {
        streamSnapshotRef.current.content += chunk;
        setStreamingContent((prev) => prev + chunk);
      },
      (chunk) => {
        setStreamingReasoning((prev) => prev + chunk);
      },
      async () => {
        setSearchStatus(null);
        if (isPrivate) {
          const now = new Date().toISOString();
          const finalAssistantContent = stripArtifactBlocks(streamSnapshotRef.current.content);
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
              sources: streamSnapshotRef.current.sources.length > 0 ? streamSnapshotRef.current.sources : null,
              artifacts: streamSnapshotRef.current.artifacts.length > 0 ? streamSnapshotRef.current.artifacts : null,
              assetIds: streamingFiles.length > 0 ? streamingFiles.map((f) => f.id) : null,
              modelId: selectedModel,
              auditContent: streamSnapshotRef.current.audit || null,
              auditModelId: streamSnapshotRef.current.audit ? auditModel : null,
              createdAt: now,
            } as OpenaiMessage,
          ]);
        } else {
          await queryClient.invalidateQueries({ queryKey: getGetOpenaiConversationQueryKey(targetId!) });
        }
        setIsStreaming(false);
        setStreamingContent("");
        setStreamingReasoning("");
        setStreamingSources([]);
        setStreamingArtifacts([]);
        setStreamingFiles([]);
        setStreamingAudit("");
        setOptimisticUserMessage(null);
      },
      (err) => {
        setIsStreaming(false);
        setSearchStatus(null);
        setStreamingSources([]);
        setStreamingArtifacts([]);
        setStreamingFiles([]);
        setStreamingReasoning("");
        setStreamingAudit("");
        setStreamError(err.message);
        if (!isPrivate && targetId) {
          void queryClient
            .invalidateQueries({ queryKey: getGetOpenaiConversationQueryKey(targetId) })
            .finally(() => setOptimisticUserMessage(null));
        } else {
          setOptimisticUserMessage(null);
        }
      },
      (status, query) => {
        setSearchStatus(status ? { kind: status, query } : null);
      },
      (message) => {
        setSearchWarning(message);
      },
      (sources) => {
        streamSnapshotRef.current.sources = sources;
        setStreamingSources(sources);
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
      (file) => {
        setStreamingFiles((prev) => [...prev, file]);
      },
      controller.signal,
      {
        ...(isPrivate ? { ephemeral: true, history: privateHistory } : {}),
        ...(auditModel ? { auditModel } : {}),
        ...(fileFormat ? { fileFormat } : {}),
      },
    );
    return true;
  };

  // サーバー側に既に同じユーザーメッセージが保存済みなら楽観的表示を重複させない
  const serverMessages = isPrivate ? privateMessages : (conversation?.messages || []);
  const optimisticAlreadyOnServer =
    optimisticUserMessage != null &&
    serverMessages.some(
      (m) => m.role === "user" && m.content === optimisticUserMessage.content
        && new Date(m.createdAt).getTime() >= new Date(optimisticUserMessage.createdAt).getTime() - 60_000
    );

  // ストリーミング中の内容がサーバーに保存済みなら、ストリーミング吹き出しも重複させない
  const streamingAlreadyOnServer =
    streamingContent.length > 0 &&
    serverMessages.some((m) => m.role === "assistant" && m.content === streamingContent);

  const allMessages = [
    ...serverMessages,
    ...(optimisticUserMessage && !optimisticAlreadyOnServer ? [optimisticUserMessage] : []),
    ...((isStreaming || streamingContent || streamingArtifacts.length > 0 || streamingFiles.length > 0) && !streamingAlreadyOnServer
      ? [{
          id: STREAMING_ASSISTANT_ID,
          conversationId: conversationId || 0,
          role: "assistant",
          content: streamingContent,
          sources: streamingSources.length > 0 ? streamingSources : null,
          artifacts: streamingArtifacts.length > 0 ? streamingArtifacts as unknown as OpenaiArtifact[] : null,
          assetIds: streamingFiles.length > 0 ? streamingFiles.map((f) => f.id) : null,
          createdAt: new Date().toISOString(),
        } as OpenaiMessage]
      : []),
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden flex flex-col">
        {!isPrivate && (invalidConversationId || (conversationLoadError && !optimisticUserMessage && !isStreaming)) ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <h2 className="text-xl font-serif font-medium mb-2">会話が見つかりません</h2>
            <p className="text-muted-foreground text-sm">URL が正しくないか、この会話にアクセスできません。左の履歴から選び直してください。</p>
          </div>
        ) : !conversationId && !optimisticUserMessage && privateMessages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 max-w-2xl mx-auto w-full">
            <div className={cn(
              "w-16 h-16 rounded-2xl flex items-center justify-center mb-6 shadow-inner border",
              isPrivate
                ? "bg-violet-500/10 border-violet-500/30"
                : "bg-primary/10 border-primary/20",
            )}>
              {isPrivate ? (
                <Shield className="w-8 h-8 text-violet-300" />
              ) : (
                <Sparkles className="w-8 h-8 text-primary" />
              )}
            </div>
            <h2 className="text-3xl font-serif font-medium mb-3 text-foreground tracking-tight">
              {isPrivate ? "プライベートセッション" : greeting.title}
            </h2>
            <p className="text-muted-foreground mb-8 text-lg max-w-md font-sans font-light">
              {isPrivate
                ? "この会話はサーバーに保存されません。タブを閉じると履歴は消えます。"
                : greeting.subtitle}
            </p>
          </div>
        ) : (
          <MessageFeed
            messages={allMessages}
            isLoading={isLoading && !isStreaming && allMessages.length === 0}
            streamingPhase={
              isStreaming
                ? searchStatus?.kind === "thinking"
                  ? "thinking"
                  : searchStatus?.kind === "revising"
                    ? "revising"
                  : searchStatus?.kind === "auditing"
                    ? "auditing"
                  : searchStatus?.kind === "searching" || searchStatus?.kind === "fetching"
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
            streamingReasoning={streamingReasoning}
            streamingAudit={streamingAudit}
          />
        )}
      </div>

      {activeSkills.length > 0 && (
        <div className="mx-4 md:mx-6 mb-2 max-w-3xl mx-auto w-full">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-sm text-emerald-700 dark:text-emerald-300">
            <span className="text-xs uppercase tracking-wider opacity-80">自動スキル</span>
            {activeSkills.map((skill) => (
              <span
                key={skill.id}
                className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-xs font-medium"
              >
                {skill.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {searchStatus && (searchStatus.kind === "searching" || searchStatus.kind === "fetching") && (
        <div className="mx-4 md:mx-6 mb-2 max-w-3xl mx-auto w-full">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/5 border border-primary/20 text-sm text-muted-foreground">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            {searchStatus.kind === "searching"
              ? `Webを検索中${searchStatus.query ? `: 「${searchStatus.query}」` : "..."}`
              : "ページを読み込み中..."}
          </div>
        </div>
      )}

      {searchWarning && (
        <div className="mx-4 md:mx-6 mb-2 max-w-3xl mx-auto w-full">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-sm">
            <span className="shrink-0">⚠️</span>
            {searchWarning}
          </div>
        </div>
      )}

      {streamError && (
        <div className="mx-4 md:mx-6 mb-2 max-w-3xl mx-auto w-full">
          <div className="flex items-start gap-2 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
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

      <div className="px-4 md:px-6 pt-10 pb-[calc(1rem+env(safe-area-inset-bottom))] md:pb-6 bg-gradient-to-t from-background via-background to-transparent">
        <div className="max-w-3xl mx-auto space-y-2">
          <div className="flex items-center gap-2 px-1 flex-nowrap overflow-x-auto scrollbar-none [&>*]:shrink-0">
            <ModelSelector
              selectedModel={selectedModel}
              onSelect={setSelectedModel}
              disabled={isStreaming || createConversation.isPending}
            />
            {(models.find((m) => m.id === selectedModel)?.supportsReasoning ?? true) && (
              <ReasoningSelector
                value={reasoningLevel}
                onSelect={setReasoningLevel}
                disabled={isStreaming || createConversation.isPending}
              />
            )}
            <button
              type="button"
              disabled={isStreaming || createConversation.isPending}
              onClick={() => {
                const next = !auditEnabled;
                setAuditEnabled(next);
                saveSettings({ auditEnabled: next });
              }}
              className={cn(
                "h-7 gap-1.5 px-2.5 rounded-full text-xs font-medium border inline-flex items-center",
                auditEnabled
                  ? "text-sky-300 border-sky-500/40 bg-sky-500/10"
                  : "text-muted-foreground border-border/50 hover:text-foreground",
                (isStreaming || createConversation.isPending) && "opacity-50",
              )}
              title={auditModel ? `監査: ${auditModel}` : "監査モード"}
            >
              <Scale className="w-3 h-3" />
              監査{auditEnabled ? " ON" : ""}
            </button>
          </div>
          <MessageInput
            onSend={handleSend}
            disabled={isStreaming || createConversation.isPending}
          />
        </div>
      </div>
    </div>
  );
}
