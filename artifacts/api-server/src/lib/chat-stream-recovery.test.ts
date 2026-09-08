import { describe, expect, it } from "vitest";
import {
  auditRequestsWebRecovery,
  isCurrentInformationQuestion,
  isWebCapabilityRefusal,
  shouldRecoverWithWeb,
} from "./chat-stream-recovery";

describe("chat stream web recovery", () => {
  it("recognizes the current-news capability refusal regression", () => {
    const question = "今日のニュースについて分かるか？";
    const answer = "Web検索機能がないため、最新ニュースは分かりません。";

    expect(isCurrentInformationQuestion(question)).toBe(true);
    expect(isWebCapabilityRefusal(answer)).toBe(true);
    expect(
      shouldRecoverWithWeb({ question, answer, translationMode: false }),
    ).toBe(true);
  });

  it("accepts an explicit structured audit recovery request", () => {
    expect(
      auditRequestsWebRecovery(
        JSON.stringify({
          note: "最新情報なのでWeb検索して再回答すべきです。",
          recover_with_web_search: true,
          operations: [],
        }),
      ),
    ).toBe(true);
  });

  it("does not start network recovery from free-form or negative audit prose", () => {
    expect(
      auditRequestsWebRecovery(
        JSON.stringify({
          note: "Web検索は必要ないため、初稿を維持します。",
          recover_with_web_search: false,
          operations: [],
        }),
      ),
    ).toBe(false);
    expect(auditRequestsWebRecovery("Web検索して再回答すべきです。")).toBe(
      false,
    );
    expect(auditRequestsWebRecovery("not-json")).toBe(false);
  });

  it("does not recover translation turns", () => {
    expect(
      shouldRecoverWithWeb({
        question: "今日のニュースについて分かるか？",
        answer: "Web検索機能がないため、分かりません。",
        audit: '{"recover_with_web_search":true}',
        translationMode: true,
      }),
    ).toBe(false);
  });

  it("keeps ordinary answers out of recovery", () => {
    expect(
      shouldRecoverWithWeb({
        question: "TypeScriptの型について教えて",
        answer: "型注釈は値の型を明示するために使います。",
        translationMode: false,
      }),
    ).toBe(false);
  });
});
