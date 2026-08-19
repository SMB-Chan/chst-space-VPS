import type { Response } from "express";
import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const returning = vi.fn();
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return {
    insert,
    values,
    returning,
    previewGeneratedFile: vi.fn(),
    reviewLayout: vi.fn(),
  };
});

vi.mock("@workspace/db", () => ({
  db: { insert: mocks.insert },
  assets: {},
}));

vi.mock("./file-preview", () => ({
  getPreviewToolStatus: vi.fn().mockResolvedValue({
    libreoffice: true,
    pdftocairo: true,
    available: true,
  }),
  previewGeneratedFile: mocks.previewGeneratedFile,
}));

vi.mock("./file-review", () => ({
  getVisionClient: vi.fn(() => ({ client: {}, modelId: "vision-test" })),
  hasActionableFeedback: vi.fn(() => false),
  reviewLayout: mocks.reviewLayout,
}));

import { generateAndReviewFile } from "./chat-stream";

async function* modelFileOutput(): AsyncGenerator<{
  choices: { delta: { content: string } }[];
}> {
  yield {
    choices: [
      {
        delta: {
          content:
            '<file_data>{"title":"Review fallback","content":"# Body\\n\\nStill saved."}</file_data>',
        },
      },
    ],
  };
}

describe("generateAndReviewFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.previewGeneratedFile.mockResolvedValue([Buffer.from("preview")]);
    mocks.reviewLayout.mockRejectedValue(new Error("Vision API unavailable"));
    mocks.returning.mockResolvedValue([
      {
        id: 42,
        filename: "Review fallback.pdf",
        mimeType: "application/pdf",
      },
    ]);
  });

  it("persists and emits the rendered asset when optional layout review fails", async () => {
    const write = vi.fn();
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(modelFileOutput()),
        },
      },
    } as unknown as OpenAI;

    const assetIds = await generateAndReviewFile({
      res: { write } as unknown as Response,
      client,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      reasoningLevel: "off",
      fileFormat: "pdf",
      conversationId: 7,
      userText: "Create a PDF",
      chatMessages: [],
      fullResponse: "Creating the requested PDF.",
      clientGone: false,
      requestId: "request-test",
    });

    expect(mocks.previewGeneratedFile).toHaveBeenCalledOnce();
    expect(mocks.reviewLayout).toHaveBeenCalledOnce();
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 7,
        mimeType: "application/pdf",
        data: expect.any(String),
      }),
    );
    expect(assetIds).toEqual([42]);

    const sse = write.mock.calls.map(([payload]) => String(payload)).join("");
    expect(sse).toContain('"file":{"id":42');
    expect(sse).not.toContain('"status":"file_warning"');
  });
});