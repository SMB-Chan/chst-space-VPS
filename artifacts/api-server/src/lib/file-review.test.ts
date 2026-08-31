import { describe, it, expect, vi } from "vitest";
import {
  buildLayoutReviewPrompt,
  getVisionClient,
  hasActionableFeedback,
  reviewLayout,
} from "./file-review";

describe("getVisionClient", () => {
  it("returns the requested model when it supports vision", () => {
    const result = getVisionClient("o4-mini");
    expect(result.modelId).toBe("o4-mini");
  });

  it("falls back to a vision model when the requested model does not support vision", () => {
    const result = getVisionClient("deepseek-v4-pro");
    expect(result.modelId).not.toBe("deepseek-v4-pro");
    expect(result.modelId).toMatch(/^gpt-5\.6-terra$/);
  });

  it("falls back to a vision model when no model is provided", () => {
    const result = getVisionClient();
    expect(result.modelId).toMatch(/^gpt-5\.6-terra$/);
  });
});

describe("buildLayoutReviewPrompt", () => {
  it("mentions the format and page count", () => {
    const prompt = buildLayoutReviewPrompt("pdf", 3);
    expect(prompt).toContain("PDF");
    expect(prompt).toContain("3 preview image");
    expect(prompt).toContain("NO_ISSUES");
  });

  it("uses the correct format name for Excel", () => {
    const prompt = buildLayoutReviewPrompt("xlsx", 1);
    expect(prompt).toContain("Excel");
  });
});

describe("hasActionableFeedback", () => {
  it("returns false for NO_ISSUES", () => {
    expect(hasActionableFeedback("NO_ISSUES")).toBe(false);
  });

  it("returns false for Japanese no-issue markers", () => {
    expect(hasActionableFeedback("問題なし")).toBe(false);
    expect(hasActionableFeedback("問題は見つかりませんでした")).toBe(false);
  });

  it("returns true for actionable feedback", () => {
    expect(hasActionableFeedback("1. Increase font size\n2. Add margins")).toBe(
      true,
    );
  });

  it("returns false for empty feedback", () => {
    expect(hasActionableFeedback("")).toBe(false);
    expect(hasActionableFeedback("   ")).toBe(false);
  });
});

describe("reviewLayout", () => {
  it("calls the vision model with images and returns the response text", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "NO_ISSUES" } }],
    });
    const mockClient = {
      chat: { completions: { create: mockCreate } },
    } as unknown as import("openai").default;

    const images = [Buffer.from("fake-png")];
    const result = await reviewLayout({
      client: mockClient,
      modelId: "gpt-5.6-terra",
      format: "pdf",
      images,
      originalData: "{}",
    });

    expect(result).toBe("NO_ISSUES");
    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe("gpt-5.6-terra");
    expect(call.messages[0].role).toBe("user");
    const content = call.messages[0].content as Array<{ type: string }>;
    expect(content.some((part) => part.type === "image_url")).toBe(true);
    expect(content.some((part) => part.type === "text")).toBe(true);
  });

  it("propagates API errors so the caller can log the request context", async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error("API down"));
    const mockClient = {
      chat: { completions: { create: mockCreate } },
    } as unknown as import("openai").default;

    await expect(
      reviewLayout({
        client: mockClient,
        modelId: "gpt-5.6-terra",
        format: "pdf",
        images: [Buffer.from("fake-png")],
      }),
    ).rejects.toThrow("API down");
  });
});
