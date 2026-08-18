function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : "";
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
  return "応答の生成に失敗しました。もう一度お試しください。";
}

export function publicHttpError(err: unknown): { status: number; message: string } {
  const typed = err as { status?: number; statusCode?: number; type?: string };
  const status = typed.status ?? typed.statusCode ?? 500;

  if (status === 413 || typed.type === "entity.too.large") {
    return { status: 413, message: "ファイルが大きすぎます。15MB以下の画像を添付してください。" };
  }
  if (isDatabaseError(err)) {
    return { status: 500, message: "メッセージの保存に失敗しました。もう一度お試しください。" };
  }
  if (status === 400) {
    const msg = errorMessage(err);
    if (!msg || isDatabaseError(err) || /insert into|select |Failed query/i.test(msg)) {
      return { status: 400, message: "リクエストが不正です。" };
    }
    return { status: 400, message: `リクエストが不正です: ${msg}` };
  }
  if (status >= 400 && status < 600 && status !== 500) {
    return { status, message: publicAiError(err) };
  }
  return { status: 500, message: publicAiError(err) };
}
