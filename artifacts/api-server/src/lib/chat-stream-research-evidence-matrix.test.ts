import { beforeEach, describe, expect, it, vi } from "vitest";

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

function matrixCall(input: {
  messages: { role?: string; content?: unknown }[];
}): boolean {
  return input.messages.some(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.includes("Deep Researchの証拠充足判定器"),
  );
}

function numericCoverageSearchResult(summary: string) {
  return {
    ok: true,
    capability: "web-search",
    summary,
    text: [
      "[1] A\n    URL: https://a.example/1\n    本文:\nprimary evidence",
      "[2] B\n    URL: https://b.example/1\n    本文:\ncounter evidence",
    ].join("\n\n"),
    sources: [
      source("A", "https://a.example/1"),
      source("B", "https://b.example/1"),
      source("C", "https://c.example/1"),
      source("A2", "https://a.example/2"),
      source("B2", "https://b.example/2"),
      source("C2", "https://c.example/2"),
    ],
  };
}

beforeEach(() => {
  mocks.executeSpecialistTool.mockReset();
});

describe("semantic evidence matrix retrieval", () => {
  it("targets a missing impact facet after numeric coverage is already sufficient", async () => {
    mocks.executeSpecialistTool.mockImplementation(async (call) => {
      if (call.id === "initial") {
        return numericCoverageSearchResult("initial");
      }
      if (call.id === "second-angle") {
        return {
          ok: true,
          capability: "web-search",
          summary: "second",
          text: "[1] D\n    URL: https://d.example/1\n    本文:\nmore primary evidence",
          sources: [source("D", "https://d.example/1")],
        };
      }
      if (call.id.startsWith("research-evidence-gap-impact-")) {
        return {
          ok: true,
          capability: "web-search",
          summary: "impact gap",
          text: "[1] Impact\n    URL: https://impact.example/1\n    本文:\nmeasured impact and risk data",
          sources: [source("Impact", "https://impact.example/1")],
        };
      }
      throw new Error(`unexpected tool call ${call.id}`);
    });

    let matrixRound = 0;
    let decisionRound = 0;
    const streamText = vi.fn(async (input) => {
      if (matrixCall(input)) {
        matrixRound += 1;
        if (matrixRound === 1) {
          return JSON.stringify({
            facets: [
              {
                facet: "primary_source",
                status: "covered",
                sourceIds: [1],
                reason: "primary evidence",
              },
              {
                facet: "impact",
                status: "missing",
                sourceIds: [],
                reason: "impact evidence is absent",
              },
              {
                facet: "counterevidence",
                status: "covered",
                sourceIds: [2],
                reason: "counter evidence",
              },
            ],
          });
        }
        return JSON.stringify({
          facets: [
            {
              facet: "primary_source",
              status: "covered",
              sourceIds: [1],
              reason: "primary evidence",
            },
            {
              facet: "impact",
              status: "covered",
              sourceIds: [8],
              reason: "measured impact data",
            },
            {
              facet: "counterevidence",
              status: "covered",
              sourceIds: [2],
              reason: "counter evidence",
            },
          ],
        });
      }

      decisionRound += 1;
      if (decisionRound === 1) {
        input.onToolCalls?.([
          {
            id: "second-angle",
            name: "web_search",
            arguments: JSON.stringify({
              query: "second angle",
              fetchContent: true,
            }),
          },
        ]);
        return "";
      }
      if (decisionRound === 2) {
        input.onDelta("premature semantic answer", "content");
        return "premature semantic answer";
      }
      input.onDelta("final evidence-matrix answer", "content");
      return "final evidence-matrix answer";
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
          content: "このテーマの影響と反対意見を詳しく調査して",
        },
      ],
      tools: [],
      initialCalls: [
        {
          id: "initial",
          name: "web_search",
          arguments: JSON.stringify({ query: "topic", fetchContent: true }),
        },
      ],
      hasPendingNonResearchCalls: false,
      signal: controller.signal,
      clientGone: () => false,
      emit,
      streamText,
      withTimeout: (create) => create(controller.signal),
    });

    expect(result.responseText).toBe("final evidence-matrix answer");
    expect(result.responseText).not.toContain("premature semantic answer");
    expect(matrixRound).toBe(2);
    expect(
      mocks.executeSpecialistTool.mock.calls.some(([call]) =>
        call.id.startsWith("research-evidence-gap-impact-"),
      ),
    ).toBe(true);
    expect(
      emit.mock.calls.some(
        ([event]) => event?.evidenceMatrix?.complete === false,
      ),
    ).toBe(true);
    expect(
      emit.mock.calls.some(
        ([event]) => event?.evidenceMatrix?.complete === true,
      ),
    ).toBe(true);
  });

  it("fails open to numeric coverage when a later matrix assessment is malformed", async () => {
    mocks.executeSpecialistTool.mockImplementation(async (call) => {
      if (call.id === "initial") {
        return numericCoverageSearchResult("initial");
      }
      if (call.id === "second-angle") {
        return {
          ok: true,
          capability: "web-search",
          summary: "second",
          text: "[1] D\n    URL: https://d.example/1\n    本文:\nsecond angle evidence",
          sources: [source("D", "https://d.example/1")],
        };
      }
      if (call.id.startsWith("research-evidence-gap-impact-")) {
        return {
          ok: true,
          capability: "web-search",
          summary: "impact gap",
          text: "[1] Impact\n    URL: https://impact.example/1\n    本文:\nimpact evidence",
          sources: [source("Impact", "https://impact.example/1")],
        };
      }
      throw new Error(`unexpected tool call ${call.id}`);
    });

    let matrixRound = 0;
    let decisionRound = 0;
    const decisionInputs: Array<{
      messages: { role?: string; content?: unknown }[];
    }> = [];
    const streamText = vi.fn(async (input) => {
      if (matrixCall(input)) {
        matrixRound += 1;
        if (matrixRound === 1) {
          return JSON.stringify({
            facets: [
              {
                facet: "primary_source",
                status: "covered",
                sourceIds: [1],
                reason: "primary evidence",
              },
              {
                facet: "impact",
                status: "missing",
                sourceIds: [],
                reason: "impact evidence is absent",
              },
              {
                facet: "counterevidence",
                status: "covered",
                sourceIds: [2],
                reason: "counter evidence",
              },
            ],
          });
        }
        return "not-json";
      }

      decisionInputs.push(input);
      decisionRound += 1;
      if (decisionRound === 1) {
        input.onToolCalls?.([
          {
            id: "second-angle",
            name: "web_search",
            arguments: JSON.stringify({
              query: "second angle",
              fetchContent: true,
            }),
          },
        ]);
        return "";
      }
      if (decisionRound === 2) {
        input.onDelta("premature semantic answer", "content");
        return "premature semantic answer";
      }
      input.onDelta("final after fail-open", "content");
      return "final after fail-open";
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
          content: "このテーマの影響を詳しく調査して",
        },
      ],
      tools: [],
      initialCalls: [
        {
          id: "initial",
          name: "web_search",
          arguments: JSON.stringify({ query: "topic", fetchContent: true }),
        },
      ],
      hasPendingNonResearchCalls: false,
      signal: controller.signal,
      clientGone: () => false,
      emit,
      streamText,
      withTimeout: (create) => create(controller.signal),
    });

    expect(result.responseText).toBe("final after fail-open");
    expect(result.responseText).not.toContain("premature semantic answer");
    expect(matrixRound).toBe(2);
    expect(
      mocks.executeSpecialistTool.mock.calls.filter(([call]) =>
        call.id.startsWith("research-evidence-gap-impact-"),
      ),
    ).toHaveLength(1);
    expect(
      emit.mock.calls.some(
        ([event]) => event && event.content === "final after fail-open",
      ),
    ).toBe(true);
    const postFailureDecision = decisionInputs.at(-1);
    expect(
      postFailureDecision?.messages.some((message) =>
        String(message.content).includes("証拠マトリクスに未充足論点"),
      ),
    ).toBe(false);
  });

  it("does not start a matrix assessment after the client is gone", async () => {
    mocks.executeSpecialistTool.mockResolvedValue({
      ok: true,
      capability: "web-search",
      summary: "initial",
      text: "[1] A\n    URL: https://a.example/1\n    本文:\nevidence",
      sources: [
        source("A", "https://a.example/1"),
        source("B", "https://b.example/1"),
        source("C", "https://c.example/1"),
        source("D", "https://d.example/1"),
        source("E", "https://e.example/1"),
        source("F", "https://f.example/1"),
      ],
    });

    const streamText = vi.fn(async (input) => {
      input.onDelta("answer", "content");
      return "answer";
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
          content: "このテーマの影響と反対意見を詳しく調査して",
        },
      ],
      tools: [],
      initialCalls: [
        {
          id: "initial",
          name: "web_search",
          arguments: JSON.stringify({ query: "topic", fetchContent: true }),
        },
      ],
      hasPendingNonResearchCalls: false,
      signal: controller.signal,
      clientGone: () => true,
      emit,
      streamText,
      withTimeout: (create) => create(controller.signal),
    });

    expect(result.responseText).toBe("");
    expect(streamText.mock.calls.some(([input]) => matrixCall(input))).toBe(
      false,
    );
  });
});
