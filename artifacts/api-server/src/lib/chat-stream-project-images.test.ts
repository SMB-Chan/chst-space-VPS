import { describe, expect, it } from "vitest";
import { attachProjectImagesToLastUserTurn } from "./chat-stream";

const image = { filename: "看板.jpg", dataUrl: "data:image/jpeg;base64,AAAA" };

describe("attachProjectImagesToLastUserTurn", () => {
  it("appends images after the user's text in the latest user turn", () => {
    const messages: Parameters<typeof attachProjectImagesToLastUserTurn>[0] = [
      { role: "user", content: "前の質問" },
      { role: "assistant", content: "回答" },
      { role: "user", content: "値段は？" },
      { role: "system", content: "project context" },
    ];
    expect(attachProjectImagesToLastUserTurn(messages, [image])).toBe(true);
    expect(messages[0]).toEqual({ role: "user", content: "前の質問" });
    const parts = messages[2]?.content as Array<Record<string, any>>;
    expect(parts[0]).toEqual({ type: "text", text: "値段は？" });
    expect(parts[1]?.text).toContain("看板.jpg");
    expect(parts[2]).toEqual({
      type: "image_url",
      image_url: { url: image.dataUrl },
    });
    expect(messages[3]).toEqual({ role: "system", content: "project context" });
  });

  it("keeps existing parts and is a no-op without images or user turns", () => {
    const messages: Parameters<typeof attachProjectImagesToLastUserTurn>[0] = [
      {
        role: "user",
        content: [
          { type: "text", text: "これ" },
          { type: "image_url", image_url: { url: "data:image/png;base64,B" } },
        ],
      },
    ];
    attachProjectImagesToLastUserTurn(messages, [image]);
    expect((messages[0]?.content as unknown[]).length).toBe(4);
    expect(attachProjectImagesToLastUserTurn(messages, [])).toBe(false);
    expect(
      attachProjectImagesToLastUserTurn(
        [{ role: "system", content: "x" }],
        [image],
      ),
    ).toBe(false);
  });
});
