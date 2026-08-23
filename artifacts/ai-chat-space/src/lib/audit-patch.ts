export type ClientPatchOperation = { find: string; replacement: string };

export function applyClientPatch(draft: string, operations: unknown): string | null {
  if (!Array.isArray(operations) || operations.length > 8) return null;
  const ops = operations.filter((op): op is ClientPatchOperation => {
    if (!op || typeof op !== "object") return false;
    const item = op as Record<string, unknown>;
    const find = item.find;
    const replacement = item.replacement;
    if (typeof find !== "string" || find.length === 0 || find.length > 4000 ||
      typeof replacement !== "string" || replacement.length > 4000 ||
      find.length + replacement.length > 8000) return false;
    const first = draft.indexOf(find);
    return first >= 0 && draft.indexOf(find, first + 1) < 0;
  });
  if (ops.length !== operations.length) return null;
  const located = ops
    .map((op) => ({ ...op, start: draft.indexOf(op.find), end: draft.indexOf(op.find) + op.find.length }))
    .sort((a, b) => a.start - b.start);
  let totalReplacementChars = 0;
  for (let i = 0; i < located.length; i += 1) {
    totalReplacementChars += located[i].replacement.length;
    if (i > 0 && located[i - 1].end > located[i].start) return null;
  }
  if (totalReplacementChars > 12000) {
    return null;
  }
  let result = draft;
  for (let i = located.length - 1; i >= 0; i -= 1) {
    const op = located[i];
    result = result.slice(0, op.start) + op.replacement + result.slice(op.end);
  }
  if (result.length > 20000) return null;
  return result;
}