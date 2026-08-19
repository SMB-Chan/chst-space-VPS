import { describe, expect, it } from "vitest";
import { readResponseTextLimited } from "./bounded-body";

function responseBody(...chunks: Uint8Array[]) {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

describe("readResponseTextLimited", () => {
  it("decodes a streamed UTF-8 response", async () => {
    const encoded = new TextEncoder().encode("日本語の本文");
    const result = await readResponseTextLimited(
      responseBody(encoded.slice(0, 4), encoded.slice(4)),
      encoded.byteLength,
    );
    expect(result).toBe("日本語の本文");
  });

  it("rejects before buffering a response above the byte limit", async () => {
    await expect(
      readResponseTextLimited(
        responseBody(new Uint8Array(6), new Uint8Array(6)),
        10,
      ),
    ).rejects.toThrow("exceeds 10 bytes");
  });

  it("rejects invalid limits", async () => {
    await expect(readResponseTextLimited(responseBody(), 0)).rejects.toThrow(
      "positive integer",
    );
  });
});
