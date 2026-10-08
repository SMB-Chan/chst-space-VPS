import { describe, expect, it } from "vitest";
import {
  TOOL_BANK_POLICY,
  TOOL_BANK_POLICY_DOC_JA,
} from "./tool-bank-policy";

describe("TOOL_BANK_POLICY", () => {
  it("documents the lifecycle in numeric constants", () => {
    expect(TOOL_BANK_POLICY.ARCHIVE_IDLE_DAYS).toBe(90);
    expect(TOOL_BANK_POLICY.PURGE_SOFT_DELETE_DAYS).toBe(30);
    expect(TOOL_BANK_POLICY.PURGE_ARCHIVED_IDLE_DAYS).toBe(180);
  });

  it("caps payload sizes to keep messages under LLM context budgets", () => {
    expect(TOOL_BANK_POLICY.MAX_CODE_CHARS).toBe(40_000);
    expect(TOOL_BANK_POLICY.MAX_SUMMARY_CHARS).toBe(2_000);
    expect(TOOL_BANK_POLICY.MAX_CODE_CHARS).toBeGreaterThan(
      TOOL_BANK_POLICY.MAX_SUMMARY_CHARS,
    );
  });
});

describe("TOOL_BANK_POLICY_DOC_JA", () => {
  it("covers every lifecycle transition the store API implements", () => {
    for (const heading of [
      "納入",
      "コピー",
      "更新してよい条件",
      "非推奨",
      "削除",
    ]) {
      expect(TOOL_BANK_POLICY_DOC_JA).toContain(heading);
    }
  });

  it("matches the live numeric constants", () => {
    expect(TOOL_BANK_POLICY_DOC_JA).toContain(String(TOOL_BANK_POLICY.ARCHIVE_IDLE_DAYS));
    expect(TOOL_BANK_POLICY_DOC_JA).toContain(String(TOOL_BANK_POLICY.PURGE_SOFT_DELETE_DAYS));
  });
});
