export type AuditPatchOperation = {
  start: number;
  end: number;
  replacement: string;
};

export type AuditPatch = {
  note: string;
  operations: AuditPatchOperation[];
};

const MAX_OPERATIONS = 8;
const MAX_REPLACEMENT_CHARS = 4000;
const MAX_NOTE_CHARS = 2000;

export function applyValidatedAuditPatch(
  draft: string,
  raw: string,
): { content: string; note: string; applied: boolean; operations?: AuditPatchOperation[]; reason?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { content: draft, note: "", applied: false, reason: "監査パッチがJSONではありません。" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { content: draft, note: "", applied: false, reason: "監査パッチの形式が不正です。" };
  }
  const value = parsed as Record<string, unknown>;
  const note = typeof value.note === "string" ? value.note.trim().slice(0, MAX_NOTE_CHARS) : "";
  const operations = value.operations;
  if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS) {
    return { content: draft, note, applied: false, reason: "監査パッチの操作数が不正です。" };
  }
  const normalized: AuditPatchOperation[] = [];
  for (const item of operations) {
    if (!item || typeof item !== "object") {
      return { content: draft, note, applied: false, reason: "監査パッチの操作が不正です。" };
    }
    const op = item as Record<string, unknown>;
    const start = op.start;
    const end = op.end;
    const replacement = op.replacement;
    const numericStart = typeof start === "number" && Number.isInteger(start) ? start : null;
    const numericEnd = typeof end === "number" && Number.isInteger(end) ? end : null;
    if (
      numericStart === null ||
      numericEnd === null ||
      typeof replacement !== "string" ||
      numericStart < 0 ||
      numericEnd < numericStart ||
      numericEnd > draft.length ||
      replacement.length > MAX_REPLACEMENT_CHARS
    ) {
      return { content: draft, note, applied: false, reason: "監査パッチの範囲または置換文字数が不正です。" };
    }
    normalized.push({ start: numericStart, end: numericEnd, replacement });
  }
  normalized.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i - 1].end > normalized[i].start) {
      return { content: draft, note, applied: false, reason: "監査パッチの範囲が重複しています。" };
    }
  }
  let content = draft;
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    const op = normalized[i];
    content = content.slice(0, op.start) + op.replacement + content.slice(op.end);
  }
  return { content, note, applied: normalized.length > 0, operations: normalized };
}