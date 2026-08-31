import { useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { cn } from "@/lib/utils";

interface MarkdownProps {
  content: string;
  className?: string;
}

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className"]],
    span: [...(defaultSchema.attributes?.span ?? []), ["className"]],
  },
};

function safeHttpHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const base =
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost";
    const url = new URL(raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function CodeBlock({
  language,
  children,
}: {
  language?: string;
  children: string;
}) {
  return (
    <div className="rounded-xl overflow-hidden bg-background border border-border shadow-sm my-4 font-sans">
      {language ? (
        <div className="bg-muted px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border uppercase tracking-wider">
          {language}
        </div>
      ) : null}
      <pre className="p-4 overflow-x-auto text-sm font-mono text-foreground/90 bg-black/40">
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function Markdown({ content, className }: MarkdownProps) {
  const remarkPlugins = useMemo(() => [remarkGfm], []);
  const rehypePlugins = useMemo(
    () => [[rehypeSanitize, sanitizeSchema]] as const,
    [],
  );

  return (
    <div
      className={cn(
        "max-w-none space-y-3 text-foreground/90 [&_p]:leading-relaxed [&_li]:leading-relaxed",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins as never}
        components={{
          a: ({ href, children }) => {
            const safeHref = safeHttpHref(href);
            if (!safeHref) return <span>{children}</span>;
            return (
              <a
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
              >
                {children}
              </a>
            );
          },
          // Do not automatically request model-generated remote image URLs.
          // A malicious web page quoted by the model could otherwise turn a
          // Markdown image into a tracking/exfiltration request from the user's
          // browser. Render an explicit link instead so navigation is opt-in.
          img: ({ src, alt }) => {
            const safeHref = safeHttpHref(src);
            const label = alt?.trim() || "外部画像";
            if (!safeHref)
              return <span className="text-muted-foreground">[{label}]</span>;
            return (
              <a
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                className="text-primary underline underline-offset-2 break-all"
              >
                [{label}を開く]
              </a>
            );
          },
          h1: ({ children }) => (
            <h2 className="text-2xl font-serif font-semibold mt-8 mb-3 text-primary">
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h3 className="text-xl font-serif font-medium mt-6 mb-2 text-primary">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4 className="text-lg font-serif font-medium mt-5 mb-2 text-primary">
              {children}
            </h4>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-outside ml-6 space-y-1 marker:text-primary/50">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-outside ml-6 space-y-1 marker:text-primary/50">
              {children}
            </ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-primary/40 pl-4 text-muted-foreground italic">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="w-full text-sm border-collapse border border-border">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-muted/50 px-3 py-1.5 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-3 py-1.5 align-top">
              {children}
            </td>
          ),
          hr: () => <hr className="border-border my-4" />,
          code: ({ className: codeClass, children }) => {
            const text = String(children).replace(/\n$/, "");
            const lang = /language-([\w-]+)/.exec(codeClass ?? "")?.[1];
            const isBlock = Boolean(codeClass) || text.includes("\n");
            if (isBlock) return <CodeBlock language={lang}>{text}</CodeBlock>;
            return (
              <code className="px-1.5 py-0.5 rounded-md bg-muted/50 text-primary font-mono text-[0.85em] border border-border/50">
                {text}
              </code>
            );
          },
          pre: ({ children }) => <>{children as ReactNode}</>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
