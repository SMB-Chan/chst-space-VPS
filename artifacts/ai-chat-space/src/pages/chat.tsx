import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetOpenaiConversation, 
  useCreateOpenaiConversation,
  getGetOpenaiConversationQueryKey,
  getListOpenaiConversationsQueryKey,
  OpenaiMessage
} from "@workspace/api-client-react";
import { MessageFeed } from "@/components/chat/message-feed";
import { MessageInput } from "@/components/chat/message-input";
import { ModelSelector, useAvailableModels } from "@/components/chat/model-selector";
import { conversationTitle, timeGreeting } from "@/lib/chat";
import { Sparkles, X } from "lucide-react";

const OPTIMISTIC_USER_ID = -1;
const STREAMING_ASSISTANT_ID = -2;

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function streamMessage(
  conversationId: number,
  content: string,
  model: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onStatus: (status: string | null, query?: string) => void,
  onSearchWarning: (message: string) => void,
  onSources: (sources: { title: string; url: string }[]) => void,
  signal?: AbortSignal,
) {
  try {
    const res = await fetch(
      `${BASE}/api/openai/conversations/${conversationId}/messages?model=${encodeURIComponent(model)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
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
      if (parsed.status === "searching") onStatus("searching", parsed.query as string | undefined);
      if (parsed.status === "fetching") onStatus("fetching");
      if (parsed.status === "search_warning" && typeof parsed.message === "string") {
        onSearchWarning(parsed.message);
      }
      if (Array.isArray(parsed.sources)) {
        onSources(parsed.sources as { title: string; url: string }[]);
      }
      if (typeof parsed.content === "string" && parsed.content) {
        onStatus(null);
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
    if (!failed) callDoneOnce();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    if (err instanceof Error && err.name === "AbortError") return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export function ChatPage() {
  const params = useParams();
  const [_, setLocation] = useLocation();
  const rawId = params.id;
  const parsedId = rawId ? Number.parseInt(rawId, 10) : NaN;
  const invalidConversationId = rawId != null && !Number.isFinite(parsedId);
  const conversationId = Number.isFinite(parsedId) ? parsedId : null;
  const queryClient = useQueryClient();
  const models = useAvailableModels();
  const greeting = timeGreeting();
  const abortRef = useRef<AbortController | null>(null);
  const sendingToRef = useRef<number | null>(null);

  const [selectedModel, setSelectedModel] = useState("gpt-5.6-terra");
  const [modelRestoredForConv, setModelRestoredForConv] = useState<number | null>(null);
  const [streamingContent, setStreamingContent] = useState<string>("");
  const [streamingSources, setStreamingSources] = useState<{ title: string; url: string }[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<{ kind: string; query?: string } | null>(null);
  const [searchWarning, setSearchWarning] = useState<string | null>(null);
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
    setStreamingSources([]);
    setOptimisticUserMessage(null);
    setStreamError(null);
    setSearchStatus(null);
    setSearchWarning(null);
  }, [conversationId]);

  const { data: conversation, isLoading, isError: conversationLoadError } = useGetOpenaiConversation(
    conversationId as number,
    { query: { enabled: !!conversationId, queryKey: getGetOpenaiConversationQueryKey(conversationId as number) } }
  );

  // Restore the last used model when opening an existing conversation
  useEffect(() => {
    if (!conversation || modelRestoredForConv === conversation.id) return;
    const msgs = conversation.messages ?? [];
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant" && m.modelId);
    if (lastAssistant?.modelId && models.some((m) => m.id === lastAssistant.modelId)) {
      setSelectedModel(lastAssistant.modelId);
    }
    setModelRestoredForConv(conversation.id);
  }, [conversation, modelRestoredForConv, models]);

  const createConversation = useCreateOpenaiConversation();

  // 戻り値: false = 送信ブロック（入力・添付は保持される）
  const handleSend = async (content: string, fileData?: { name: string; content: string; isBase64: boolean }): Promise<boolean> => {
    let finalContent = content;

    if (fileData) {
      // 選択中モデルが画像非対応なら、送信前に分かりやすいエラーを表示する
      if (fileData.isBase64) {
        const model = models.find((m) => m.id === selectedModel);
        if (model && !model.supportsVision) {
          setStreamError(
            `${model.label} は画像を読み取れません。画像を送る場合は GPT や Qwen などの画像対応モデルを選択してください。`
          );
          return false;
        }
      }
      if (fileData.isBase64) {
        finalContent = `[Image: ${fileData.name}]\n\n${fileData.content}\n\n---\n\nUser question: ${content}`;
      } else {
        finalContent = `[File: ${fileData.name}]\n\n${fileData.content}\n\n---\n\nUser question: ${content}`;
      }
    }

    let targetId = conversationId;

    if (!targetId) {
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

    if (!targetId) return false;

    sendingToRef.current = targetId;
    setStreamError(null);
    setSearchWarning(null);
    setOptimisticUserMessage({
      id: OPTIMISTIC_USER_ID,
      conversationId: targetId,
      role: "user",
      content: finalContent,
      createdAt: new Date().toISOString(),
    });

    setIsStreaming(true);
    setStreamingContent("");
    setStreamingSources([]);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    await streamMessage(
      targetId,
      finalContent,
      selectedModel,
      (chunk) => {
        setStreamingContent((prev) => prev + chunk);
      },
      async () => {
        setSearchStatus(null);
        // サーバーの再取得が完了してからストリーミング表示をクリアする
        // （先にクリアすると一瞬消え、後に残すと保存済みメッセージと二重表示になる）
        await queryClient.invalidateQueries({ queryKey: getGetOpenaiConversationQueryKey(targetId!) });
        setIsStreaming(false);
        setStreamingContent("");
        setStreamingSources([]);
        setOptimisticUserMessage(null);
      },
      (err) => {
        setIsStreaming(false);
        setSearchStatus(null);
        setStreamingSources([]);
        setOptimisticUserMessage(null);
        setStreamError(err.message);
      },
      (status, query) => {
        setSearchStatus(status ? { kind: status, query } : null);
      },
      (message) => {
        setSearchWarning(message);
      },
      (sources) => {
        setStreamingSources(sources);
      },
      controller.signal,
    );
    return true;
  };

  // サーバー側に既に同じユーザーメッセージが保存済みなら楽観的表示を重複させない
  const serverMessages = conversation?.messages || [];
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
    ...((isStreaming || streamingContent) && !streamingAlreadyOnServer
      ? [{
          id: STREAMING_ASSISTANT_ID,
          conversationId: conversationId || 0,
          role: "assistant",
          content: streamingContent,
          sources: streamingSources.length > 0 ? streamingSources : null,
          createdAt: new Date().toISOString(),
        }]
      : []),
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden flex flex-col">
        {invalidConversationId || (conversationLoadError && !optimisticUserMessage && !isStreaming) ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <h2 className="text-xl font-serif font-medium mb-2">会話が見つかりません</h2>
            <p className="text-muted-foreground text-sm">URL が正しくないか、この会話にアクセスできません。左の履歴から選び直してください。</p>
          </div>
        ) : !conversationId && !optimisticUserMessage ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 max-w-2xl mx-auto w-full">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-6 shadow-inner border border-primary/20">
              <Sparkles className="w-8 h-8 text-primary" />
            </div>
            <h2 className="text-3xl font-serif font-medium mb-3 text-foreground tracking-tight">
              {greeting.title}
            </h2>
            <p className="text-muted-foreground mb-8 text-lg max-w-md font-sans font-light">
              {greeting.subtitle}
            </p>
          </div>
        ) : (
          <MessageFeed
            messages={allMessages}
            isLoading={isLoading && !isStreaming && allMessages.length === 0}
          />
        )}
      </div>

      {searchStatus && (
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

      <div className="p-4 md:p-6 bg-gradient-to-t from-background via-background to-transparent pt-10">
        <div className="max-w-3xl mx-auto space-y-2">
          <div className="flex items-center gap-2 px-1">
            <ModelSelector
              selectedModel={selectedModel}
              onSelect={setSelectedModel}
              disabled={isStreaming || createConversation.isPending}
            />
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
