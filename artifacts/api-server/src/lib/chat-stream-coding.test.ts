import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { applyCodingWrite, CODING_MAX_FILES_PER_TURN } from "./coding-mode";
import { CODING_MAX_TOOL_CALLS, runCodingLoop } from "./chat-stream-coding";
import type { SpecialistToolCall } from "./specialist-capabilities";
import type {
  StreamModelTextFn,
  StreamEventEmitter,
} from "./chat-stream-stage-types";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chat-stream-coding-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- Test doubles ---------- */

interface CallSpec {
  text: string;
  nextCalls: SpecialistToolCall[];
}

class ScriptedStream {
  private calls: CallSpec[];
  public invocations = 0;
  constructor(calls: CallSpec[]) {
    this.calls = calls;
  }
  fn = (async (args: Parameters<StreamModelTextFn>[0]) => {
    const c = this.calls[this.invocations] ?? { text: "", nextCalls: [] };
    this.invocations += 1;
    args.onToolCalls?.(c.nextCalls);
    return c.text;
  }) as StreamModelTextFn;
}

function makeCall(id: string, name: string, args: unknown): SpecialistToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function capturingEmit(): StreamEventEmitter & {
  events: Array<Record<string, unknown>>;
} {
  const events: Array<Record<string, unknown>> = [];
  const fn = ((e: Record<string, unknown>) => {
    events.push(e);
  }) as StreamEventEmitter;
  return Object.assign(fn, { events }) as never;
}

/* ---------- Tests ---------- */

describe("runCodingLoop", () => {
  it("executes initial tool calls, persists touches only for writes, and stops after the assistant produces no follow-ups", async () => {
    const root = tempRoot();
    applyCodingWrite(root, "src/app.ts", "export const n = 1;\n");

    const stream = new ScriptedStream([
      {
        text: "I updated the file.",
        nextCalls: [makeCall("c1", "code_read", { path: "src/app.ts" })],
      },
      { text: "Here is the final summary.", nextCalls: [] },
    ]);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: "coding mode" },
      { role: "user", content: "fix the bug" },
    ];
    const emit = capturingEmit();
    const signal = new AbortController();

    const result = await runCodingLoop({
      client: {} as OpenAI,
      provider: "openai",
      modelId: "gpt-test",
      reasoningLevel: "none",
      messages,
      tools: [],
      initialCalls: [
        makeCall("a1", "code_write", {
          path: "src/app.ts",
          content: "export const n = 7;\n",
        }),
      ],
      rootDir: root,
      signal: signal.signal,
      clientGone: () => false,
      emit,
      streamText: stream.fn,
      withTimeout: async (fn) => fn(signal.signal),
    });

    expect(result.executedToolCount).toBe(2);
    expect(result.touches.map((t) => t.path)).toEqual(["src/app.ts"]);
    expect(result.responseText).toBe(
      "I updated the file.Here is the final summary.",
    );

    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    const firstToolCalls =
      (
        assistants[0] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
      ).tool_calls ?? [];
    expect(firstToolCalls).toHaveLength(1);
    expect(firstToolCalls[0]?.function.name).toBe("code_write");

    expect(messages.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(stream.invocations).toBe(2);
    expect(emit.events.map((e) => e.status)).toContain("coding");
  });

  it("respects AbortSignal and terminates the loop", async () => {
    const root = tempRoot();
    applyCodingWrite(root, "src/app.ts", "export const n = 1;\n");

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: "x" },
      { role: "user", content: "x" },
    ];
    const signal = new AbortController();
    const emit = capturingEmit();

    const result = await runCodingLoop({
      client: {} as OpenAI,
      provider: "openai",
      modelId: "gpt-test",
      reasoningLevel: "none",
      messages,
      tools: [],
      initialCalls: [makeCall("a1", "code_read", { path: "src/app.ts" })],
      rootDir: root,
      signal: signal.signal,
      clientGone: () => false,
      emit,
      streamText: (async (args) => {
        args.onToolCalls?.([]);
        signal.abort();
        return "should not be returned";
      }) as StreamModelTextFn,
      withTimeout: async (fn, _ms, _label, parentSignal) =>
        fn(parentSignal ?? signal.signal),
    });

    expect(result.executedToolCount).toBeGreaterThanOrEqual(1);
    expect(result.executedToolCount).toBeLessThanOrEqual(CODING_MAX_TOOL_CALLS);
  });

  it("does not emit a 'coding' status when clientGone is already true", async () => {
    const root = tempRoot();
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: "x" },
    ];
    const signal = new AbortController();
    const emit = capturingEmit();
    const stream = new ScriptedStream([{ text: "", nextCalls: [] }]);

    await runCodingLoop({
      client: {} as OpenAI,
      provider: "openai",
      modelId: "gpt-test",
      reasoningLevel: "none",
      messages,
      tools: [],
      initialCalls: [
        makeCall("a1", "code_write", { path: "src/app.ts", content: "x" }),
      ],
      rootDir: root,
      signal: signal.signal,
      clientGone: () => true,
      emit,
      streamText: stream.fn,
      withTimeout: async (fn) => fn(signal.signal),
    });

    expect(emit.events.map((e) => e.status)).not.toContain("coding");
  });

  it("documents that CODING_MAX_FILES_PER_TURN > CODING_MAX_TOOL_CALLS makes the per-turn write ceiling unreachable in practice", () => {
    // If this ever changes, the rejection branch in chat-stream-coding.ts
    // becomes reachable and a new test should exercise it.
    expect(CODING_MAX_FILES_PER_TURN).toBeGreaterThan(CODING_MAX_TOOL_CALLS);
  });

  it("bails out at CODING_MAX_TOOL_CALLS and triggers a final-answer fallback when the assistant keeps requesting tools", async () => {
    const root = tempRoot();
    applyCodingWrite(root, "src/app.ts", "export const n = 1;\n");

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: "x" },
    ];
    const signal = new AbortController();
    const emit = capturingEmit();

    const stream = new ScriptedStream(
      Array.from({ length: 50 }, () => ({
        text: "loop-step",
        nextCalls: [makeCall("loop", "code_read", { path: "src/app.ts" })],
      })),
    );

    const result = await runCodingLoop({
      client: {} as OpenAI,
      provider: "openai",
      modelId: "gpt-test",
      reasoningLevel: "none",
      messages,
      tools: [],
      initialCalls: [makeCall("a1", "code_read", { path: "src/app.ts" })],
      rootDir: root,
      signal: signal.signal,
      clientGone: () => false,
      emit,
      streamText: stream.fn,
      withTimeout: async (fn) => fn(signal.signal),
    });

    expect(result.executedToolCount).toBeLessThanOrEqual(CODING_MAX_TOOL_CALLS);
    expect(result.responseText.length).toBeGreaterThan(0);
    const fallback = messages.find(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.startsWith("コーディングツールの実行は終了しました"),
    );
    expect(fallback).toBeDefined();
  });

  it("attaches provider reasoning content to the assistant message in addition to tool_calls (xiaomi)", async () => {
    const root = tempRoot();
    applyCodingWrite(root, "src/app.ts", "export const n = 1;\n");

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: "x" },
    ];
    const signal = new AbortController();
    const emit = capturingEmit();
    const stream = new ScriptedStream([{ text: "ok", nextCalls: [] }]);

    await runCodingLoop({
      client: {} as OpenAI,
      provider: "xiaomi",
      modelId: "xiaomi-test",
      reasoningLevel: "low",
      messages,
      tools: [],
      initialCalls: [
        Object.assign(makeCall("a1", "code_read", { path: "src/app.ts" }), {
          reasoningContent: "model-thought-process",
        }) as SpecialistToolCall,
      ],
      rootDir: root,
      signal: signal.signal,
      clientGone: () => false,
      emit,
      streamText: stream.fn,
      withTimeout: async (fn) => fn(signal.signal),
    });

    const firstAssistant = messages.find((m) => m.role === "assistant") as
      OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam | undefined;
    expect(firstAssistant).toBeDefined();
    expect(firstAssistant).toMatchObject({
      reasoning_content: "model-thought-process",
    });
  });
});
