import type { Response } from "express";
import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildWebContext: vi.fn(),
  executeSpecialistTool: vi.fn(),
  findRelevantMemories: vi.fn(),
  runMemoryMaintenance: vi.fn(),
}));

vi.mock("./web-search", () => ({
  buildWebContext: mocks.buildWebContext,
}));

vi.mock("./capability-broker", () => ({
  planCapabilityTool: vi.fn().mockResolvedValue({ tool: "none" }),
}));

vi.mock("./skills", () => ({
  matchSkills: vi.fn(() => []),
  composeSkillSearchQuery: vi.fn(() => undefined),
}));

vi.mock("./llm-memory-tools", () => ({
  findRelevantMemories: mocks.findRelevantMemories,
  formatMemoriesForPrompt: vi.fn(() => ""),
  runMemoryMaintenance: mocks.runMemoryMaintenance,
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
  isEvidenceTool: vi.fn(
    (call: { name?: string }) =>
      call.name === "web_search" || call.name === "fetch_page",
  ),
  isSpecialistMutationTool: vi.fn((call: { name?: string }) =>
    [
      "memory_store",
      "memory_update",
      "memory_forget",
      "memory_supersede",
    ].includes(call.name ?? ""),
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

function emptyStream() {
  return (async function* () {
    return;
  })();
}

function partialFailureStream(text: string) {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
    throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  })();
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

async function runTurn(
  create: ReturnType<typeof vi.fn>,
  memory: Parameters<typeof streamChatReply>[0]["memory"] = {
    enabled: false,
  },
) {
  const { res, write } = responseHarness();
  const onComplete = vi.fn().mockResolvedValue(undefined);
  const onFailure = vi.fn().mockResolvedValue(undefined);
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
    memory,
    onComplete,
    onFailure,
    publicAiError: () => "error",
  });

  return {
    onComplete,
    onFailure,
    sse: write.mock.calls.map(([payload]) => String(payload)).join(""),
  };
}

describe("streamChatReply research completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildWebContext.mockResolvedValue({
      searched: false,
      sources: [],
      contextText: "",
    });
    mocks.executeSpecialistTool.mockResolvedValue({
      ok: true,
      capability: "web_search",
      summary: "検索完了",
      text: "[1] 検索で確認した情報",
    });
    mocks.findRelevantMemories.mockResolvedValue([]);
    mocks.runMemoryMaintenance.mockResolvedValue({
      totalActive: 0,
      totalSuperseded: 0,
      totalExpired: 0,
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

  it("preserves the question and visible partial answer when research continuation disconnects", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolStream("search-1", "latest information"))
      .mockResolvedValueOnce(
        partialFailureStream("検索結果に基づく回答の途中です。"),
      );

    const result = await runTurn(create);

    expect(result.onComplete).not.toHaveBeenCalled();
    expect(result.onFailure).toHaveBeenCalledWith({
      content: "検索結果に基づく回答の途中です。",
      sources: [],
    });
    expect(result.sse).toContain('"turnSaved":true');
    expect(result.sse).toContain('"error":"error"');
  });

  it("returns a non-empty fallback when poor news quality remains after alternate failure", async () => {
    mocks.buildWebContext.mockResolvedValueOnce({
      searched: true,
      sources: [],
      contextText: "",
      newsQuality: {
        kind: "news",
        quality: "poor",
        taskSuccess: "failed",
        acceptedSourceCount: 0,
        freshSourceCount: 0,
        independentDomainCount: 0,
        officialOrMajorSourceCount: 0,
        queries: ["今日のニュース", "今日のニュース alternate"],
        rejected: [],
      },
    });
    const create = vi.fn().mockImplementation(async () => emptyStream());

    const result = await runTurn(create);

    expect(result.onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "信頼できる最新情報を十分に取得できなかったため、確認できませんでした。",
        factuality: expect.objectContaining({
          researchQuality: expect.objectContaining({
            quality: "poor",
            taskSuccess: "failed",
          }),
        }),
      }),
    );
    expect(result.sse).toContain("信頼できる最新情報を十分に取得できなかった");
    expect(result.sse).toContain('"done":true');
    expect(result.sse).not.toContain("応答が空でした");
  });

  it("repairs poor news once and persists the replacement sources", async () => {
    const quality = {
      kind: "news",
      quality: "poor",
      taskSuccess: "failed",
      acceptedSourceCount: 0,
      freshSourceCount: 0,
      independentDomainCount: 0,
      officialOrMajorSourceCount: 0,
      queries: [],
      rejected: [],
    };
    const sources = [
      { title: "A", url: "https://example.com/news/a" },
      { title: "B", url: "https://example.org/news/b" },
    ];
    mocks.buildWebContext
      .mockResolvedValueOnce({
        searched: true,
        sources: [],
        contextText: "No usable news",
        newsQuality: quality,
      })
      .mockResolvedValueOnce({
        searched: true,
        sources,
        contextText: "[1] News A\n[2] News B",
        newsQuality: {
          ...quality,
          quality: "good",
          freshSourceCount: 2,
          acceptedSourceCount: 2,
          independentDomainCount: 2,
        },
      });
    const create = vi
      .fn()
      .mockResolvedValueOnce(textStream("確認できませんでした。"))
      .mockResolvedValueOnce(textStream("確認したニュースです。[1][2]"))
      .mockResolvedValueOnce(textStream("{}"));
    const result = await runTurn(create);
    expect(mocks.buildWebContext).toHaveBeenCalledTimes(2);
    expect(mocks.buildWebContext.mock.calls[1]?.[5]).toMatchObject({
      newsRepair: true,
    });
    expect(result.onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "確認したニュースです。[1][2]",
        sources,
      }),
    );
    expect(result.sse).toContain('"resetContent":true');
  });

  it("uses long-term memory only when a user-scoped context is enabled", async () => {
    const privateCreate = vi
      .fn()
      .mockResolvedValueOnce(textStream("回答です。"));
    await runTurn(privateCreate, { enabled: false });
    expect(mocks.findRelevantMemories).not.toHaveBeenCalled();

    const persistentCreate = vi
      .fn()
      .mockResolvedValueOnce(textStream("回答です。"));
    await runTurn(persistentCreate, { enabled: true, userId: "user-123" });
    expect(mocks.findRelevantMemories).toHaveBeenCalledWith(
      "user-123",
      "最新情報を調べて",
      5,
    );
  });
});
