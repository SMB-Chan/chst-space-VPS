import { useRef, useEffect, useState } from "react";
import { OpenaiMessage } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { SourceCards } from "./source-cards";
import { Loader2, Paperclip, Bot, Brain, ChevronDown } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useUser } from "@clerk/react";
import { getModelLabel } from "./model-selector";
import { STREAMING_ASSISTANT_ID } from "@/lib/chat";

export type StreamingPhase =
  | "starting"
  | "searching"
  | "thinking"
  | "generating"
  | "auditing"
  | "revising"
  | null;

type DisplayMessage = OpenaiMessage & {
  auditContent?: string | null;
  auditModelId?: string | null;
};

type AttachmentChip = { kind: "image" | "file"; name: string };

const ATTACHMENTS_V1_PREFIX = "CS_ATTACHMENTS_V1:";

function parseUserDisplay(content: string): { displayContent: string; attachments: AttachmentChip[] } {
  if (content.startsWith(ATTACHMENTS_V1_PREFIX)) {
    try {
      const parsed = JSON.parse(content.slice(ATTACHMENTS_V1_PREFIX.length)) as {
        question?: unknown;
        attachments?: unknown;
      };
      const displayContent = typeof parsed.question === "string" ? parsed.question : "";
      const raw = Array.isArray(parsed.attachments) ? parsed.attachments : [];
      const attachments = raw.flatMap((item): AttachmentChip[] => {
        if (!item || typeof item !== "object") return [];
        const rec = item as { kind?: unknown; type?: unknown; name?: unknown; isBase64?: unknown };
        if (typeof rec.name !== "string") return [];
        const isImage = rec.kind === "image" || rec.type === "image" || rec.isBase64 === true;
        return [{ kind: isImage ? "image" : "file", name: rec.name }];
      });
      return { displayContent, attachments };
    } catch {
      return { displayContent: content, attachments: [] };
    }
  }

  // Legacy single-attachment format
  const fileMatch = content.match(/^\[(File|Image):\s([^\]]+)\]\n\n(.*?)\n\n---\n\nUser question:\s(.*)$/s);
  if (fileMatch) {
    return {
      displayContent: fileMatch[4],
      attachments: [{ kind: fileMatch[1] === "Image" ? "image" : "file", name: fileMatch[2] }],
    };
  }
  return { displayContent: content, attachments: [] };
}

interface MessageFeedProps {
  messages: OpenaiMessage[];
  isLoading: boolean;
  streamingPhase?: StreamingPhase;
  streamingReasoning?: string;
  streamingAudit?: string;
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

function ReasoningPanel({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    // ライブ中は開き、終わったら畳んで本文を優先する（モバイルで推論が画面を占有しないように）
    setOpen(live);
  }, [live]);
  if (!text && !live) return null;
  return (
    <div className="w-full rounded-xl border border-violet-500/20 bg-violet-500/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-violet-300/90 hover:bg-violet-500/10"
      >
        <Brain className={cn("w-3.5 h-3.5", live && "animate-pulse")} />
        <span className="font-medium">{live ? "推論中" : "推論過程"}</span>
        {live && <PhaseDots />}
        <ChevronDown className={cn("w-3.5 h-3.5 ml-auto transition-transform", open && "rotate-180")} />
      </button>
      {open && text && (
        <div className="px-3 pb-3 text-[12px] leading-relaxed text-muted-foreground/90 whitespace-pre-wrap max-h-40 md:max-h-48 overflow-y-auto font-sans break-words [overflow-wrap:anywhere]">
          {text}
        </div>
      )}
    </div>
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
  useEffect(() => {
    setOpen(!!live);
  }, [live]);
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
          <Markdown content={content} />
        </div>
      ) : null}
    </div>
  );
}

function GenerationBadge({ phase }: { phase: StreamingPhase }) {
  if (!phase || phase === "searching") return null;
  const label =
    phase === "thinking"
      ? "推論中"
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
  streamingReasoning = "",
  streamingAudit = "",
}: MessageFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
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
        stickToBottomRef.current = distance < 96;
      }}
      className="flex-1 overflow-y-auto p-4 md:p-8 space-y-8 pb-[calc(8rem+env(safe-area-inset-bottom))]"
    >
      <div className="max-w-3xl mx-auto space-y-12">
        {messages.map((message) => {
          const display = message as DisplayMessage;
          const isUser = message.role === "user";
          const parsedUser = isUser ? parseUserDisplay(message.content) : null;
          let displayContent = parsedUser?.displayContent ?? message.content;
          const attachments = parsedUser?.attachments ?? [];

          // For assistant messages: prefer DB-persisted sources; fall back to parsing
          // the legacy inline "参照元:" Markdown block so old messages still show cards.
          let sources: { title: string; url: string }[] | null = message.sources ?? null;
          if (!isUser) {
            if (!sources || sources.length === 0) {
              // Try to extract legacy sources from the inline block
              const legacyMatch = displayContent.match(
                /\n\n参照元:\n((?:- \[.*?\]\(.*?\)\n?)+)$/s
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
                "flex flex-col gap-2 min-w-0 max-w-[88%] md:max-w-[75%]",
                isUser ? "items-end" : "items-start"
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
                
                {!isUser && message.id === STREAMING_ASSISTANT_ID && (
                  <ReasoningPanel
                    text={streamingReasoning}
                    live={streamingPhase === "thinking"}
                  />
                )}

                {(!isUser && message.id === STREAMING_ASSISTANT_ID && !displayContent) ? (
                  streamingReasoning || streamingPhase === "thinking" ? null : (
                    <div className="px-5 py-4 rounded-2xl bg-card border border-border shadow-sm">
                      <GenerationBadge phase={streamingPhase} />
                    </div>
                  )
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
                        <Markdown content={displayContent} />
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

                {!isUser && sources && sources.length > 0 && (
                  <div className="w-full px-1">
                    <SourceCards sources={sources} />
                  </div>
                )}

                {!isUser && (display.auditContent || (message.id === STREAMING_ASSISTANT_ID && (streamingAudit || streamingPhase === "auditing"))) && (
                  <AuditCard
                    content={message.id === STREAMING_ASSISTANT_ID ? streamingAudit || display.auditContent || "" : display.auditContent || ""}
                    modelId={display.auditModelId}
                    live={message.id === STREAMING_ASSISTANT_ID && streamingPhase === "auditing"}
                  />
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
