import { ExternalLink, Globe2 } from "lucide-react";

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
    <div className="mt-3 space-y-1.5">
      <p className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider px-0.5">
        参照元
      </p>
      <div className="flex flex-wrap gap-2">
        {safeSources.map(({ source, url }, i) => {
          const domain = url.hostname.replace(/^www\./, "");
          return (
            <a
              key={`${url.href}-${i}`}
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2 px-3 py-2 rounded-xl bg-background border border-border hover:border-primary/40 hover:bg-primary/5 transition-all duration-150 text-left shadow-sm max-w-[260px] min-w-0"
            >
              {/* Deliberately use a local icon. Fetching favicons through a
                  third party would disclose every cited domain to that party. */}
              <Globe2
                className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-foreground leading-snug line-clamp-2 break-words">
                  {(source.title || domain).slice(0, 180)}
                </div>
                <div className="text-[10px] text-muted-foreground/70 truncate leading-snug">
                  {domain}
                </div>
                <div className="text-[10px] text-muted-foreground/60 leading-snug">
                  公開日:{" "}
                  {source.publishedAt ? formatDate(source.publishedAt) : "不明"}{" "}
                  ・ 取得: {formatDate(source.fetchedAt)}
                </div>
              </div>
              <ExternalLink className="w-3 h-3 shrink-0 text-muted-foreground/40 group-hover:text-primary/60 transition-colors" />
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
