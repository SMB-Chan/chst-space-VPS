export type AuditPatchOperation = {
  find: string;
  replacement: string;
};

export type AuditPatch = {
  note: string;
  operations: AuditPatchOperation[];
};

const MAX_OPERATIONS = 8;
const MAX_REPLACEMENT_CHARS = 4000;
const MAX_NOTE_CHARS = 2000;
const MAX_TARGET_CHARS = 4000;
const MAX_OPERATION_CHARS = 8000;
const MAX_TOTAL_REPLACEMENT_CHARS = 12_000;
const MAX_FINAL_CHARS = 20_000;

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
    const find = op.find;
    const replacement = op.replacement;
    if (
      typeof find !== "string" ||
      find.length === 0 ||
      find.length > MAX_TARGET_CHARS ||
      typeof replacement !== "string" ||
      replacement.length > MAX_REPLACEMENT_CHARS ||
      find.length + replacement.length > MAX_OPERATION_CHARS
    ) {
      return { content: draft, note, applied: false, reason: "監査パッチの原文または置換文字数が不正です。" };
    }
    const first = draft.indexOf(find);
    if (first < 0) {
      return { content: draft, note, applied: false, reason: "監査パッチの原文が初稿にありません。" };
    }
    if (draft.indexOf(find, first + 1) >= 0) {
      return { content: draft, note, applied: false, reason: "監査パッチの原文が初稿内で重複しています。" };
    }
    normalized.push({ find, replacement });
  }
  const located = normalized
    .map((op) => ({ ...op, from: draft.indexOf(op.find), to: draft.indexOf(op.find) + op.find.length }))
    .sort((a, b) => a.from - b.from);
  let totalReplacementChars = 0;
  for (let i = 0; i < located.length; i += 1) {
    totalReplacementChars += located[i].replacement.length;
    if (i > 0 && located[i - 1].to > located[i].from) {
      return { content: draft, note, applied: false, reason: "監査パッチの原文範囲が重複しています。" };
    }
  }
  if (totalReplacementChars > MAX_TOTAL_REPLACEMENT_CHARS) {
    return { content: draft, note, applied: false, reason: "監査パッチの置換総量が大きすぎます。" };
  }
  let content = draft;
  for (let i = located.length - 1; i >= 0; i -= 1) {
    const op = located[i];
    content = content.slice(0, op.from) + op.replacement + content.slice(op.to);
  }
  if (content.length > MAX_FINAL_CHARS) {
    return { content: draft, note, applied: false, reason: "監査パッチ後の本文が長すぎます。" };
  }
  if (normalized.length === 0) {
    return { content: draft, note, applied: false, operations: normalized };
  }
  return { content, note, applied: normalized.length > 0, operations: normalized };
}