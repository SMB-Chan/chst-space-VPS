import { describe, expect, it } from "vitest";
import {
  extractTextToolCalls,
  mergeStreamDelta,
  splitThinkTags,
  visibleTextBeforeToolMarkup,
} from "./stream-delta";

describe("mergeStreamDelta", () => {
  it("appends incremental tokens", () => {
    expect(mergeStreamDelta("", "Hello")).toBe("Hello");
    expect(mergeStreamDelta("Hello", " world")).toBe("Hello world");
  });

  it("replaces when the provider sends the full text so far", () => {
    expect(mergeStreamDelta("Hello", "Hello world")).toBe("Hello world");
    expect(mergeStreamDelta("Hello world", "Hello world")).toBe("Hello world");
  });

  it("keeps the longer prefix when a stale shorter snapshot arrives", () => {
    expect(mergeStreamDelta("Hello world", "Hello")).toBe("Hello world");
  });
});

describe("splitThinkTags", () => {
  it("moves completed think blocks out of the visible answer", () => {
    expect(splitThinkTags("<think>plan</think>\n\nAnswer here")).toEqual({
      reasoning: "plan",
      content: "Answer here",
    });
  });
});

describe("text tool-call compatibility", () => {
  const allowed = new Set(["web_search", "fetch_page"]);

  it("holds a tool tag even when its opening marker is split across chunks", () => {
    expect(visibleTextBeforeToolMarkup("<tool_")).toBe("");
    expect(
      visibleTextBeforeToolMarkup('intro\n<tool_call>{"name":"web_search"}'),
    ).toBe("intro\n");
    expect(visibleTextBeforeToolMarkup("ordinary <text> content")).toBe(
      "ordinary <text> content",
    );
  });

  it("normalizes an advertised textual tool call", () => {
    expect(
      extractTextToolCalls(
        '<tool_call>{"name":"web_search","arguments":{"query":"NVIDIA"}}</tool_call>',
        allowed,
      ),
    ).toEqual({
      content: "",
      calls: [
        {
          id: "text-tool-1",
          name: "web_search",
          arguments: '{"query":"NVIDIA"}',
        },
      ],
      sawToolMarkup: true,
    });
  });

  it("supports nested function payloads and string arguments", () => {
    const result = extractTextToolCalls(
      '<function_call>{"id":"call-7","function":{"name":"fetch_page","arguments":"{\\"url\\":\\"https://example.com\\"}"}}</function_call>',
      allowed,
    );

    expect(result.calls).toEqual([
      {
        id: "call-7",
        name: "fetch_page",
        arguments: '{"url":"https://example.com"}',
      },
    ]);
    expect(result.content).toBe("");
  });

  it("strips but never executes unknown or malformed calls", () => {
    const result = extractTextToolCalls(
      'before<tool_call>{"name":"finance_analysis","arguments":{}}</tool_call>after',
      allowed,
    );

    expect(result).toEqual({
      content: "beforeafter",
      calls: [],
      sawToolMarkup: true,
    });
    expect(extractTextToolCalls("<tool_call>{not-json", allowed)).toEqual({
      content: "",
      calls: [],
      sawToolMarkup: true,
    });
  });
});
