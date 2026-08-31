import {
  ALIBABA_VIDEO_POLL_INTERVAL_MS,
  type AlibabaVideoTaskStatus,
} from "./alibaba-video";

export const ALIBABA_VIDEO_TASK_TTL_MS = 24 * 60 * 60 * 1_000;

const TERMINAL_STATUSES = new Set<AlibabaVideoTaskStatus>([
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "UNKNOWN",
]);

const ALLOWED_TRANSITIONS: Record<
  AlibabaVideoTaskStatus,
  ReadonlySet<AlibabaVideoTaskStatus>
> = {
  PENDING: new Set([
    "PENDING",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
    "CANCELED",
    "UNKNOWN",
  ]),
  RUNNING: new Set(["RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"]),
  SUCCEEDED: new Set(["SUCCEEDED"]),
  FAILED: new Set(["FAILED"]),
  CANCELED: new Set(["CANCELED"]),
  UNKNOWN: new Set(["UNKNOWN"]),
};

export function isTerminalAlibabaVideoStatus(
  status: AlibabaVideoTaskStatus,
): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function assertAlibabaVideoStatusTransition(
  current: AlibabaVideoTaskStatus,
  next: AlibabaVideoTaskStatus,
): AlibabaVideoTaskStatus {
  if (!ALLOWED_TRANSITIONS[current].has(next)) {
    throw new Error(
      `Invalid Alibaba video status transition: ${current} -> ${next}`,
    );
  }
  return next;
}

export function nextAlibabaVideoPollAt(
  status: AlibabaVideoTaskStatus,
  observedAt: Date,
): Date | null {
  if (isTerminalAlibabaVideoStatus(status)) return null;
  return new Date(observedAt.getTime() + ALIBABA_VIDEO_POLL_INTERVAL_MS);
}

export function alibabaVideoProviderExpiresAt(submittedAt: Date): Date {
  return new Date(submittedAt.getTime() + ALIBABA_VIDEO_TASK_TTL_MS);
}

export function canCancelAlibabaVideoStatus(
  status: AlibabaVideoTaskStatus,
): boolean {
  return status === "PENDING";
}
