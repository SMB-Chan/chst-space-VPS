import { describe, expect, it } from "vitest";
import {
  ALIBABA_VIDEO_TASK_TTL_MS,
  alibabaVideoProviderExpiresAt,
  assertAlibabaVideoStatusTransition,
  canCancelAlibabaVideoStatus,
  isTerminalAlibabaVideoStatus,
  nextAlibabaVideoPollAt,
} from "./alibaba-video-job-state";

describe("Alibaba video durable job state", () => {
  it("allows documented provider progress and idempotent observations", () => {
    expect(assertAlibabaVideoStatusTransition("PENDING", "RUNNING")).toBe("RUNNING");
    expect(assertAlibabaVideoStatusTransition("RUNNING", "SUCCEEDED")).toBe("SUCCEEDED");
    expect(assertAlibabaVideoStatusTransition("RUNNING", "RUNNING")).toBe("RUNNING");
    expect(assertAlibabaVideoStatusTransition("PENDING", "FAILED")).toBe("FAILED");
  });

  it("prevents terminal jobs from being reopened", () => {
    expect(() => assertAlibabaVideoStatusTransition("SUCCEEDED", "RUNNING"))
      .toThrow(/Invalid Alibaba video status transition/);
    expect(() => assertAlibabaVideoStatusTransition("FAILED", "PENDING"))
      .toThrow(/Invalid Alibaba video status transition/);
    expect(() => assertAlibabaVideoStatusTransition("CANCELED", "SUCCEEDED"))
      .toThrow(/Invalid Alibaba video status transition/);
  });

  it("treats UNKNOWN as terminal because provider task IDs expire", () => {
    expect(isTerminalAlibabaVideoStatus("UNKNOWN")).toBe(true);
    expect(nextAlibabaVideoPollAt("UNKNOWN", new Date(0))).toBeNull();
  });

  it("uses the documented 15-second polling interval", () => {
    const observedAt = new Date("2026-08-27T00:00:00.000Z");
    expect(nextAlibabaVideoPollAt("PENDING", observedAt)?.toISOString())
      .toBe("2026-08-27T00:00:15.000Z");
    expect(nextAlibabaVideoPollAt("RUNNING", observedAt)?.toISOString())
      .toBe("2026-08-27T00:00:15.000Z");
  });

  it("records the provider's 24-hour task/result lifetime", () => {
    const submittedAt = new Date("2026-08-27T00:00:00.000Z");
    expect(ALIBABA_VIDEO_TASK_TTL_MS).toBe(86_400_000);
    expect(alibabaVideoProviderExpiresAt(submittedAt).toISOString())
      .toBe("2026-08-28T00:00:00.000Z");
  });

  it("only offers provider cancellation while a task is pending", () => {
    expect(canCancelAlibabaVideoStatus("PENDING")).toBe(true);
    expect(canCancelAlibabaVideoStatus("RUNNING")).toBe(false);
    expect(canCancelAlibabaVideoStatus("SUCCEEDED")).toBe(false);
  });
});