/** Build a DOM id that is unique to one assistant-message source list. */
export function citationSourceId(
  citationScope: string,
  citationNumber: number,
): string {
  const safeScope =
    citationScope.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "message";
  return `source-${safeScope}-${citationNumber}`;
}

/**
 * Citation buttons and the source sheet are siblings in the message row, so a
 * small DOM event keeps them decoupled while allowing a citation click to open
 * the correct sheet before scrolling to its source.
 */
export const CITATION_SOURCE_OPEN_EVENT = "chat-space:open-citation-source";

export interface CitationSourceOpenDetail {
  targetId: string;
}

export function requestCitationSourceOpen(targetId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CitationSourceOpenDetail>(CITATION_SOURCE_OPEN_EVENT, {
      detail: { targetId },
    }),
  );
}
