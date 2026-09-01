import type { Response } from "express";
import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeSpecialistTool: vi.fn(),
}));

vi.mock("./web-search", () => ({
  buildWebContext: vi.fn().mockResolvedValue({
    searched: false,
    sources: [],
    contextText: "",
  }),
}));

vi.mock("./capability-broker", () => ({
  planCapabilityTool: vi.fn().mockResolvedValue({ tool: "none" }),
}));

vi.mock("./skills", () => ({
  matchSkills: vi.fn(() => []),
  composeSkillSearchQuery: vi.fn(() => undefined),
}));

vi.mock("./llm-memory-tools", () => ({
  findRelevantMemories: vi.fn(() => []),
  formatMemoriesForPrompt: vi.fn(() => ""),
  runMemoryMaintenance: vi.fn(),
}));

vi.mock("./specialist-capabilities", () => ({
  executeSpecialistTool: mocks.executeSpecialistTool,
  getSpecialistTools: vi.fn(() => [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
  ]),
  isResearchTool: vi.fn(
    (call: { name?: string }) =>
      call.name === "web_search" || call.name === "fetch_page",
  ),
}));

import { streamChatReply } from "./chat-stream";

function modelStream(
  chunks: Array<{
    delta: Record<string, unknown>;
    finish_reason?: string | null;
  }>,
) {
  return (async function* () {
    for (const chunk of chunks) {
      yield { choices: [chunk] };
    }
  })();
}

function textStream(text: string) {
  return modelStream([{ delta: { content: text }, finish_reason: "stop" }]);
}

function toolStream(id: string, query: string) {
  return modelStream([
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id,
            function: {
              name: "web_search",
              arguments: JSON.stringify({ query }),
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ]);
}

function responseHarness() {
  const write = vi.fn();
  const end = vi.fn();
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write,
    end,
  } as unknown as Response;
  return { res, write, end };
}

async function runTurn(create: ReturnType<typeof vi.fn>) {
  const { res, write } = responseHarness();
  const onComplete = vi.fn().mockResolvedValue(undefined);
  const client = {
    chat: { completions: { create } },
  } as unknown as OpenAI;
  const controller = new AbortController();

  await streamChatReply({
    res,
    client,
    provider: "openai",
    modelId: "gpt-5.6-terra",
    reasoningLevel: "off",
    userText: "最新情報を調べて",
    chatMessages: [{ role: "user", content: "最新情報を調べて" }],
    cancellation: {
      signal: controller.signal,
      isClientGone: () => false,
      dispose: vi.fn(),
    },
    onComplete,
    publicAiError: () => "error",
  });

  return {
    onComplete,
    sse: write.mock.calls.map(([payload]) => String(payload)).join(""),
  };
}

describe("streamChatReply research completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeSpecialistTool.mockResolvedValue({
      ok: true,
      capability: "web_search",
      summary: "検索完了",
      text: "[1] 検索で確認した情報",
    });
  });

  it("recovers when a model only announces a search without calling the tool", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(textStream("Web検索を行って確認します。"))
      .mockResolvedValueOnce(toolStream("recovered-search", "最新情報"))
      .mockResolvedValueOnce(textStream("確認できた内容を回答します。[1]"));

    const result = await runTurn(create);

    expect(mocks.executeSpecialistTool).toHaveBeenCalledOnce();
    expect(result.onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("確認できた内容を回答します。[1]"),
      }),
    );
    expect(result.sse).toContain('"done":true');
  });

  it("forces a tool-free final answer when the last research step is another tool call", async () => {
    const create = vi.fn();
    for (let index = 0; index < 7; index++) {
      create.mockResolvedValueOnce(
        toolStream(`search-${index + 1}`, `query-${index + 1}`),
      );
    }
    create.mockResolvedValueOnce(
      textStream("検索上限までの根拠を使った最終回答です。[1]"),
    );

    const result = await runTurn(create);

    expect(mocks.executeSpecialistTool).toHaveBeenCalledTimes(6);
    expect(create).toHaveBeenCalledTimes(8);
    const finalRequest = create.mock.calls[7]?.[0] as {
      tools?: unknown;
      messages?: Array<{ content?: unknown }>;
    };
    expect(finalRequest.tools).toBeUndefined();
    expect(
      finalRequest.messages?.some((message) =>
        String(message.content).includes("追加のツールは呼び出せません"),
      ),
    ).toBe(true);
    expect(result.onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "検索上限までの根拠を使った最終回答です。[1]",
      }),
    );
  });
});
