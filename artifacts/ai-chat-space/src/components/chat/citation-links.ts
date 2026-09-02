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
