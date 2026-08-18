import { describe, expect, it } from "vitest";
import { buildAuditUserMessage } from "./audit";

describe("buildAuditUserMessage", () => {
  it("includes question and answer and no prior turns", () => {
    const text = buildAuditUserMessage({
      question: "日経平均は高い？",
      answer: "昨日比で上昇しています。",
      sourceText: "日経平均 39000",
    });
    expect(text).toContain("日経平均は高い？");
    expect(text).toContain("昨日比で上昇しています。");
    expect(text).toContain("日経平均 39000");
    expect(text).not.toContain("前回の会話");
  });
});
