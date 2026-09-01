import { EventEmitter } from "node:events";
import type OpenAI from "openai";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createResponseCancellation, streamChatReply } from "./chat-stream";

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

class StreamingResponse extends EventEmitter {
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

async function* transientFailureStream(): AsyncGenerator<{
  choices: { delta: { content: string } }[];
}> {
  throw Object.assign(new Error("upstream unavailable"), { status: 503 });
}

async function* partialFailureStream(): AsyncGenerator<{
  choices: { delta: { content: string } }[];
}> {
  yield { choices: [{ delta: { content: "partial" } }] };
  throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
}

async function* reasoningStream(): AsyncGenerator<{
  choices: { delta: { content?: string; reasoning_content?: string } }[];
}> {
  yield { choices: [{ delta: { reasoning_content: "private chain" } }] };
  yield { choices: [{ delta: { content: "answer" } }] };
}

async function* emptyStream(): AsyncGenerator<{
  choices: { delta: { content?: string } }[];
}> {
  return;
}

async function* delayedAnswerStream(): AsyncGenerator<{
  choices: { delta: { content: string } }[];
}> {
  await new Promise((resolve) => setTimeout(resolve, 16_000));
  yield { choices: [{ delta: { content: "answer" } }] };
}

describe("response cancellation", () => {
  it("aborts the shared signal when the response closes before streaming starts", () => {
    const response = new MockResponse();
    const cancellation = createResponseCancellation(
      response as unknown as Response,
    );

    response.emit("close");

    expect(cancellation.signal.aborted).toBe(true);
    expect(cancellation.isClientGone()).toBe(true);
    cancellation.dispose();
  });

  it("does not invoke completion persistence after a client disconnects", async () => {
    const response = new MockResponse();
    const cancellation = createResponseCancellation(
      response as unknown as Response,
    );
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

describe("model stream recovery", () => {
  it("retries a transient failure before visible output", async () => {
    const response = new StreamingResponse();
    const create = vi
      .fn()
      .mockResolvedValueOnce(transientFailureStream())
      .mockResolvedValueOnce(answerStream());
    const client = {
      chat: { completions: { create } },
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
      publicAiError: () => "error",
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(response.writes.join("\n")).toContain('"content":"answer"');
    expect(response.writes.join("\n")).toContain('"done":true');
    expect(response.writes.join("\n")).not.toContain('"error"');
  });

  it("does not retry after visible output to avoid duplicate text", async () => {
    const response = new StreamingResponse();
    const create = vi.fn().mockResolvedValue(partialFailureStream());
    const client = {
      chat: { completions: { create } },
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
      publicAiError: () => "stream interrupted",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(response.writes.join("\n")).toContain('"content":"partial"');
    expect(response.writes.join("\n")).toContain(
      '"error":"stream interrupted"',
    );
  });

  it("retries a clean empty response with thinking disabled", async () => {
    const response = new StreamingResponse();
    const create = vi
      .fn()
      .mockResolvedValueOnce(emptyStream())
      .mockResolvedValueOnce(answerStream());
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    await streamChatReply({
      res: response as unknown as Response,
      client,
      provider: "dashscope",
      modelId: "qwen3.8-max",
      reasoningLevel: "high",
      userText: "hello",
      chatMessages: [{ role: "user", content: "hello" }],
      translationMode: "ja-en",
      publicAiError: () => "error",
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      extra_body: { incremental_output: true, enable_thinking: false },
    });
    expect(response.writes.join("\n")).toContain('"content":"answer"');
    expect(response.writes.join("\n")).not.toContain('"error"');
  });

  it("reports an error after a clean empty response is retried once", async () => {
    const response = new StreamingResponse();
    const create = vi.fn().mockImplementation(async () => emptyStream());
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    await streamChatReply({
      res: response as unknown as Response,
      client,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      reasoningLevel: "medium",
      userText: "hello",
      chatMessages: [{ role: "user", content: "hello" }],
      translationMode: "ja-en",
      publicAiError: () => "error",
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(response.writes.join("\n")).toContain(
      '"error":"応答が空でした。もう一度お試しください。"',
    );
  });

  it("emits a safe thinking heartbeat without exposing reasoning text", async () => {
    const response = new StreamingResponse();
    const client = {
      chat: {
        completions: { create: vi.fn().mockResolvedValue(reasoningStream()) },
      },
    } as unknown as OpenAI;

    await streamChatReply({
      res: response as unknown as Response,
      client,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      reasoningLevel: "medium",
      userText: "hello",
      chatMessages: [{ role: "user", content: "hello" }],
      translationMode: "ja-en",
      publicAiError: () => "error",
    });

    const output = response.writes.join("\n");
    expect(output).toContain('"status":"thinking"');
    expect(output).not.toContain("private chain");
    expect(output).toContain('"content":"answer"');
  });

  it("keeps the SSE connection alive while the model is silent", async () => {
    vi.useFakeTimers();
    try {
      const response = new StreamingResponse();
      const client = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue(delayedAnswerStream()),
          },
        },
      } as unknown as OpenAI;

      const reply = streamChatReply({
        res: response as unknown as Response,
        client,
        provider: "openai",
        modelId: "gpt-5.6-terra",
        reasoningLevel: "off",
        userText: "hello",
        chatMessages: [{ role: "user", content: "hello" }],
        translationMode: "ja-en",
        publicAiError: () => "error",
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(response.writes).toContain(": keepalive\n\n");
      await vi.advanceTimersByTimeAsync(1_000);
      await reply;
      expect(response.writes.join("\n")).toContain('"content":"answer"');
    } finally {
      vi.useRealTimers();
    }
  });
});
