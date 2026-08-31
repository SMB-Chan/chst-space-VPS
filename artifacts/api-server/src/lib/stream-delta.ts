/**
 * DashScope (and some Qwen-compatible endpoints) may emit *cumulative*
 * stream chunks: each delta.content is the full text so far, not the new
 * suffix. Appending those produces a doubled / stuttered answer.
 */
export function mergeStreamDelta(acc: string, delta: string): string {
  if (!delta) return acc;
  if (!acc) return delta;
  if (delta === acc) return acc;
  if (delta.startsWith(acc)) return delta;
  if (acc.startsWith(delta)) return acc;
  return acc + delta;
}

const CLOSED_THINK_RE = /<think>([\s\S]*?)<\/think>/gi;

/** Pull completed <think>…</think> blocks out of visible answer text. */
export function splitThinkTags(text: string): {
  reasoning: string;
  content: string;
} {
  const blocks: string[] = [];
  const content = text
    .replace(CLOSED_THINK_RE, (_match, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) blocks.push(trimmed);
      return "";
    })
    .replace(/^\s+/, "");
  return { reasoning: blocks.join("\n\n"), content };
}

export type StreamDelta = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
};

export function readReasoningDelta(delta: StreamDelta | undefined): string {
  if (!delta) return "";
  return delta.reasoning_content || delta.reasoning || "";
}

export function readContentDelta(delta: StreamDelta | undefined): string {
  if (!delta) return "";
  return delta.content || "";
}
