import { TextDecoder } from "node:util";

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

interface ReadableByteBody {
  getReader(): ByteReader;
}

export interface ResponseWithReadableBody {
  body: ReadableByteBody | null;
}

/**
 * Consume a fetch response body without ever buffering more than maxBytes.
 * The caller should pass the fetch implementation's decompressed body stream,
 * so the limit also protects against compressed-response expansion.
 */
export async function readResponseTextLimited(
  response: ResponseWithReadableBody,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel("Response body exceeded the configured limit");
        } catch {
          // The original size-limit error is more useful than a cancel error.
        }
        throw new Error(`Response body exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some implementations release the lock as part of cancellation.
    }
  }
}
