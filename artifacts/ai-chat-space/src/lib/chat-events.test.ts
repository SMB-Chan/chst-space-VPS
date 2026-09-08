import { describe, expect, it, vi } from "vitest";
import { readChatEvents } from "./chat-events";

const encoder = new TextEncoder();
function stream(text: string, bytewise = false) {
  const bytes = encoder.encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytewise) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      } else controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("chat SSE protocol", () => {
  it.each(["\n", "\r\n", "\r"])(
    "reads %j frames across UTF-8 and delimiter boundaries",
    async (newline) => {
      const onEvent = vi.fn();
      const body = stream(
        [
          ": heartbeat",
          "",
          'data:{"content":"日本語🌸"}',
          "",
          'data: {"done":true}',
          "",
          "",
        ].join(newline),
        true,
      );
      await readChatEvents(body, onEvent);
      expect(onEvent.mock.calls).toEqual([
        [{ content: "日本語🌸" }],
        [{ done: true }],
      ]);
      expect(body.locked).toBe(false);
    },
  );

  it("joins multiline data and ignores unrelated SSE fields", async () => {
    const onEvent = vi.fn();
    await readChatEvents(
      stream(
        'event: message\nid: 1\nretry: 500\ndata: {\ndata: "content": "answer"}\n\ndata: {"done":true}\n\n',
      ),
      onEvent,
    );
    expect(onEvent).toHaveBeenNthCalledWith(1, { content: "answer" });
  });

  it.each([
    "",
    'data: {"content":"partial"}\n\n',
    'data: {"done":true}',
    'data: {"done":true}\n',
    'data: {"done":"true"}\n\n',
  ])("does not mark an incomplete response as successful: %j", async (text) => {
    await expect(readChatEvents(stream(text), vi.fn())).rejects.toThrow(
      "完了を確認できません",
    );
  });

  it("keeps delivered content but propagates a saved-turn error once", async () => {
    const onEvent = vi.fn();
    await expect(
      readChatEvents(
        stream(
          'data: {"content":"partial"}\n\ndata: {"error":"failed","turnSaved":true}\n\ndata: {"done":true}\n\n',
        ),
        onEvent,
      ),
    ).rejects.toMatchObject({ message: "failed", turnSaved: true });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ content: "partial" });
  });

  it.each(['{"content":', "null", "[]"])(
    "rejects malformed protocol data: %s",
    async (data) => {
      await expect(
        readChatEvents(
          stream(`data: ${data}\n\ndata: {"done":true}\n\n`),
          vi.fn(),
        ),
      ).rejects.toThrow();
    },
  );

  it("stops and releases the body immediately after done, ignoring trailing events", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"done":true}\n\ndata: {"content":"late"}\n\n'),
        );
      },
      cancel,
    });
    const onEvent = vi.fn();
    await readChatEvents(body, onEvent);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ done: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("cancels a pending read when the user stops", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const result = readChatEvents(body, vi.fn(), controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("does not deliver buffered events for an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const onEvent = vi.fn();
    const body = stream('data: {"content":"late"}\n\ndata: {"done":true}\n\n');
    await expect(
      readChatEvents(body, onEvent, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(onEvent).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });
});
