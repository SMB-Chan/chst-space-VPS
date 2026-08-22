import { describe, expect, it } from "vitest";
import { parseUserMessageContent } from "./message-content";
import {
  createHistoricalImageBudget,
  modelContentForHistorical,
  type HistoricalImageBudget,
} from "./historical-image-budget";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function imageDataUrl(bytes: number): string {
  const payload = Buffer.alloc(Math.max(bytes, PNG_SIGNATURE.length), 1);
  PNG_SIGNATURE.copy(payload);
  return `data:image/png;base64,${payload.toString("base64")}`;
}

function imageNames(content: ReturnType<typeof modelContentForHistorical>): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part.type === "image_url")
    .map((part) => part.image_url.url);
}

describe("historical image replay budget", () => {
  it("uses a fixed default budget", () => {
    const budget = createHistoricalImageBudget();
    expect(budget.remainingBytes).toBe(10 * 1024 * 1024);
    expect(budget.remainingImages).toBe(4);
  });

  it("keeps images that fit and explicitly omits overflow", () => {
    const first = imageDataUrl(12);
    const second = imageDataUrl(13);
    const parsed = parseUserMessageContent("比較して", [
      { kind: "image", name: "newer.png", content: first, isBase64: true },
      { kind: "image", name: "overflow.png", content: second, isBase64: true },
    ]);
    const budget: HistoricalImageBudget = {
      remainingBytes: 16,
      remainingImages: 1,
    };

    const content = modelContentForHistorical(parsed, true, budget);
    expect(imageNames(content)).toEqual([first]);
    expect(JSON.stringify(content)).not.toContain(second);
    expect(JSON.stringify(content)).toContain("overflow.png");
    expect(JSON.stringify(content)).toContain("画像再送上限");
    expect(budget.remainingBytes).toBe(4);
    expect(budget.remainingImages).toBe(0);
  });

  it("prioritizes newer messages when callers walk history newest-first", () => {
    const newerImage = imageDataUrl(12);
    const olderImage = imageDataUrl(13);
    const newer = parseUserMessageContent("新しい画像", [
      { kind: "image", name: "newer.png", content: newerImage, isBase64: true },
    ]);
    const older = parseUserMessageContent("古い画像", [
      { kind: "image", name: "older.png", content: olderImage, isBase64: true },
    ]);
    const budget: HistoricalImageBudget = {
      remainingBytes: 12,
      remainingImages: 1,
    };

    const newerContent = modelContentForHistorical(newer, true, budget);
    const olderContent = modelContentForHistorical(older, true, budget);

    expect(imageNames(newerContent)).toEqual([newerImage]);
    expect(imageNames(olderContent)).toEqual([]);
    expect(String(olderContent)).toContain("older.png");
    expect(String(olderContent)).not.toContain(olderImage);
  });

  it("does not consume the image budget for non-vision models", () => {
    const parsed = parseUserMessageContent("説明して", [
      { kind: "image", name: "a.png", content: imageDataUrl(12), isBase64: true },
    ]);
    const budget: HistoricalImageBudget = {
      remainingBytes: 12,
      remainingImages: 1,
    };

    const content = modelContentForHistorical(parsed, false, budget);
    expect(typeof content).toBe("string");
    expect(String(content)).toContain("画像入力非対応");
    expect(budget).toEqual({ remainingBytes: 12, remainingImages: 1 });
  });
});