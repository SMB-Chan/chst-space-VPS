/** A terminal error from the chat protocol, including its persistence result. */
export class ChatStreamError extends Error {
  constructor(
    message: string,
    readonly turnSaved = false,
  ) {
    super(message);
    this.name = "ChatStreamError";
  }
}

/** Consume complete SSE frames. Only an explicit done event means success. */
export async function readChatEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let completed = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });

  const consumeLine = (line: string) => {
    if (line === "") {
      if (!data.length) return;
      let event: unknown;
      try {
        event = JSON.parse(data.join("\n"));
      } catch {
        throw new ChatStreamError(
          "応答データを読み取れませんでした。表示済みの回答は未完了です。",
        );
      }
      data = [];
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new ChatStreamError("応答データの形式が正しくありません。");
      }
      const parsed = event as Record<string, unknown>;
      if (typeof parsed.error === "string" && parsed.error) {
        throw new ChatStreamError(parsed.error, parsed.turnSaved === true);
      }
      onEvent(parsed);
      completed = parsed.done === true;
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    data.push(value);
  };

  try {
    signal?.throwIfAborted();
    while (!completed) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let start = 0;
      for (let i = 0; i < buffer.length && !completed; i++) {
        const char = buffer[i];
        if (char !== "\n" && char !== "\r") continue;
        // A CRLF pair can straddle two network chunks.
        if (char === "\r" && i === buffer.length - 1 && !done) break;
        consumeLine(buffer.slice(start, i));
        if (char === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      if (done) break;
    }
    if (!completed) {
      throw new ChatStreamError(
        "通信が途中で切れたため、回答の完了を確認できませんでした。表示済みの内容を保持しています。接続を確認して、もう一度お試しください。",
      );
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    // Stop at the terminal frame, even if a proxy keeps the HTTP body open.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
