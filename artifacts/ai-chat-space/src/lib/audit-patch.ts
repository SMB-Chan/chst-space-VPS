export type ClientPatchOperation = { target: string; replacement: string };

export function applyClientPatch(draft: string, operations: unknown): string | null {
  if (!Array.isArray(operations) || operations.length > 8) return null;
  const ops = operations.filter((op): op is ClientPatchOperation => {
    if (!op || typeof op !== "object") return false;
    const item = op as Record<string, unknown>;
    const target = item.target;
    const replacement = item.replacement;
    return typeof target === "string" && target.length > 0 && target.length <= 4000 &&
      typeof replacement === "string" && replacement.length <= 4000 &&
      draft.indexOf(target) >= 0 && draft.indexOf(target, draft.indexOf(target) + target.length) < 0;
  });
  if (ops.length !== operations.length) return null;
  for (let i = 0; i < ops.length; i += 1) {
    for (let j = i + 1; j < ops.length; j += 1) {
      if (ops[i].target.includes(ops[j].target) || ops[j].target.includes(ops[i].target)) return null;
    }
  }
  let result = draft;
  for (const op of ops) {
    result = result.replace(op.target, op.replacement);
  }
  if (result.length > 20000) return null;
  return result;
}