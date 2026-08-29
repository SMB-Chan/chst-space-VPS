import type { NextFunction, Request, Response } from "express";
import { ALIBABA_MODEL_CATALOG } from "../lib/alibaba-capabilities";
import {
  assessAlibabaTokenPlanQuota,
  getAlibabaTokenPlanUsage,
  isAlibabaTokenPlanQuotaFailOpen,
  isAlibabaTokenPlanChatKey,
  isAlibabaTokenPlanQuotaGuardEnabled,
  type AlibabaTokenPlanUsageSnapshot,
} from "../lib/alibaba-token-plan-usage";
import { logger } from "../lib/logger";

const DEFAULT_WARN_LARGE_TURN_REMAINING_PERCENT = 35;
const DEFAULT_BLOCK_LARGE_TURN_REMAINING_PERCENT = 20;

export const TOKEN_PLAN_QUOTA_RESPONSE_HEADERS = {
  weeklyRemaining: "X-Chat-Space-Token-Plan-Weekly-Remaining",
  fiveHourRemaining: "X-Chat-Space-Token-Plan-Five-Hour-Remaining",
  weeklyReset: "X-Chat-Space-Token-Plan-Weekly-Reset",
  fiveHourReset: "X-Chat-Space-Token-Plan-Five-Hour-Reset",
  limitingWindow: "X-Chat-Space-Token-Plan-Limiting-Window",
  limitingRemaining: "X-Chat-Space-Token-Plan-Limiting-Remaining",
} as const;

export type AlibabaLargeTurnQuotaDecision = "allow" | "warn" | "block" | "unknown";

export interface AlibabaTokenPlanTurnEstimate {
  large: boolean;
  tokenPlanCalls: number;
  textChars: number;
  attachmentCount: number;
  imageAttachmentCount: number;
  reasons: string[];
}

export interface AlibabaLargeTurnQuotaAssessment {
  decision: AlibabaLargeTurnQuotaDecision;
  limitingWindow?: "5-hour" | "1-week";
  remainingPercent?: number;
  resetAt?: string;
  warnAt: number;
  blockAt: number;
  reason: string;
}

interface TurnShape {
  rootModelId?: string;
  auditModelId?: string;
  reasoningLevel?: string;
  content?: unknown;
  history?: unknown;
  attachments?: unknown;
  fileFormat?: unknown;
}

function parsePercent(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isTokenPlanChatModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return ALIBABA_MODEL_CATALOG.some(
    (model) => model.id === modelId && model.kind === "chat" && model.transport === "openai-chat",
  );
}

function countText(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.content === "string") total += record.content.length;
    if (typeof record.text === "string") total += record.text.length;
  }
  return total;
}

function countHistoryText(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, item) => {
    if (!item || typeof item !== "object") return total;
    return total + countText((item as Record<string, unknown>).content);
  }, 0);
}

function attachmentStats(value: unknown): { count: number; images: number } {
  if (!Array.isArray(value)) return { count: 0, images: 0 };
  let count = 0;
  let images = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    count += 1;
    const record = item as Record<string, unknown>;
    const kind = nonEmptyString(record.kind);
    const name = nonEmptyString(record.name) ?? "";
    if (kind === "image" || /\.(?:png|jpe?g|webp|gif)$/i.test(name)) images += 1;
  }
  return { count, images };
}

/**
 * Estimate whether a chat turn is large enough to justify an early Token Plan
 * quota preflight before web search, vision bridging, audit, or file-generation
 * work starts. This deliberately estimates only Token Plan chat usage; regular
 * Model Studio specialist media billing is a separate budget domain.
 */
export function estimateAlibabaTokenPlanTurn(input: TurnShape): AlibabaTokenPlanTurnEstimate {
  const rootUsesTokenPlan = isTokenPlanChatModel(input.rootModelId);
  const auditUsesTokenPlan =
    input.auditModelId !== input.rootModelId && isTokenPlanChatModel(input.auditModelId);
  const tokenPlanCalls = Number(rootUsesTokenPlan) + Number(auditUsesTokenPlan);
  const textChars = countText(input.content) + countHistoryText(input.history);
  const attachments = attachmentStats(input.attachments);
  const highReasoning = input.reasoningLevel === "high";
  const explicitFileGeneration =
    rootUsesTokenPlan && typeof input.fileFormat === "string" && input.fileFormat.trim().length > 0;

  const reasons: string[] = [];
  if (rootUsesTokenPlan && textChars >= 20_000) reasons.push("long-context");
  if (rootUsesTokenPlan && highReasoning && textChars >= 4_000) {
    reasons.push("high-reasoning-context");
  }
  if (rootUsesTokenPlan && attachments.images >= 2) reasons.push("multi-image");
  if (rootUsesTokenPlan && attachments.count >= 3) reasons.push("multi-attachment");
  if (explicitFileGeneration) reasons.push("file-generation");
  // Two separate Token Plan model calls in one turn (for example answer +
  // Alibaba audit model) merit a higher reserve even when each prompt is short.
  if (rootUsesTokenPlan && auditUsesTokenPlan) reasons.push("multi-model-turn");

  return {
    large: reasons.length > 0,
    tokenPlanCalls,
    textChars,
    attachmentCount: attachments.count,
    imageAttachmentCount: attachments.images,
    reasons,
  };
}

export function assessAlibabaLargeTurnQuota(
  snapshot: AlibabaTokenPlanUsageSnapshot | null,
  env: NodeJS.ProcessEnv = process.env,
): AlibabaLargeTurnQuotaAssessment {
  const base = assessAlibabaTokenPlanQuota(snapshot, false, env);
  const blockAt = parsePercent(
    env.ALIBABA_TOKEN_PLAN_BLOCK_LARGE_TURN_REMAINING_PERCENT,
    DEFAULT_BLOCK_LARGE_TURN_REMAINING_PERCENT,
  );
  const warnAt = Math.max(
    blockAt,
    parsePercent(
      env.ALIBABA_TOKEN_PLAN_WARN_LARGE_TURN_REMAINING_PERCENT,
      DEFAULT_WARN_LARGE_TURN_REMAINING_PERCENT,
    ),
  );

  if (base.decision === "unknown" || base.remainingPercent === undefined) {
    return { decision: "unknown", warnAt, blockAt, reason: base.reason };
  }
  const common = {
    limitingWindow: base.limitingWindow,
    remainingPercent: base.remainingPercent,
    resetAt: base.resetAt,
    warnAt,
    blockAt,
    reason: base.reason,
  };
  if (base.remainingPercent <= blockAt) return { decision: "block", ...common };
  if (base.remainingPercent <= warnAt) return { decision: "warn", ...common };
  return { decision: "allow", ...common };
}

/** Safe browser-visible telemetry only; no console/model credential is exposed. */
export function tokenPlanQuotaHeaders(
  snapshot: AlibabaTokenPlanUsageSnapshot | null,
): Record<string, string> {
  if (
    !snapshot ||
    snapshot.weeklyRemainingPercent === undefined ||
    snapshot.fiveHourRemainingPercent === undefined
  ) {
    return {};
  }
  const headers: Record<string, string> = {};
  if (snapshot.weeklyRemainingPercent !== undefined) {
    headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.weeklyRemaining] =
      snapshot.weeklyRemainingPercent.toFixed(1);
  }
  if (snapshot.fiveHourRemainingPercent !== undefined) {
    headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.fiveHourRemaining] =
      snapshot.fiveHourRemainingPercent.toFixed(1);
  }
  if (snapshot.weeklyResetAt) {
    headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.weeklyReset] = snapshot.weeklyResetAt;
  }
  if (snapshot.fiveHourResetAt) {
    headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.fiveHourReset] = snapshot.fiveHourResetAt;
  }
  const limiting = assessAlibabaTokenPlanQuota(snapshot, false);
  if (limiting.limitingWindow) {
    headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.limitingWindow] = limiting.limitingWindow;
  }
  if (limiting.remainingPercent !== undefined) {
    headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.limitingRemaining] =
      limiting.remainingPercent.toFixed(1);
  }
  return headers;
}

function quotaWindowLabel(window: "5-hour" | "1-week" | undefined): string {
  return window === "5-hour" ? "5時間枠" : "週間枠";
}

function formatResetAt(resetAt: string | undefined): string | undefined {
  if (!resetAt) return undefined;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function blockedMessage(assessment: AlibabaLargeTurnQuotaAssessment): string {
  if (assessment.remainingPercent === undefined) {
    return (
      "Alibaba Token Plan の残量を確認できないため、クォータ保護のため大きな処理は開始しません。" +
      "時間を置いて再試行するか、運用設定で明示的にfail-openを許可してください。"
    );
  }
  const remaining = assessment.remainingPercent?.toFixed(1) ?? "不明";
  const reset = formatResetAt(assessment.resetAt);
  return (
    `Alibaba Token Plan の${quotaWindowLabel(assessment.limitingWindow)}残量が ${remaining}% のため、` +
    `クォータ保護のため大きな処理は開始しません。` +
    (reset ? ` リセット予定は ${reset} JST です。` : "") +
    " 処理を軽くするか、クォータ回復後に再試行してください。"
  );
}

function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * Add cached Token Plan quota telemetry to the existing authenticated model-list
 * response. This avoids a separate quota API surface while letting the UI show
 * the weekly/five-hour fuel gauge before a user starts a large turn.
 */
export async function tokenPlanQuotaStatusHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    !isAlibabaTokenPlanQuotaGuardEnabled(process.env) ||
    !isAlibabaTokenPlanChatKey(process.env.DASHSCOPE_API_KEY)
  ) {
    next();
    return;
  }
  try {
    const snapshot = await getAlibabaTokenPlanUsage(process.env);
    for (const [name, value] of Object.entries(tokenPlanQuotaHeaders(snapshot))) {
      res.setHeader(name, value);
    }
  } catch (error) {
    logger.warn({ err: error }, "Token Plan model-list quota telemetry failed open");
  }
  next();
}

/**
 * Authenticated chat-message preflight. It runs after the bounded JSON parser
 * but before the OpenAI route, so a critical Token Plan reserve can prevent
 * expensive downstream work from starting at all.
 */
export async function tokenPlanQuotaPreflightGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    !isAlibabaTokenPlanQuotaGuardEnabled(process.env) ||
    !isAlibabaTokenPlanChatKey(process.env.DASHSCOPE_API_KEY)
  ) {
    next();
    return;
  }

  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const estimate = estimateAlibabaTokenPlanTurn({
    rootModelId: nonEmptyString(body.modelId) ?? queryString(req.query.model),
    auditModelId: queryString(req.query.auditModel),
    reasoningLevel: queryString(req.query.reasoning),
    content: body.content,
    history: body.history,
    attachments: body.attachments,
    fileFormat: body.fileFormat,
  });

  if (!estimate.large || estimate.tokenPlanCalls === 0) {
    next();
    return;
  }

  try {
    const snapshot = await getAlibabaTokenPlanUsage(process.env);
    const assessment = assessAlibabaLargeTurnQuota(snapshot, process.env);
    if (assessment.decision === "unknown") {
      logger.warn(
        { reasons: estimate.reasons, tokenPlanCalls: estimate.tokenPlanCalls },
        "Large Token Plan turn is proceeding because quota telemetry is unavailable",
      );
      next();
      return;
    }

    if (assessment.remainingPercent !== undefined) {
      res.setHeader(
        "X-Chat-Space-Token-Plan-Remaining",
        assessment.remainingPercent.toFixed(1),
      );
    }
    if (assessment.limitingWindow) {
      res.setHeader("X-Chat-Space-Token-Plan-Window", assessment.limitingWindow);
    }

    if (assessment.decision === "block") {
      logger.warn(
        {
          reasons: estimate.reasons,
          tokenPlanCalls: estimate.tokenPlanCalls,
          remainingPercent: assessment.remainingPercent,
          limitingWindow: assessment.limitingWindow,
          resetAt: assessment.resetAt,
        },
        "Blocked large Token Plan turn before downstream processing",
      );
      res.status(429).json({ error: blockedMessage(assessment) });
      return;
    }

    if (assessment.decision === "warn") {
      logger.warn(
        {
          reasons: estimate.reasons,
          tokenPlanCalls: estimate.tokenPlanCalls,
          remainingPercent: assessment.remainingPercent,
          limitingWindow: assessment.limitingWindow,
          resetAt: assessment.resetAt,
        },
        "Large Token Plan turn is approaching the configured reserve",
      );
    }
    next();
  } catch {
    if (isAlibabaTokenPlanQuotaFailOpen(process.env)) {
      logger.warn(
        { reasons: estimate.reasons },
        "Token Plan large-turn preflight is using the explicit fail-open override",
      );
      next();
      return;
    }
    logger.warn(
      { reasons: estimate.reasons },
      "Token Plan large-turn preflight blocked because quota telemetry is unavailable",
    );
    res.status(503).json({
      error:
        "Alibaba Token Plan の残量を確認できないため、クォータ保護のため大きな処理は開始しません。",
    });
  }
}