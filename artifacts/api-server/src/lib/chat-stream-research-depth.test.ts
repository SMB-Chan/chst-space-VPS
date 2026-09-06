import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeSpecialistTool: vi.fn(),
}));

vi.mock("./specialist-capabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./specialist-capabilities")>();
  return {
    ...actual,
    executeSpecialistTool: mocks.executeSpecialistTool,
  };
});

import { runResearchLoop } from "./chat-stream-research";

function source(title: string, url: string) {
  return { title, url, publishedAt: null };
}

describe("deep research evidence coverage", () => {
  it("fetches page bodies, suppresses premature prose, and forces a gap search", async () => {
    mocks.executeSpecialistTool.mockImplementation(async (call) => {
      if (call.name === "fetch_page") {
        const { url } = JSON.parse(call.arguments) as { url: string };
        return {
          ok: true,
          capability: "fetch-page",
          summary: "page",
          text: `タイトル: page\nURL: ${url}\n本文:\nprimary evidence`,
          sources: [source("page", url)],
        };
      }
      if (call.id.startsWith("research-depth-gap-")) {
        return {
          ok: true,
          capability: "web-search",
          summary: "gap",
          text: [
            "[1] D\n    URL: https://d.example/1\n    本文:\nnew evidence",
            "[2] E\n    URL: https://e.example/1\n    本文:\nnew evidence",
          ].join("\n\n"),
          sources: [
            source("D", "https://d.example/1"),
            source("E", "https://e.example/1"),
          ],
        };
      }
      return {
        ok: true,
        capability: "web-search",
        summary: "initial",
        text: "initial snippets",
        sources: [
          source("A", "https://a.example/1"),
          source("B", "https://b.example/1"),
          source("C", "https://c.example/1"),
          source("A2", "https://a.example/2"),
          source("B2", "https://b.example/2"),
        ],
      };
    });

    let modelRound = 0;
    const streamText = vi.fn(async (input) => {
      modelRound += 1;
      if (modelRound === 1) {
        input.onDelta("premature answer", "content");
        return "premature answer";
      }
      input.onDelta("final grounded answer", "content");
      return "final grounded answer";
    });
    const emit = vi.fn();
    const controller = new AbortController();

    const result = await runResearchLoop({
      client: {} as never,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      reasoningLevel: "off",
      messages: [
        {
          role: "user",
          content: "このテーマを詳しく調査し、根拠と反対意見も含めて分析して",
        },
      ],
      tools: [],
      initialCalls: [
        {
          id: "initial-search",
          name: "web_search",
          arguments: JSON.stringify({ query: "topic" }),
        },
      ],
      hasPendingNonResearchCalls: false,
      signal: controller.signal,
      clientGone: () => false,
      emit,
      streamText,
      withTimeout: (create) => create(controller.signal),
    });

    expect(result.responseText).toBe("final grounded answer");
    expect(result.responseText).not.toContain("premature answer");
    expect(result.executedToolCount).toBe(4);
    expect(mocks.executeSpecialistTool).toHaveBeenCalledTimes(4);
    expect(
      mocks.executeSpecialistTool.mock.calls.filter(
        ([call]) => call.name === "fetch_page",
      ),
    ).toHaveLength(2);
    expect(
      mocks.executeSpecialistTool.mock.calls.some(([call]) =>
        call.id.startsWith("research-depth-gap-"),
      ),
    ).toBe(true);
    expect(
      emit.mock.calls.some(
        ([event]) => event && event.content === "premature answer",
      ),
    ).toBe(false);
    expect(
      emit.mock.calls.some(
        ([event]) => event && event.content === "final grounded answer",
      ),
    ).toBe(true);
  });
});
