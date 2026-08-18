import { useMemo } from 'react';
import { cn } from '@/lib/utils';

interface MarkdownProps {
  content: string;
  className?: string;
}

export function Markdown({ content, className }: MarkdownProps) {
  const parsedBlocks = useMemo(() => {
    // A simple parser that extracts code blocks and text paragraphs
    const blocks: Array<{ type: 'code' | 'text'; content: string; lang?: string }> = [];
    
    // Regex for code blocks: ```lang\ncode\n```
    const codeBlockRegex = /```([\w-]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        blocks.push({
          type: 'text',
          content: content.slice(lastIndex, match.index),
        });
      }
      
      // Add code block
      blocks.push({
        type: 'code',
        lang: match[1],
        content: match[2],
      });
      
      lastIndex = match.index + match[0].length;
    }
    
    // Add remaining text
    if (lastIndex < content.length) {
      blocks.push({
        type: 'text',
        content: content.slice(lastIndex),
      });
    }

    return blocks;
  }, [content]);

  // Simple inline markdown (bold, italic, inline code)
  const renderInline = (text: string) => {
    // Escape HTML first? The challenge didn't specify strict XSS, but it's good practice.
    // For simplicity, we just split by regex and render spans.
    
    const parts = text.split(/(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*.*?\*\*|\*.*?\*|`.*?`)/g);
    
    return parts.map((part, i) => {
      const linkMatch = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (linkMatch) {
        return (
          <a
            key={i}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
          >
            {linkMatch[1]}
          </a>
        );
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('*') && part.endsWith('*')) {
        return <em key={i} className="italic text-foreground/90">{part.slice(1, -1)}</em>;
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={i} className="px-1.5 py-0.5 rounded-md bg-muted/50 text-primary font-mono text-[0.85em] border border-border/50">
            {part.slice(1, -1)}
          </code>
        );
      }
      // Process newlines inside text
      const lines = part.split('\n');
      return (
        <span key={i}>
          {lines.map((line, j) => (
            <span key={j}>
              {line}
              {j < lines.length - 1 && <br />}
            </span>
          ))}
        </span>
      );
    });
  };

  return (
    <div className={cn("space-y-4", className)}>
      {parsedBlocks.map((block, i) => {
        if (block.type === 'code') {
          return (
            <div key={i} className="rounded-xl overflow-hidden bg-background border border-border shadow-sm my-4 font-sans">
              {block.lang && (
                <div className="bg-muted px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border uppercase tracking-wider">
                  {block.lang}
                </div>
              )}
              <pre className="p-4 overflow-x-auto text-sm font-mono text-foreground/90 bg-black/40">
                <code>{block.content}</code>
              </pre>
            </div>
          );
        }

        // Text block
        // Split by double newline for paragraphs
        const paragraphs = block.content.split(/\n\s*\n/);
        return (
          <div key={i} className="space-y-4">
            {paragraphs.map((para, j) => {
              const trimmed = para.trim();
              if (!trimmed) return null;
              
              // Basic list item detection
              if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
                const listItems = trimmed.split('\n');
                return (
                  <ul key={j} className="list-disc list-outside ml-6 space-y-1 my-2 marker:text-primary/50">
                    {listItems.map((item, k) => {
                      const itemText = item.replace(/^[-*]\s|^\d+\.\s/, '');
                      return <li key={k} className="pl-1">{renderInline(itemText)}</li>;
                    })}
                  </ul>
                );
              }

              // Headers
              if (trimmed.startsWith('### ')) {
                return <h4 key={j} className="text-lg font-serif font-medium mt-6 mb-2 text-primary">{renderInline(trimmed.slice(4))}</h4>;
              }
              if (trimmed.startsWith('## ')) {
                return <h3 key={j} className="text-xl font-serif font-medium mt-8 mb-3 text-primary">{renderInline(trimmed.slice(3))}</h3>;
              }
              if (trimmed.startsWith('# ')) {
                return <h2 key={j} className="text-2xl font-serif font-semibold mt-10 mb-4 text-primary">{renderInline(trimmed.slice(2))}</h2>;
              }

              // Normal paragraph
              return <p key={j} className="leading-relaxed text-foreground/90">{renderInline(trimmed)}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
}
