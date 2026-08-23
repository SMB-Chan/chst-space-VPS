export type AuditPatchOperation = {
  target: string;
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
    const target = op.target;
    const replacement = op.replacement;
    if (
      typeof target !== "string" ||
      target.length === 0 ||
      target.length > MAX_TARGET_CHARS ||
      typeof replacement !== "string" ||
      replacement.length > MAX_REPLACEMENT_CHARS
    ) {
      return { content: draft, note, applied: false, reason: "監査パッチの原文または置換文字数が不正です。" };
    }
    const first = draft.indexOf(target);
    if (first < 0) {
      return { content: draft, note, applied: false, reason: "監査パッチの原文が初稿にありません。" };
    }
    if (draft.indexOf(target, first + target.length) >= 0) {
      return { content: draft, note, applied: false, reason: "監査パッチの原文が初稿内で重複しています。" };
    }
    normalized.push({ target, replacement });
  }
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      if (normalized[i].target.includes(normalized[j].target) || normalized[j].target.includes(normalized[i].target)) {
        return { content: draft, note, applied: false, reason: "監査パッチの原文範囲が重複しています。" };
      }
    }
  }
  let content = draft;
  for (const op of normalized) {
    content = content.replace(op.target, op.replacement);
  }
  if (content.length > MAX_FINAL_CHARS) {
    return { content: draft, note, applied: false, reason: "監査パッチ後の本文が長すぎます。" };
  }
  if (normalized.length === 0) {
    return { content: draft, note, applied: false, operations: normalized };
  }
  return { content, note, applied: normalized.length > 0, operations: normalized };
}