import { ExternalLink, Globe2 } from "lucide-react";
import { surfaceVariants } from "@/design-system/surface";
import { cn } from "@/lib/utils";

export interface Source {
  title: string;
  url: string;
  publishedAt?: string | null;
  fetchedAt?: string | null;
}

interface SourceCardsProps {
  sources: Source[];
}

function normalizeSourceUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function SourceCards({ sources }: SourceCardsProps) {
  const safeSources = sources.flatMap((source) => {
    const url = normalizeSourceUrl(source.url);
    return url ? [{ source, url }] : [];
  });
  if (safeSources.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      <p className="px-0.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        参照元
      </p>
      <div className="flex flex-wrap gap-2">
        {safeSources.map(({ source, url }, index) => {
          const domain = url.hostname.replace(/^www\./, "");
          return (
            <a
              key={`${url.href}-${index}`}
              id={`source-${index + 1}`}
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                surfaceVariants({ tone: "outlined", shape: "medium" }),
                "m3-focus-ring group flex min-w-0 max-w-[280px] items-center gap-2.5 px-3.5 py-3 text-left transition-[background-color,border-color,transform] duration-[var(--m3-duration-medium)] ease-[var(--m3-motion-standard)] hover:[background:var(--m3-surface-container-high)] hover:[border-color:var(--m3-outline)] active:scale-[0.985]",
              )}
            >
              {/* Deliberately use a local icon. Fetching favicons through a
                  third party would disclose every cited domain to that party. */}
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--m3-shape-full)] [background:var(--m3-primary-container)] [color:var(--m3-on-primary-container)]">
                <Globe2 className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 break-words text-[12px] font-medium leading-snug text-foreground">
                  <span className="mr-1 font-mono text-[10px] [color:var(--m3-primary)]">
                    [{index + 1}]
                  </span>
                  {(source.title || domain).slice(0, 180)}
                </div>
                <div className="mt-0.5 truncate text-[10px] leading-snug text-muted-foreground">
                  {domain}
                </div>
                <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground/80">
                  公開日:{" "}
                  {source.publishedAt ? formatDate(source.publishedAt) : "不明"}{" "}
                  ・ 取得: {formatDate(source.fetchedAt)}
                </div>
              </div>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-[color,transform] duration-[var(--m3-duration-short)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:[color:var(--m3-primary)]" />
            </a>
          );
        })}
      </div>
    </div>
  );
}

function formatDate(value?: string | null): string {
  if (!value) return "不明";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "不明"
    : date.toLocaleString("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
