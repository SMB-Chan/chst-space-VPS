import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  buildArtifactSsePayload,
  persistAndEmitChatCompletion,
} from "./chat-stream-completion";

describe("buildArtifactSsePayload", () => {
  it("prefers committed metadata and only includes content when requested", () => {
    const artifacts = [
      {
        filename: "draft.md",
        mime: "text/markdown",
        content: "# Draft",
        size: 7,
      },
    ];

    expect(
      buildArtifactSsePayload({
        artifacts,
        saved: [
          {
            sourceIndex: 0,
            id: 42,
            filename: "saved.md",
            mime: "text/markdown",
            size: 7,
          },
        ],
        includeContent: false,
      }),
    ).toEqual([
      {
        id: 42,
        filename: "saved.md",
        mime: "text/markdown",
        size: 7,
        downloadUrl: "/api/openai/artifacts/42",
      },
    ]);
  });
});

describe("persistAndEmitChatCompletion", () => {
  it("turns an empty completion into a non-empty SSE fallback", async () => {
    const write = vi.fn();
    const onComplete = vi.fn(async (input: { content: string }) => {
      expect(input.content).toContain("信頼できる最新情報");
      return undefined;
    });

    const completed = await persistAndEmitChatCompletion({
      res: { write } as unknown as Response,
      clientGone: () => false,
      onComplete,
      input: { content: "", sources: [] },
      includeArtifactContent: false,
    });

    expect(completed).toBe(true);
    const output = write.mock.calls.join("");
    expect(output).toContain('"content":"信頼できる最新情報');
    expect(output).toContain('"done":true');
  });

  it("reports persistence failure and does not emit done", async () => {
    const write = vi.fn();
    const completed = await persistAndEmitChatCompletion({
      res: { write } as unknown as Response,
      clientGone: () => false,
      onComplete: async () => {
        throw new Error("database unavailable");
      },
      input: { content: "answer", sources: [] },
      includeArtifactContent: false,
    });

    expect(completed).toBe(false);
    const output = write.mock.calls.join("");
    expect(output).toContain("メッセージの保存に失敗しました");
    expect(output).not.toContain('"done":true');
  });

  it("emits a run receipt with history and web budget outcomes", async () => {
    const write = vi.fn();
    const completed = await persistAndEmitChatCompletion({
      res: { write } as unknown as Response,
      clientGone: () => false,
      onComplete: async () => undefined,
      input: { content: "answer", sources: [] },
      includeArtifactContent: false,
      receipt: { omittedHistoryTurns: 2, omittedWebSections: 1 },
    });

    expect(completed).toBe(true);
    const output = write.mock.calls.join("");
    expect(output).toContain('"receipt"');
    expect(output).toContain('"omittedHistoryTurns":2');
    expect(output).toContain('"omittedWebSections":1');
    expect(output).toContain('"done":true');
  });
});
