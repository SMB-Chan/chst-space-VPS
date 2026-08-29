import { EventEmitter } from "node:events";
import type OpenAI from "openai";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  createResponseCancellation,
  streamChatReply,
} from "./chat-stream";

class MockResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  writes: string[] = [];

  setHeader(): void {
    this.headersSent = true;
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(value: string): boolean {
    this.writes.push(value);
    if (value.includes('"content":"answer"')) {
      this.emit("close");
    }
    return true;
  }

  end(): this {
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
}

async function* answerStream(): AsyncGenerator<{
  choices: { delta: { content: string } }[];
}> {
  yield { choices: [{ delta: { content: "answer" } }] };
}

describe("response cancellation", () => {
  it("aborts the shared signal when the response closes before streaming starts", () => {
    const response = new MockResponse();
    const cancellation = createResponseCancellation(response as unknown as Response);

    response.emit("close");

    expect(cancellation.signal.aborted).toBe(true);
    expect(cancellation.isClientGone()).toBe(true);
    cancellation.dispose();
  });

  it("does not invoke completion persistence after a client disconnects", async () => {
    const response = new MockResponse();
    const cancellation = createResponseCancellation(response as unknown as Response);
    const onComplete = vi.fn(async () => undefined);
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(answerStream()),
        },
      },
    } as unknown as OpenAI;

    await streamChatReply({
      res: response as unknown as Response,
      client,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      reasoningLevel: "off",
      userText: "hello",
      chatMessages: [{ role: "user", content: "hello" }],
      translationMode: "ja-en",
      cancellation,
      onComplete,
      publicAiError: () => "error",
    });

    expect(cancellation.signal.aborted).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
    cancellation.dispose();
  });
});