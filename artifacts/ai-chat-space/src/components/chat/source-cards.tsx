import { ExternalLink } from "lucide-react";

export interface Source {
  title: string;
  url: string;
}

interface SourceCardsProps {
  sources: Source[];
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getFaviconUrl(url: string): string {
  try {
    const { origin } = new URL(url);
    return `https://www.google.com/s2/favicons?sz=32&domain=${origin}`;
  } catch {
    return "";
  }
}

export function SourceCards({ sources }: SourceCardsProps) {
  if (sources.length === 0) return null;

  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider px-0.5">
        参照元
      </p>
      <div className="flex flex-wrap gap-2">
        {sources.map((source, i) => {
          const domain = getDomain(source.url);
          const favicon = getFaviconUrl(source.url);
          return (
            <a
              key={i}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2 px-3 py-2 rounded-xl bg-background border border-border hover:border-primary/40 hover:bg-primary/5 transition-all duration-150 text-left shadow-sm max-w-[260px] min-w-0"
            >
              {favicon && (
                <img
                  src={favicon}
                  alt=""
                  width={14}
                  height={14}
                  className="rounded-sm shrink-0 opacity-80"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-foreground truncate leading-snug">
                  {source.title || domain}
                </div>
                <div className="text-[10px] text-muted-foreground/70 truncate leading-snug">
                  {domain}
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
