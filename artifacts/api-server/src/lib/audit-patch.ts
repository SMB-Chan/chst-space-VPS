export type AuditPatchOperation = {
  find: string;
  replacement: string;
};

export type AuditPatch = {
  note: string;
  operations: AuditPatchOperation[];
};

const MAX_OPERATIONS = 8;
const MAX_FIND_CHARS = 2000;
const MAX_REPLACEMENT_CHARS = 4000;
const MAX_TOTAL_REPLACEMENT_CHARS = 8000;
const MAX_FINAL_CHARS = 20_000;
const MAX_NOTE_CHARS = 2000;

function unwrapJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i);
  return fenced ? fenced[1] : trimmed;
}

export function applyValidatedAuditPatch(
  draft: string,
  raw: string,
): {
  content: string;
  note: string;
  applied: boolean;
  operations?: AuditPatchOperation[];
  reason?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJson(raw));
  } catch {
    return {
      content: draft,
      note: "",
      applied: false,
      reason: "監査パッチがJSONではありません。",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      content: draft,
      note: "",
      applied: false,
      reason: "監査パッチの形式が不正です。",
    };
  }

  const value = parsed as Record<string, unknown>;
  const note =
    typeof value.note === "string"
      ? value.note.trim().slice(0, MAX_NOTE_CHARS)
      : "";
  if (
    !Array.isArray(value.operations) ||
    value.operations.length > MAX_OPERATIONS
  ) {
    return {
      content: draft,
      note,
      applied: false,
      reason: "監査パッチの操作数が不正です。",
    };
  }

  const located: Array<AuditPatchOperation & { start: number; end: number }> =
    [];
  let totalReplacementChars = 0;
  for (const item of value.operations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        content: draft,
        note,
        applied: false,
        reason: "監査パッチの操作が不正です。",
      };
    }
    const operation = item as Record<string, unknown>;
    const find = operation.find;
    const replacement = operation.replacement;
    if (
      typeof find !== "string" ||
      typeof replacement !== "string" ||
      find.length === 0 ||
      find.length > MAX_FIND_CHARS ||
      replacement.length > MAX_REPLACEMENT_CHARS
    ) {
      return {
        content: draft,
        note,
        applied: false,
        reason: "監査パッチの原文または置換文字数が不正です。",
      };
    }

    const start = draft.indexOf(find);
    if (start < 0 || draft.indexOf(find, start + 1) >= 0) {
      return {
        content: draft,
        note,
        applied: false,
        reason: "監査パッチの原文が一意に一致しません。",
      };
    }
    totalReplacementChars += replacement.length;
    if (totalReplacementChars > MAX_TOTAL_REPLACEMENT_CHARS) {
      return {
        content: draft,
        note,
        applied: false,
        reason: "監査パッチの置換総量が上限を超えています。",
      };
    }
    located.push({ find, replacement, start, end: start + find.length });
  }

  located.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < located.length; index += 1) {
    if (located[index - 1].end > located[index].start) {
      return {
        content: draft,
        note,
        applied: false,
        reason: "監査パッチの対象範囲が重複しています。",
      };
    }
  }

  const finalLength =
    draft.length +
    located.reduce(
      (length, operation) =>
        length + operation.replacement.length - operation.find.length,
      0,
    );
  if (finalLength > MAX_FINAL_CHARS) {
    return {
      content: draft,
      note,
      applied: false,
      reason: "監査パッチ適用後の回答が上限を超えています。",
    };
  }

  let content = draft;
  for (let index = located.length - 1; index >= 0; index -= 1) {
    const operation = located[index];
    content =
      content.slice(0, operation.start) +
      operation.replacement +
      content.slice(operation.end);
  }
  const operations = located.map(({ find, replacement }) => ({
    find,
    replacement,
  }));
  return { content, note, applied: operations.length > 0, operations };
}
