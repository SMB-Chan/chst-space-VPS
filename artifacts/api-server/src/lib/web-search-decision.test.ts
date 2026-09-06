import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { decideSearch } from "./web-search";

describe("decideSearch", () => {
  it("uses conversation context to turn a follow-up into a standalone query", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '{"search":true,"query":"広島 2026-09-02 2026-09-03 天気 比較"}',
          },
        },
      ],
    });
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await decideSearch(
      client,
      "qwen3.7-plus",
      "alibaba",
      "天候情報を比較してくれるか？",
      {
        recentConversation:
          "ユーザー: 今日と明日、広島で話題の映画を見るならどちら？",
      },
    );

    expect(result).toEqual({
      search: true,
      query: "広島 2026-09-02 2026-09-03 天気 比較",
    });
    const request = create.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(request.messages[1].content).toContain("今日と明日、広島");
    expect(request.messages[1].content).toContain(
      "天候情報を比較してくれるか？",
    );
  });

  it("returns bounded structured suggestions and re-sanitizes them through the planner", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              search: true,
              query: "OpenAI API documentation",
              suggestedQueries: [
                {
                  query: "OpenAI API official documentation",
                  role: "official",
                },
                {
                  query: "api_key=sk-abcdefghijklmnopqrstuvwxyz012345",
                  role: "technical",
                },
                {
                  query: "OpenAI API research papers",
                  role: "research",
                },
                { query: "ignored invalid role", role: "primary" },
              ],
            }),
          },
        },
      ],
    });
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await decideSearch(
      client,
      "qwen3.7-plus",
      "alibaba",
      "OpenAI APIの仕様を調べて",
      { recentConversation: "ユーザー: OpenAI APIについて" },
    );

    expect(result.search).toBe(true);
    expect(result.query).toBe("OpenAI API documentation");
    expect(result.plan?.queries[0]).toMatchObject({
      query: "OpenAI API documentation",
      role: "primary",
    });
    expect(result.plan?.queries.some((item) => item.role === "official")).toBe(
      true,
    );
    expect(
      result.plan?.queries.some((item) => item.query.includes("sk-")),
    ).toBe(false);
    expect(
      result.plan?.queries.some(
        (item) =>
          item.role === "primary" && item.query === "ignored invalid role",
      ),
    ).toBe(false);
    expect(result.plan?.queries.length).toBeLessThanOrEqual(4);

    const request = create.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(request.messages[0].content).toContain("suggestedQueries");
    expect(request.messages[0].content).toContain("最大2件");
    expect(request.messages[0].content).toContain("最大3 query");
  });

  it("falls back when a structured primary query is unsafe", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '{"search":true,"query":"api_key=sk-abcdefghijklmnopqrstuvwxyz012345","suggestedQueries":[{"query":"safe but unrelated","role":"official"}]}',
          },
        },
      ],
    });
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await decideSearch(
      client,
      "qwen3.7-plus",
      "alibaba",
      "天候情報を比較してくれるか？",
      { recentConversation: "ユーザー: 今日と明日、広島について" },
    );

    expect(result.search).toBe(true);
    expect(result.usedFallback).toBe(true);
    expect(result.query).toContain("広島");
    expect(result.query).not.toContain("sk-");
    expect(result.plan).toBeUndefined();
  });

  it("keeps compact keyword queries on the deterministic fast path", async () => {
    const create = vi.fn();
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    await expect(
      decideSearch(client, "qwen3.7-plus", "alibaba", "広島 天気"),
    ).resolves.toEqual({ search: true, query: "広島 天気" });
    expect(create).not.toHaveBeenCalled();
  });

  it("sends OpenRouter a plain token cap without DashScope vendor fields", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: '{"search": true, "query": "東京 株価 終値"}',
          },
        },
      ],
    });
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await decideSearch(
      client,
      "google/gemini-2.5-flash-lite",
      "openrouter",
      "東京の株価終値は？",
      { recentConversation: "ユーザー: 市場について" },
    );

    expect(result).toEqual({ search: true, query: "東京 株価 終値" });
    const request = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.max_tokens).toBe(400);
    expect(request.reasoning).toEqual({ enabled: false });
    expect(request).not.toHaveProperty("extra_body");
    expect(request).not.toHaveProperty("max_completion_tokens");
    expect(request).not.toHaveProperty("enable_thinking");
  });

  it("uses the previous user turn when planner output is malformed", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not-json" } }],
    });
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await decideSearch(
      client,
      "qwen3.7-plus",
      "alibaba",
      "天候情報を比較してくれるか？",
      { recentConversation: "ユーザー: 今日と明日、広島について" },
    );

    expect(result.search).toBe(true);
    expect(result.query).toContain("広島");
    expect(result.query).toContain("天気予報");
    expect(result.query).not.toContain("映画");
    expect(result.usedFallback).toBe(true);
  });

  it("parses fenced planner JSON instead of falling back", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '```json\n{"search": true, "query": "XR-5 製品仕様 2026"}\n```',
          },
        },
      ],
    });
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await decideSearch(
      client,
      "qwen3.7-plus",
      "alibaba",
      "XR-5の仕様を詳しく",
      { recentConversation: "ユーザー: XR-5って何？" },
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ search: true, query: "XR-5 製品仕様 2026" });
  });

  it("parses prose-decorated planner JSON with trailing braces in the text", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '判定結果: {"search": true, "query": "東京 株価 終値"} （括弧は}まで）',
          },
        },
      ],
    });
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await decideSearch(
      client,
      "qwen3.7-plus",
      "alibaba",
      "東京の株価終値は？",
      { recentConversation: "ユーザー: 市場について" },
    );

    expect(result).toEqual({ search: true, query: "東京 株価 終値" });
  });
});
