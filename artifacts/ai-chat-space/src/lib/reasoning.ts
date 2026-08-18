export type ReasoningLevel = "off" | "low" | "medium" | "high";

export const REASONING_LEVELS: { id: ReasoningLevel; label: string; hint: string }[] = [
  { id: "off", label: "オフ", hint: "推論なし・最速" },
  { id: "low", label: "低", hint: "短い推論" },
  { id: "medium", label: "中", hint: "標準" },
  { id: "high", label: "高", hint: "じっくり考える" },
];

export function parseReasoningLevel(raw: unknown): ReasoningLevel {
  if (raw === "off" || raw === "low" || raw === "medium" || raw === "high") return raw;
  return "medium";
}
