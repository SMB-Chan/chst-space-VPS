import { describe, expect, it } from "vitest";
import {
  ATTACHMENTS_V1_PREFIX,
  MAX_IMAGE_BYTES,
  UserMessageContentError,
  fallbackHistoricalUserContent,
  modelContentFor,
  parseUserMessageContent,
} from "./message-content";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngPayload(bytes = 12): Buffer {
  const payload = Buffer.alloc(Math.max(bytes, PNG_SIGNATURE.length), 1);
  PNG_SIGNATURE.copy(payload);
  return payload;
}

function imageDataUrl(bytes = 12): string {
  return `data:image/png;base64,${pngPayload(bytes).toString("base64")}`;
}

describe("parseUserMessageContent", () => {
  it("keeps plain messages as text", () => {
    const parsed = parseUserMessageContent("  調べてください  ");
    expect(parsed.protocol).toBe("plain");
    expect(parsed.question).toBe("調べてください");
    expect(parsed.storedContent).toBe("調べてください");
    expect(modelContentFor(parsed, true)).toBe("調べてください");
  });

  it("rejects whitespace-only messages without attachments", () => {
    expect(() => parseUserMessageContent("   ")).toThrow("メッセージを入力してください");
  });

  it("uses a default prompt for attachment-only messages", () => {
    const parsed = parseUserMessageContent("", [
      { kind: "file", name: "notes.txt", content: "memo", isBase64: false },
    ]);
    expect(parsed.question).toBe("添付ファイルの内容を説明してください。");
  });

  it("parses structured multiple attachments without exposing base64 as text", () => {
    const first = imageDataUrl(16);
    const second = imageDataUrl(24);
    const parsed = parseUserMessageContent("比較して", [
      { kind: "file", name: "notes.md", content: "# memo", isBase64: false },
      { kind: "image", name: "a.png", content: first, isBase64: true },
      { kind: "image", name: "b.png", content: second, isBase64: true },
    ]);

    expect(parsed.question).toBe("比較して");
    expect(parsed.images).toHaveLength(2);
    expect(parsed.modelText).toContain("# memo");
    expect(parsed.modelText).not.toContain("base64");
    const modelContent = modelContentFor(parsed, true);
    expect(Array.isArray(modelContent)).toBe(true);
    expect(modelContent).toEqual([
      { type: "text", text: expect.stringContaining("notes.md") },
      { type: "text", text: "添付画像: a.png" },
      { type: "image_url", image_url: { url: first } },
      { type: "text", text: "添付画像: b.png" },
      { type: "image_url", image_url: { url: second } },
    ]);
    expect(parsed.storedContent.startsWith(ATTACHMENTS_V1_PREFIX)).toBe(true);
  });

  it("parses the existing CS_ATTACHMENTS_V1 storage format", () => {
    const dataUrl = imageDataUrl();
    const content = `${ATTACHMENTS_V1_PREFIX}${JSON.stringify({
      question: "画像は何？",
      attachments: [
        { kind: "image", name: "sample.png", content: dataUrl, isBase64: true },
      ],
    })}`;
    const parsed = parseUserMessageContent(content);
    expect(parsed.question).toBe("画像は何？");
    expect(parsed.images[0]?.content).toBe(dataUrl);
  });

  it("keeps legacy single-image messages readable", () => {
    const dataUrl = imageDataUrl();
    const parsed = parseUserMessageContent(
      `[Image: old.png]\n\n${dataUrl}\n\n---\n\nUser question: 説明して`,
    );
    expect(parsed.protocol).toBe("legacy");
    expect(parsed.question).toBe("説明して");
    expect(parsed.images).toHaveLength(1);
  });

  it("omits historical images for non-vision models", () => {
    const parsed = parseUserMessageContent("説明して", [
      { kind: "image", name: "a.png", content: imageDataUrl(), isBase64: true },
    ]);
    const content = modelContentFor(parsed, false);
    expect(typeof content).toBe("string");
    expect(content).toContain("画像入力非対応");
    expect(content).not.toContain("base64");
  });

  it("rejects unsupported SVG data URLs", () => {
    expect(() =>
      parseUserMessageContent("説明して", [
        {
          kind: "image",
          name: "vector.svg",
          content: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
          isBase64: true,
        },
      ]),
    ).toThrow(UserMessageContentError);
  });


  it("rejects image MIME declarations that do not match the decoded signature", () => {
    const fakePng = `data:image/png;base64,${Buffer.from("GIF89a-not-png").toString("base64")}`;
    expect(() =>
      parseUserMessageContent("説明して", [
        { kind: "image", name: "fake.png", content: fakePng, isBase64: true },
      ]),
    ).toThrow("MIME形式が一致しません");
  });

  it("rejects images over the decoded byte limit", () => {
    const oversized = `data:image/png;base64,${pngPayload(MAX_IMAGE_BYTES + 1).toString("base64")}`;
    try {
      parseUserMessageContent("説明して", [
        { kind: "image", name: "large.png", content: oversized, isBase64: true },
      ]);
      throw new Error("expected parser to reject the image");
    } catch (error) {
      expect(error).toBeInstanceOf(UserMessageContentError);
      expect((error as UserMessageContentError).status).toBe(413);
    }
  });

  it("recovers the question from malformed historical attachment data", () => {
    const content = `${ATTACHMENTS_V1_PREFIX}${JSON.stringify({
      question: "この続きを分析して",
      attachments: [{ name: "bad.png", content: "not-a-data-url", kind: "image" }],
    })}`;
    expect(fallbackHistoricalUserContent(content)).toContain("この続きを分析して");
    expect(fallbackHistoricalUserContent(content)).not.toContain("not-a-data-url");
  });
});
