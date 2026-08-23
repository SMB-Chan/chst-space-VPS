export type ClientPatchOperation = { start: number; end: number; replacement: string };

export function applyClientPatch(draft: string, operations: unknown): string | null {
  if (!Array.isArray(operations) || operations.length > 8) return null;
  const ops = operations.filter((op): op is ClientPatchOperation => {
    if (!op || typeof op !== "object") return false;
    const item = op as Record<string, unknown>;
    const start = item.start;
    const end = item.end;
    const replacement = item.replacement;
    return typeof start === "number" && Number.isInteger(start) &&
      typeof end === "number" && Number.isInteger(end) &&
      typeof replacement === "string" && start >= 0 &&
      end >= start && end <= draft.length &&
      replacement.length <= 4000;
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  if (ops.length !== operations.length) return null;
  for (let i = 1; i < ops.length; i += 1) {
    if (ops[i - 1].end > ops[i].start) return null;
  }
  let result = draft;
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    result = result.slice(0, op.start) + op.replacement + result.slice(op.end);
  }
  return result;
}