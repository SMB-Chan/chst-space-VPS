import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { streamModelText } from "./chat-stream";
import { splitLeadingThink } from "./stream-delta";

describe("splitLeadingThink", () => {
  it("hides an open leading think block and partial opening tags", () => {
    expect(splitLeadingThink("<thi")).toEqual({ visible: "", reasoning: "" });
    expect(splitLeadingThink("\n<think>\nplanning")).toEqual({
      visible: "",
      reasoning: "planning",
    });
  });

  it("returns the answer after a closed leading block", () => {
    expect(splitLeadingThink("<think>\nplan\n</think>\n\nこんにちは")).toEqual({
      visible: "こんにちは",
      reasoning: "plan",
    });
  });

  it("leaves ordinary text and later literal tags alone", () => {
    expect(splitLeadingThink("答え: <think> タグの説明")).toEqual({
      visible: "答え: <think> タグの説明",
      reasoning: "",
    });
    expect(splitLeadingThink("<b>bold</b>").visible).toBe("<b>bold</b>");
  });
});

function chunks(parts: Array<{ content?: string; reasoning?: string }>) {
  return (async function* () {
    for (const delta of parts) {
      yield { choices: [{ delta, finish_reason: null }] };
    }
    yield { choices: [{ delta: {}, finish_reason: "stop" }] };
  })();
}

async function run(parts: Array<{ content?: string; reasoning?: string }>) {
  const create = vi.fn().mockResolvedValue(chunks(parts));
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  const content: string[] = [];
  const reasoning: string[] = [];
  const result = await streamModelText({
    client,
    provider: "custom",
    modelId: "MiniMax-M3",
    reasoningLevel: "off",
    messages: [{ role: "user", content: "hi" }],
    onDelta: (delta, phase) =>
      (phase === "content" ? content : reasoning).push(delta),
    shouldStop: () => false,
  });
  return { result, content: content.join(""), reasoning: reasoning.join("") };
}

describe("streamModelText with inline <think> (MiniMax style)", () => {
  it("never streams the think block as answer text", async () => {
    // MiniMax default: think inline in content, split across chunks, plus a
    // duplicate native `reasoning` field on the same chunks.
    const out = await run([
      { content: "<thi" },
      { content: "nk>\nThe user", reasoning: "The user" },
      { content: " greets.", reasoning: " greets." },
      { content: "\n</think>\n\nこんに" },
      { content: "ちは！" },
    ]);
    expect(out.content).toBe("こんにちは！");
    expect(out.result).toBe("こんにちは！");
    expect(out.content).not.toContain("think");
    // Reported once (native field), not duplicated from the inline copy.
    expect(out.reasoning).toBe("The user greets.");
  });

  it("routes inline think to the reasoning phase when no native field exists", async () => {
    const out = await run([
      { content: "<think>plan" },
      { content: " more</think>答え" },
    ]);
    expect(out.content).toBe("答え");
    expect(out.reasoning).toBe("plan more");
  });

  it("streams plain answers unchanged", async () => {
    const out = await run([{ content: "Hello" }, { content: " world" }]);
    expect(out.content).toBe("Hello world");
    expect(out.result).toBe("Hello world");
  });
});
