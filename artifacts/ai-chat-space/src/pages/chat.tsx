import { useState, useEffect } from "react";
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
import { ModelSelector } from "@/components/chat/model-selector";
import { Sparkles } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function streamMessage(
  conversationId: number,
  content: string,
  model: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onStatus: (status: string | null, query?: string) => void,
  onSearchWarning: (message: string) => void
) {
  try {
    const res = await fetch(
      `${BASE}/api/openai/conversations/${conversationId}/messages?model=${encodeURIComponent(model)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }
    );

    if (!res.ok) {
      throw new Error(`Failed to send message: ${res.statusText}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.status === "searching") onStatus("searching", parsed.query);
            if (parsed.status === "fetching") onStatus("fetching");
            if (parsed.status === "search_warning" && parsed.message) {
              onSearchWarning(parsed.message);
            }
            if (parsed.content) {
              onStatus(null);
              onChunk(parsed.content);
            }
            if (parsed.error) onError(new Error(parsed.error));
            if (parsed.done) onDone();
          } catch {}
        }
      }
    }
    onDone();
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export function ChatPage() {
  const params = useParams();
  const [_, setLocation] = useLocation();
  const conversationId = params.id ? parseInt(params.id) : null;
  const queryClient = useQueryClient();

  const [selectedModel, setSelectedModel] = useState("gpt-5.6-terra");
  const [modelRestoredForConv, setModelRestoredForConv] = useState<number | null>(null);

  const { data: conversation, isLoading } = useGetOpenaiConversation(
    conversationId as number,
    { query: { enabled: !!conversationId, queryKey: getGetOpenaiConversationQueryKey(conversationId as number) } }
  );

  // Restore the last used model when opening an existing conversation
  useEffect(() => {
    if (!conversation || modelRestoredForConv === conversation.id) return;
    const msgs = conversation.messages ?? [];
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant" && m.modelId);
    if (lastAssistant?.modelId) {
      setSelectedModel(lastAssistant.modelId);
    }
    setModelRestoredForConv(conversation.id);
  }, [conversation, modelRestoredForConv]);

  const createConversation = useCreateOpenaiConversation();

  const [streamingContent, setStreamingContent] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<{ kind: string; query?: string } | null>(null);
  const [searchWarning, setSearchWarning] = useState<string | null>(null);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<OpenaiMessage | null>(null);

  const handleSend = async (content: string, fileData?: { name: string; content: string; isBase64: boolean }) => {
    let finalContent = content;

    if (fileData) {
      if (fileData.isBase64) {
        finalContent = `[Image: ${fileData.name}]\n\n${fileData.content}\n\n---\n\nUser question: ${content}`;
      } else {
        finalContent = `[File: ${fileData.name}]\n\n${fileData.content}\n\n---\n\nUser question: ${content}`;
      }
    }

    let targetId = conversationId;

    if (!targetId) {
      const title = content.split(" ").slice(0, 4).join(" ") + (content.split(" ").length > 4 ? "..." : "");
      try {
        const newConv = await createConversation.mutateAsync({ data: { title: title || "New Conversation" } });
        targetId = newConv.id;
        queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
        setLocation(`/conversations/${newConv.id}`, { replace: true });
      } catch {
        return;
      }
    }

    if (!targetId) return;

    setStreamError(null);
    setSearchWarning(null);
    setOptimisticUserMessage({
      id: Date.now(),
      conversationId: targetId,
      role: "user",
      content: finalContent,
      createdAt: new Date().toISOString(),
    });

    setIsStreaming(true);
    setStreamingContent("");

    streamMessage(
      targetId,
      finalContent,
      selectedModel,
      (chunk) => {
        setStreamingContent((prev) => prev + chunk);
      },
      () => {
        setIsStreaming(false);
        setSearchStatus(null);
        setOptimisticUserMessage(null);
        queryClient.invalidateQueries({ queryKey: getGetOpenaiConversationQueryKey(targetId!) });
      },
      (err) => {
        setIsStreaming(false);
        setSearchStatus(null);
        setOptimisticUserMessage(null);
        setStreamError(err.message);
      },
      (status, query) => {
        setSearchStatus(status ? { kind: status, query } : null);
      },
      (message) => {
        setSearchWarning(message);
      }
    );
  };

  const allMessages = [
    ...(conversation?.messages || []),
    ...(optimisticUserMessage ? [optimisticUserMessage] : []),
    ...(isStreaming || streamingContent
      ? [{
          id: Date.now() + 1,
          conversationId: conversationId || 0,
          role: "assistant",
          content: streamingContent,
          createdAt: new Date().toISOString(),
        }]
      : []),
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden flex flex-col">
        {!conversationId && !optimisticUserMessage ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 max-w-2xl mx-auto w-full">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-6 shadow-inner border border-primary/20">
              <Sparkles className="w-8 h-8 text-primary" />
            </div>
            <h2 className="text-3xl font-serif font-medium mb-3 text-foreground tracking-tight">
              Good evening.
            </h2>
            <p className="text-muted-foreground mb-8 text-lg max-w-md font-sans font-light">
              What are we working on tonight? Attach a document or just start typing.
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
          <div className="px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
            エラー: {streamError}
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
