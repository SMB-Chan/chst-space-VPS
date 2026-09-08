import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { streamModelText } from "./chat-stream";
import type { SpecialistToolCall } from "./specialist-capabilities";
import { planCapabilityTool } from "./capability-broker";
import { decideSearch } from "./web-search";

async function* answer() {
  yield { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] };
}

describe("MiMo request flow", () => {
  it("recovers reasoning-only output with thinking disabled and the same token cap", async () => {
    const requests: Record<string, unknown>[] = [];
    async function* reasoningOnly() {
      yield {
        choices: [
          {
            delta: { reasoning_content: "internal reasoning" },
            finish_reason: "length",
          },
        ],
      };
    }
    const create = vi.fn().mockImplementation(async (options) => {
      requests.push(structuredClone(options));
      return requests.length === 1 ? reasoningOnly() : answer();
    });
    const text = await streamModelText({
      client: { chat: { completions: { create } } } as unknown as OpenAI,
      modelId: "mimo-v2.5",
      provider: "xiaomi",
      reasoningLevel: "high",
      maxOutputTokens: 300,
      messages: [{ role: "user", content: "hello" }],
      onDelta: () => {},
      shouldStop: () => false,
    });
    expect(text).toBe("answer");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      thinking: { type: "enabled" },
      max_completion_tokens: 300,
    });
    expect(requests[1]).toMatchObject({
      thinking: { type: "disabled" },
      max_completion_tokens: 300,
    });
    expect(
      requests.every(
        (request) =>
          !("max_tokens" in request) && !("incremental_output" in request),
      ),
    ).toBe(true);
  });

  it("retains reasoning with completed tool calls for subsequent requests", async () => {
    async function* tools() {
      yield { choices: [{ delta: { reasoning_content: "tool reasoning" } }] };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "analyze_forms", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
    }
    const create = vi.fn().mockResolvedValue(tools());
    const calls: SpecialistToolCall[] = [];
    const visible: string[] = [];
    const text = await streamModelText({
      client: { chat: { completions: { create } } } as unknown as OpenAI,
      modelId: "mimo-v2.5-pro",
      provider: "xiaomi",
      reasoningLevel: "high",
      messages: [{ role: "user", content: "inspect this form" }],
      tools: [
        {
          type: "function",
          function: {
            name: "analyze_forms",
            description: "Inspect a form",
            parameters: { type: "object" },
          },
        },
      ],
      onToolCalls: (result) => calls.push(...result),
      onDelta: (value, kind) => {
        if (kind === "content") visible.push(value);
      },
      shouldStop: () => false,
    });
    expect(calls).toEqual([
      {
        id: "call-1",
        name: "analyze_forms",
        arguments: "{}",
        reasoningContent: "tool reasoning",
      },
    ]);
    expect(text).toBe("");
    expect(visible).toEqual([]);
  });

  it("keeps search and capability decisions short with thinking disabled", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({
        choices: [
          { message: { content: '{"tool":"none","needsSearch":false}' } },
        ],
      });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    await planCapabilityTool({
      client,
      modelId: "mimo-v2.5",
      provider: "xiaomi",
      userText: "猫の画像を生成して",
      hasReferenceImages: false,
    });
    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 800,
      thinking: { type: "disabled" },
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty("max_tokens");
    create.mockClear();
    await decideSearch(client, "mimo-v2.5", "xiaomi", "この製品について調べて");
    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 400,
      thinking: { type: "disabled" },
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty("max_tokens");
  });
});
