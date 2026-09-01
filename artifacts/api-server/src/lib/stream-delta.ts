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

const TEXT_TOOL_OPEN_MARKERS = ["<tool_call", "<function_call"] as const;
const TEXT_TOOL_BLOCK_RE =
  /<(tool_call|function_call)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const TEXT_TOOL_DANGLING_RE = /<(?:tool_call|function_call)\b[^>]*>[\s\S]*$/i;
const TEXT_TOOL_ORPHAN_CLOSE_RE = /<\/(?:tool_call|function_call)\s*>/gi;
const MAX_TEXT_TOOL_CALLS = 4;
const MAX_TEXT_TOOL_PAYLOAD_CHARS = 16_384;

export type TextToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ExtractedTextToolCalls = {
  content: string;
  calls: TextToolCall[];
  sawToolMarkup: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseTextToolCall(
  payload: string,
  allowedToolNames: ReadonlySet<string>,
  index: number,
): TextToolCall | undefined {
  const trimmed = payload
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!trimmed || trimmed.length > MAX_TEXT_TOOL_PAYLOAD_CHARS) {
    return undefined;
  }

  let root: Record<string, unknown> | undefined;
  try {
    root = asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
  if (!root) return undefined;

  const nestedFunction = asRecord(root.function);
  const nameValue = root.name ?? nestedFunction?.name;
  if (typeof nameValue !== "string" || !allowedToolNames.has(nameValue)) {
    return undefined;
  }

  const argumentsValue =
    root.arguments ??
    root.parameters ??
    nestedFunction?.arguments ??
    nestedFunction?.parameters ??
    {};
  let normalizedArguments: string;
  try {
    const parsedArguments =
      typeof argumentsValue === "string"
        ? JSON.parse(argumentsValue)
        : argumentsValue;
    if (!asRecord(parsedArguments)) return undefined;
    normalizedArguments = JSON.stringify(parsedArguments);
  } catch {
    return undefined;
  }

  const idValue = root.id;
  return {
    id:
      typeof idValue === "string" && idValue.trim()
        ? idValue
        : `text-tool-${index + 1}`,
    name: nameValue,
    arguments: normalizedArguments,
  };
}

/**
 * Return only the prefix that is safe to expose while a stream is active.
 * A possible opening-tag suffix is held until the next chunk confirms that it
 * is ordinary text, so tags split across provider chunks never reach the UI.
 */
export function visibleTextBeforeToolMarkup(text: string): string {
  const lower = text.toLowerCase();
  let safeEnd = text.length;

  for (const marker of TEXT_TOOL_OPEN_MARKERS) {
    const markerIndex = lower.indexOf(marker);
    if (markerIndex >= 0) safeEnd = Math.min(safeEnd, markerIndex);

    const maxSuffixLength = Math.min(marker.length - 1, lower.length);
    for (let length = maxSuffixLength; length > 0; length--) {
      if (marker.startsWith(lower.slice(-length))) {
        safeEnd = Math.min(safeEnd, text.length - length);
        break;
      }
    }
  }

  return text.slice(0, safeEnd);
}

/**
 * Normalize providers that serialize function calls in assistant text instead
 * of returning OpenAI-compatible delta.tool_calls. Unadvertised, malformed and
 * oversized calls are removed but never executed.
 */
export function extractTextToolCalls(
  text: string,
  allowedToolNames: ReadonlySet<string>,
): ExtractedTextToolCalls {
  const calls: TextToolCall[] = [];
  let sawToolMarkup = false;
  let content = text.replace(
    TEXT_TOOL_BLOCK_RE,
    (_block, _tagName: string, payload: string) => {
      sawToolMarkup = true;
      if (calls.length < MAX_TEXT_TOOL_CALLS) {
        const call = parseTextToolCall(payload, allowedToolNames, calls.length);
        if (call) calls.push(call);
      }
      return "";
    },
  );

  if (TEXT_TOOL_DANGLING_RE.test(content)) {
    sawToolMarkup = true;
    content = content.replace(TEXT_TOOL_DANGLING_RE, "");
  }
  if (TEXT_TOOL_ORPHAN_CLOSE_RE.test(content)) {
    sawToolMarkup = true;
    content = content.replace(TEXT_TOOL_ORPHAN_CLOSE_RE, "");
  }
  if (sawToolMarkup) {
    // Textual calls are frequently wrapped in a standalone markdown fence.
    // Remove only empty wrappers left behind after extracting the call.
    content = content.replace(/```(?:json|xml)?\s*```/gi, "");
  }

  return {
    content: content.replace(/^\s+/, ""),
    calls,
    sawToolMarkup,
  };
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
