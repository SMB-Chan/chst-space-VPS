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
    expect(result.query).toContain("今日と明日、広島");
    expect(result.usedFallback).toBe(true);
  });
});
