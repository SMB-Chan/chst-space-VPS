import { useRef, useEffect } from "react";
import { OpenaiMessage } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { Loader2, Paperclip, Bot } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface MessageFeedProps {
  messages: OpenaiMessage[];
  isLoading: boolean;
}

export function MessageFeed({ messages, isLoading }: MessageFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary/50" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-8 pb-32">
      <div className="max-w-3xl mx-auto space-y-12">
        {messages.map((message) => {
          const isUser = message.role === "user";
          
          // Parse file attachment if present
          let displayContent = message.content;
          let attachedFile = null;
          
          const fileMatch = displayContent.match(/^\[(File|Image):\s([^\]]+)\]\n\n(.*?)\n\n---\n\nUser question:\s(.*)$/s);
          if (fileMatch) {
            attachedFile = {
              type: fileMatch[1],
              name: fileMatch[2],
            };
            displayContent = fileMatch[4]; // just show the question
          }
          
          return (
            <div 
              key={message.id} 
              className={cn(
                "flex gap-4 md:gap-6 group",
                isUser ? "flex-row-reverse" : "flex-row"
              )}
            >
              <div className="flex-shrink-0 mt-1">
                {isUser ? (
                  <Avatar className="w-8 h-8 md:w-10 md:h-10 border border-primary/20 bg-primary/10 text-primary">
                    <AvatarFallback className="bg-transparent font-medium">U</AvatarFallback>
                  </Avatar>
                ) : (
                  <Avatar className="w-8 h-8 md:w-10 md:h-10 border border-border bg-card">
                    <AvatarFallback className="bg-transparent text-muted-foreground"><Bot className="w-5 h-5" /></AvatarFallback>
                  </Avatar>
                )}
              </div>
              
              <div className={cn(
                "flex flex-col gap-2 max-w-[85%] md:max-w-[75%]",
                isUser ? "items-end" : "items-start"
              )}>
                {attachedFile && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card border border-border text-sm text-muted-foreground shadow-sm">
                    <Paperclip className="w-4 h-4 text-primary" />
                    <span className="font-medium text-foreground truncate max-w-[200px]">{attachedFile.name}</span>
                  </div>
                )}
                
                <div className={cn(
                  "px-5 py-4 rounded-2xl text-[15px] leading-relaxed shadow-sm",
                  isUser 
                    ? "bg-primary text-primary-foreground font-sans font-normal" 
                    : "bg-card border border-border font-serif text-foreground prose-p:leading-loose"
                )}>
                  {isUser ? (
                    <div className="whitespace-pre-wrap">{displayContent}</div>
                  ) : (
                    <Markdown content={displayContent} />
                  )}
                </div>
                {!isUser && message.modelId && (
                  <div className="text-[11px] text-muted-foreground/60 px-1 select-none">
                    {message.modelId}
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
