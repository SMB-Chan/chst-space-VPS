import { describe, expect, it } from "vitest";
import {
  DeleteOpenaiMessagesBody,
  SendOpenaiMessageBody,
  UpdateOpenaiConversationBody,
} from "@workspace/api-zod";

describe("OpenAPI-generated request schemas", () => {
  it("accepts an attachment-only message and supported file formats", () => {
    expect(
      SendOpenaiMessageBody.safeParse({
        content: "",
        attachments: [{ kind: "file", name: "notes.md", content: "# memo" }],
        fileFormat: "pdf",
      }).success,
    ).toBe(true);
  });

  it("rejects unsupported attachment kinds and file formats", () => {
    expect(
      SendOpenaiMessageBody.safeParse({
        content: "question",
        attachments: [{ kind: "binary", name: "x.bin", content: "x" }],
      }).success,
    ).toBe(false);
    expect(
      SendOpenaiMessageBody.safeParse({
        content: "question",
        fileFormat: "zip",
      }).success,
    ).toBe(false);
  });

  it("enforces rename and message-delete bounds", () => {
    expect(
      UpdateOpenaiConversationBody.safeParse({ title: "x".repeat(81) }).success,
    ).toBe(false);
    expect(DeleteOpenaiMessagesBody.safeParse({ ids: [1, 2] }).success).toBe(
      true,
    );
    expect(DeleteOpenaiMessagesBody.safeParse({ ids: [0] }).success).toBe(
      false,
    );
  });
});
