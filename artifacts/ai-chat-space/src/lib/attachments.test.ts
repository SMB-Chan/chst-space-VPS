import { describe, expect, it } from "vitest";
import {
  ATTACHMENTS_V1_PREFIX,
  compactAttachmentMessageForHistory,
  parseAttachmentMessageForDisplay,
  serializeAttachmentMessage,
} from "./attachments";

describe("attachment message storage format", () => {
  it("round-trips multiple attachment chips without exposing their contents", () => {
    const stored = serializeAttachmentMessage("比較して", [
      {
        name: "diagram.png",
        content: "data:image/png;base64,AAAA",
        isBase64: true,
      },
      { name: "notes.md", content: "# Notes", isBase64: false },
    ]);

    expect(stored.startsWith(ATTACHMENTS_V1_PREFIX)).toBe(true);
    expect(parseAttachmentMessageForDisplay(stored)).toEqual({
      displayContent: "比較して",
      attachments: [
        { kind: "image", name: "diagram.png" },
        { kind: "file", name: "notes.md" },
      ],
    });
  });

  it("returns plain messages unchanged", () => {
    expect(parseAttachmentMessageForDisplay("通常の質問")).toEqual({
      displayContent: "通常の質問",
      attachments: [],
    });
  });

  it("keeps binary documents/audio as file chips even though they are base64", () => {
    const stored = serializeAttachmentMessage("要約して", [
      {
        name: "report.pdf",
        content: "data:application/pdf;base64,AAAA",
        isBase64: true,
        kind: "file",
      },
      {
        name: "memo.mp3",
        content: "data:audio/mpeg;base64,AAAA",
        isBase64: true,
        kind: "file",
      },
    ]);
    expect(parseAttachmentMessageForDisplay(stored)).toEqual({
      displayContent: "要約して",
      attachments: [
        { kind: "file", name: "report.pdf" },
        { kind: "file", name: "memo.mp3" },
      ],
    });
  });

  it("compacts private history without resending attachment payloads", () => {
    const stored = serializeAttachmentMessage("比較して", [
      {
        name: "diagram.png",
        content: "data:image/png;base64,SECRET",
        isBase64: true,
      },
      { name: "notes.md", content: "secret text", isBase64: false },
    ]);
    const compact = compactAttachmentMessageForHistory(stored);
    expect(compact).toContain("比較して");
    expect(compact).toContain("diagram.png");
    expect(compact).toContain("notes.md");
    expect(compact).not.toContain("SECRET");
    expect(compact).not.toContain("secret text");
  });

  it("does not render malformed envelope data as chat text", () => {
    expect(
      parseAttachmentMessageForDisplay(`${ATTACHMENTS_V1_PREFIX}{broken`)
        .displayContent,
    ).toBe("添付メッセージを表示できませんでした。");
  });

  it("keeps the legacy single-attachment display format readable", () => {
    const legacy = "[File: memo.txt]\n\nbody\n\n---\n\nUser question: 要約して";
    expect(parseAttachmentMessageForDisplay(legacy)).toEqual({
      displayContent: "要約して",
      attachments: [{ kind: "file", name: "memo.txt" }],
    });
  });
});
