export type ClientPatchOperation = { find: string; replacement: string };

const MAX_OPERATIONS = 4;
const MAX_FIND_CHARS = 1000;
const MAX_REPLACEMENT_CHARS = 2000;
const MAX_TOTAL_REPLACEMENT_CHARS = 4000;
const MAX_FINAL_CHARS = 20_000;

export function applyClientPatch(
  draft: string,
  operations: unknown,
): string | null {
  if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS)
    return null;

  const located: Array<ClientPatchOperation & { start: number; end: number }> =
    [];
  let totalReplacementChars = 0;
  for (const raw of operations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const find = item.find;
    const replacement = item.replacement;
    if (
      typeof find !== "string" ||
      typeof replacement !== "string" ||
      find.length === 0 ||
      find.length > MAX_FIND_CHARS ||
      replacement.length > MAX_REPLACEMENT_CHARS
    )
      return null;

    const start = draft.indexOf(find);
    if (start < 0 || draft.indexOf(find, start + 1) >= 0) return null;
    totalReplacementChars += replacement.length;
    if (totalReplacementChars > MAX_TOTAL_REPLACEMENT_CHARS) return null;
    located.push({ find, replacement, start, end: start + find.length });
  }

  located.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < located.length; index += 1) {
    if (located[index - 1].end > located[index].start) return null;
  }
  const finalLength =
    draft.length +
    located.reduce(
      (length, operation) =>
        length + operation.replacement.length - operation.find.length,
      0,
    );
  if (finalLength > MAX_FINAL_CHARS) return null;

  let result = draft;
  for (let index = located.length - 1; index >= 0; index -= 1) {
    const operation = located[index];
    result =
      result.slice(0, operation.start) +
      operation.replacement +
      result.slice(operation.end);
  }
  const minimumUsefulChars = Math.max(1, Math.ceil(draft.trim().length * 0.25));
  if (result.trim().length < minimumUsefulChars) return null;
  return result;
}
