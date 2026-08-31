function errorMessage(err: unknown): string {
  return err instanceof Error
    ? err.message
    : typeof err === "string"
      ? err
      : "";
}

function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && !seen.has(current) && chain.length < 4) {
    chain.push(current);
    seen.add(current);
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return chain;
}

/**
 * Failures that are safe to retry before a streamed response has emitted any
 * user-visible text. Authentication, validation, and quota failures are
 * intentionally excluded because another request cannot repair them.
 */
export function isTransientAiError(err: unknown): boolean {
  const retryableStatuses = new Set([408, 409, 425, 500, 502, 503, 504]);
  const retryableCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);

  return errorChain(err).some((item) => {
    const typed = item as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
    };
    if (
      typeof typed.status === "number" &&
      retryableStatuses.has(typed.status)
    ) {
      return true;
    }
    if (
      typeof typed.statusCode === "number" &&
      retryableStatuses.has(typed.statusCode)
    ) {
      return true;
    }
    if (
      typeof typed.code === "string" &&
      retryableCodes.has(typed.code.toUpperCase())
    ) {
      return true;
    }
    return /connection (?:error|reset|refused|terminated)|fetch failed|network error|socket hang up|other side closed|bad gateway|service unavailable|gateway timeout|temporarily unavailable|timed out/i.test(
      errorMessage(item),
    );
  });
}

export function isDatabaseError(err: unknown): boolean {
  const msg = errorMessage(err);
  return /Failed query|insert into|update "|delete from|relation ["']?\w+["']? does not exist|column .* does not exist|duplicate key value|violates (not-null|foreign key|unique|check) constraint|ECONNREFUSED|connection terminated|too many clients|password authentication failed/i.test(
    msg,
  );
}

export function publicAiError(err: unknown): string {
  const msg = errorMessage(err);
  if (isDatabaseError(err)) {
    return "メッセージの保存に失敗しました。もう一度お試しください。";
  }
  if (/api[_ ]?key|unauthorized|401|invalid_api_key/i.test(msg)) {
    return "AI プロバイダの認証に失敗しました。";
  }
  if (/timeout|ETIMEDOUT|aborted/i.test(msg)) {
    return "応答がタイムアウトしました。もう一度お試しください。";
  }
  if (/rate limit|429|quota/i.test(msg)) {
    return "利用制限に達しました。しばらくしてから再試行してください。";
  }
  if (/unsupported parameter|unknown parameter|invalid.?request/i.test(msg)) {
    return "このモデルでは使えない設定がありました。別のモデルか推論オフで再試行してください。";
  }
  if (isTransientAiError(err)) {
    return "AIサービスへの接続が一時的に不安定です。もう一度お試しください。";
  }
  return "応答の生成に失敗しました。もう一度お試しください。";
}

export function publicHttpError(err: unknown): {
  status: number;
  message: string;
} {
  const typed = err as { status?: number; statusCode?: number; type?: string };
  const status = typed.status ?? typed.statusCode ?? 500;

  if (status === 413 || typed.type === "entity.too.large") {
    return {
      status: 413,
      message: "リクエストが大きすぎます。添付は合計20MB以下にしてください。",
    };
  }
  if (isDatabaseError(err)) {
    return {
      status: 500,
      message: "メッセージの保存に失敗しました。もう一度お試しください。",
    };
  }
  if (status === 400) {
    const msg = errorMessage(err);
    if (
      !msg ||
      isDatabaseError(err) ||
      /insert into|select |Failed query/i.test(msg)
    ) {
      return { status: 400, message: "リクエストが不正です。" };
    }
    return { status: 400, message: `リクエストが不正です: ${msg}` };
  }
  if (status >= 400 && status < 600 && status !== 500) {
    return { status, message: publicAiError(err) };
  }
  return { status: 500, message: publicAiError(err) };
}
