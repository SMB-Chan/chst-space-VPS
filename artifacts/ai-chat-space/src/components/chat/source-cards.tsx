import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  CITATION_SOURCE_OPEN_EVENT,
  citationSourceId,
  type CitationSourceOpenDetail,
} from "./citation-links";

export interface Source {
  title: string;
  url: string;
  snippet?: string | null;
  publishedAt?: string | null;
  fetchedAt?: string | null;
  publisherName?: string | null;
  publisherUrl?: string | null;
}

interface SourceCardsProps {
  sources: Source[];
  citationScope: string;
}

interface SafeSource {
  source: Source;
  url: URL;
  domain: string;
  citationNumbers: number[];
  citationIds: string[];
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

function sourceBadgeLabel(domain: string): string {
  const parts = domain
    .replace(/^www\./, "")
    .split(".")
    .filter(Boolean)
    .filter(
      (part, index) =>
        index > 0 ||
        !["www", "web", "news", "m", "mobile", "amp"].includes(part),
    );
  const candidate = (parts[0] || domain).replace(/[^a-z0-9]/gi, "");
  if (!candidate) return "•";
  if (/^\d/.test(candidate)) return candidate.slice(0, 2).toUpperCase();
  if (candidate.length <= 3) return candidate.toUpperCase();
  return candidate.slice(0, 1).toUpperCase();
}

function normalizeSnippet(value?: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.slice(0, 320);
}

function buildSafeSources(
  sources: Source[],
  citationScope: string,
): SafeSource[] {
  const byUrl = new Map<string, SafeSource>();

  sources.forEach((source, index) => {
    const url = normalizeSourceUrl(source.url);
    if (!url) return;
    const citationNumber = index + 1;
    const citationId = citationSourceId(citationScope, citationNumber);
    const key = url.href;
    const existing = byUrl.get(key);
    if (existing) {
      existing.citationNumbers.push(citationNumber);
      existing.citationIds.push(citationId);
      if (!existing.source.snippet && source.snippet) existing.source = source;
      return;
    }
    byUrl.set(key, {
      source,
      url,
      domain: url.hostname.replace(/^www\./, ""),
      citationNumbers: [citationNumber],
      citationIds: [citationId],
    });
  });

  return [...byUrl.values()];
}

function useDesktopSourceSheet(): boolean {
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => setDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return desktop;
}

export function SourceCards({ sources, citationScope }: SourceCardsProps) {
  const safeSources = useMemo(
    () => buildSafeSources(sources, citationScope),
    [citationScope, sources],
  );
  const allCitationIds = useMemo(
    () => new Set(safeSources.flatMap((source) => source.citationIds)),
    [safeSources],
  );
  const isDesktop = useDesktopSourceSheet();
  const [open, setOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [highlightedTarget, setHighlightedTarget] = useState<string | null>(
    null,
  );
  const highlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const onCitationOpen = (event: Event) => {
      const detail = (event as CustomEvent<CitationSourceOpenDetail>).detail;
      if (!detail?.targetId || !allCitationIds.has(detail.targetId)) return;
      setPendingTarget(detail.targetId);
      setHighlightedTarget(detail.targetId);
      setOpen(true);
    };
    window.addEventListener(CITATION_SOURCE_OPEN_EVENT, onCitationOpen);
    return () =>
      window.removeEventListener(CITATION_SOURCE_OPEN_EVENT, onCitationOpen);
  }, [allCitationIds]);

  useEffect(() => {
    if (!open || !pendingTarget) return;
    const timer = window.setTimeout(() => {
      document.getElementById(pendingTarget)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      setPendingTarget(null);
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedTarget(null);
        highlightTimerRef.current = null;
      }, 1800);
    }, 90);
    return () => window.clearTimeout(timer);
  }, [open, pendingTarget]);

  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    },
    [],
  );

  if (safeSources.length === 0) return null;

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setPendingTarget(null);
          setHighlightedTarget(null);
        }
      }}
    >
      <SheetTrigger asChild>
        <button
          type="button"
          className="m3-focus-ring inline-flex min-h-9 max-w-full items-center gap-2 rounded-[var(--m3-shape-full)] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-low)] px-2.5 py-1.5 text-xs font-medium text-foreground shadow-[var(--m3-elevation-0)] transition-[background-color,border-color,transform] duration-[var(--m3-duration-short)] hover:border-[var(--m3-outline)] hover:bg-[var(--m3-surface-container-high)] active:scale-[0.985]"
          aria-label={`出典を開く（${safeSources.length}件）`}
        >
          <span className="flex -space-x-1.5" aria-hidden="true">
            {safeSources.slice(0, 3).map(({ domain }) => (
              <span
                key={domain}
                className="flex h-6 w-6 items-center justify-center rounded-[var(--m3-shape-full)] border-2 border-background bg-[var(--m3-primary-container)] text-[9px] font-bold [color:var(--m3-on-primary-container)]"
              >
                {sourceBadgeLabel(domain)}
              </span>
            ))}
          </span>
          <span>Sources</span>
          <span className="rounded-[var(--m3-shape-full)] bg-foreground/[0.07] px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {safeSources.length}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </SheetTrigger>

      <SheetContent
        side={isDesktop ? "right" : "bottom"}
        className={cn(
          "gap-0 overflow-hidden border-[var(--m3-outline-variant)] bg-[var(--m3-surface)] p-0",
          isDesktop
            ? "h-full w-[min(92vw,440px)] max-w-[440px]"
            : "h-[88dvh] max-h-[760px] w-full rounded-t-[var(--m3-shape-xl)] border-x border-t",
        )}
      >
        <div className="flex h-full min-h-0 flex-col">
          {!isDesktop ? (
            <div
              className="flex shrink-0 justify-center pt-2.5"
              aria-hidden="true"
            >
              <span className="h-1 w-10 rounded-[var(--m3-shape-full)] bg-muted-foreground/30" />
            </div>
          ) : null}
          <SheetHeader className="shrink-0 border-b border-[var(--m3-outline-variant)] px-5 pb-4 pt-4 pr-14 text-left">
            <div className="flex items-center gap-2">
              <SheetTitle>Sources</SheetTitle>
              <span className="rounded-[var(--m3-shape-full)] bg-[var(--m3-primary-container)] px-2 py-0.5 text-xs font-medium [color:var(--m3-on-primary-container)]">
                {safeSources.length}
              </span>
            </div>
            <SheetDescription className="text-xs">
              この回答で参照した情報源。引用番号から該当項目へ移動できます。
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
            <div className="space-y-2.5 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {safeSources.map(
                ({ source, url, domain, citationNumbers, citationIds }) => {
                  const highlighted =
                    highlightedTarget !== null &&
                    citationIds.includes(highlightedTarget);
                  const snippet = normalizeSnippet(source.snippet);
                  const publisherUrl = source.publisherUrl
                    ? normalizeSourceUrl(source.publisherUrl)
                    : null;
                  return (
                    <article
                      key={url.href}
                      id={citationIds[0]}
                      className={cn(
                        "relative rounded-[var(--m3-shape-lg)] border border-[var(--m3-outline-variant)] bg-[var(--m3-surface-container-low)] p-3.5 transition-[background-color,border-color,box-shadow] duration-[var(--m3-duration-medium)]",
                        highlighted &&
                          "border-[var(--m3-primary)] bg-[var(--m3-primary-container)]/35 shadow-[var(--m3-elevation-2)]",
                      )}
                    >
                      {citationIds.slice(1).map((id) => (
                        <span
                          key={id}
                          id={id}
                          className="block h-0 scroll-mt-24"
                          aria-hidden="true"
                        />
                      ))}
                      <div className="flex items-start gap-3">
                        <span
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--m3-shape-full)] bg-[var(--m3-primary-container)] text-[10px] font-bold [color:var(--m3-on-primary-container)]"
                          aria-hidden="true"
                        >
                          {sourceBadgeLabel(domain)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="truncate font-medium">
                              {source.publisherName || domain}
                            </span>
                            <span className="ml-auto shrink-0 font-mono text-[10px] [color:var(--m3-primary)]">
                              [{citationNumbers.join(", ")}]
                            </span>
                          </div>
                          <a
                            href={url.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                            className="m3-focus-ring mt-1 inline-flex max-w-full items-start gap-1.5 rounded-[var(--m3-shape-xs)] text-left text-sm font-semibold leading-snug text-foreground underline decoration-foreground/25 underline-offset-2 transition-colors hover:[color:var(--m3-primary)]"
                          >
                            <span className="line-clamp-2 break-words">
                              {(source.title || domain).slice(0, 220)}
                            </span>
                            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          </a>
                          {snippet ? (
                            <p className="mt-1.5 line-clamp-3 text-[12px] leading-relaxed text-muted-foreground">
                              {snippet}
                            </p>
                          ) : null}
                          {publisherUrl ? (
                            <a
                              href={publisherUrl.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              referrerPolicy="no-referrer"
                              className="m3-focus-ring mt-1 inline-flex max-w-full text-[11px] text-muted-foreground underline decoration-muted-foreground/30 underline-offset-2 hover:[color:var(--m3-primary)]"
                            >
                              媒体サイト: {publisherUrl.hostname}
                            </a>
                          ) : null}
                          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/80">
                            <span>
                              公開日: {formatPublishedDate(source.publishedAt)}
                            </span>
                            {source.fetchedAt ? (
                              <span
                                title={`取得日時: ${formatDateTime(source.fetchedAt)}`}
                                className="rounded-[var(--m3-shape-full)] bg-foreground/[0.05] px-1.5 py-0.5"
                              >
                                取得済み
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                },
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function formatPublishedDate(value?: string | null): string {
  if (!value) return "不明";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "不明"
    : date.toLocaleDateString("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
}

function formatDateTime(value?: string | null): string {
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
