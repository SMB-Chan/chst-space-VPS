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

import {
  partitionSpecialistToolCalls,
  runResearchLoop,
} from "./chat-stream-research";

describe("partitionSpecialistToolCalls", () => {
  it("separates research calls and suppresses memory mutations during research", () => {
    const calls = [
      { id: "1", name: "web_search", arguments: "{}" },
      { id: "2", name: "memory_store", arguments: "{}" },
      { id: "3", name: "memory_forget", arguments: "{}" },
      { id: "4", name: "generate_image", arguments: "{}" },
    ];

    expect(partitionSpecialistToolCalls(calls)).toEqual({
      researchCalls: [calls[0]],
      nonResearchCalls: [calls[3]],
    });
  });

  it("keeps a standalone memory mutation outside a research turn", () => {
    const memory = { id: "1", name: "memory_store", arguments: "{}" };
    expect(partitionSpecialistToolCalls([memory])).toEqual({
      researchCalls: [],
      nonResearchCalls: [memory],
    });
  });
});

describe("runResearchLoop", () => {
  it("does not synthesize a final answer before a pending specialist call", async () => {
    mocks.executeSpecialistTool.mockResolvedValueOnce({
      ok: true,
      capability: "web_search",
      summary: "done",
      text: "evidence",
    });
    const streamText = vi.fn().mockResolvedValue("");
    const controller = new AbortController();

    await runResearchLoop({
      client: {} as never,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      reasoningLevel: "off",
      messages: [],
      tools: [],
      initialCalls: [{ id: "1", name: "web_search", arguments: "{}" }],
      hasPendingNonResearchCalls: true,
      signal: controller.signal,
      clientGone: () => false,
      emit: vi.fn(),
      streamText,
      withTimeout: (create) => create(controller.signal),
    });

    expect(streamText).toHaveBeenCalledTimes(1);
  });
});

describe("research citation continuity", () => {
  it("renumbers new evidence after initial web sources", async () => {
    const initial = { title: "Initial", url: "https://example.com/initial" };
    const added = { title: "Added", url: "https://example.org/added" };
    mocks.executeSpecialistTool.mockResolvedValueOnce({
      ok: true,
      capability: "web_search",
      summary: "done",
      text: "[1] Added evidence",
      sources: [added],
    });
    const controller = new AbortController();
    const research = await runResearchLoop({
      client: {} as never,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      reasoningLevel: "off",
      messages: [],
      tools: [],
      initialSources: [initial],
      initialCalls: [{ id: "1", name: "web_search", arguments: "{}" }],
      hasPendingNonResearchCalls: true,
      signal: controller.signal,
      clientGone: () => false,
      emit: vi.fn(),
      streamText: vi.fn().mockResolvedValue("Answer [2]"),
      withTimeout: (create) => create(controller.signal),
    });
    expect(research.sources).toEqual([initial, added]);
    expect(research.evidenceParts).toEqual(["[2] Added evidence"]);
  });
});
