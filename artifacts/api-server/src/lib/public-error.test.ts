import { describe, expect, it } from "vitest";
import {
  isDatabaseError,
  isTransientAiError,
  publicAiError,
  publicHttpError,
} from "./public-error";

const drizzleInsertError = new Error(
  'Failed query: insert into "messages" ("id", "conversation_id", "role", "content", "model_id", "sources", "audit_content", "audit_model_id", "created_at") values (default, $1, $2, $3, default, default, default, default, default) params: 16,user,今日のマーケットについて分かるか？',
);

describe("isDatabaseError", () => {
  it("detects Drizzle Failed query dumps", () => {
    expect(isDatabaseError(drizzleInsertError)).toBe(true);
    expect(
      isDatabaseError(
        new Error(
          'column "audit_content" of relation "messages" does not exist',
        ),
      ),
    ).toBe(true);
  });

  it("does not treat ordinary AI errors as database failures", () => {
    expect(isDatabaseError(new Error("rate limit exceeded"))).toBe(false);
    expect(isDatabaseError(new Error("timeout"))).toBe(false);
  });
});

describe("isTransientAiError", () => {
  it("detects retryable provider and nested network failures", () => {
    expect(
      isTransientAiError(
        Object.assign(new Error("upstream failed"), { status: 503 }),
      ),
    ).toBe(true);
    expect(
      isTransientAiError(
        Object.assign(new Error("Connection error."), {
          cause: Object.assign(new Error("socket closed"), {
            code: "ECONNRESET",
          }),
        }),
      ),
    ).toBe(true);
  });

  it("does not retry authentication, validation, or quota errors", () => {
    expect(
      isTransientAiError(
        Object.assign(new Error("unauthorized"), { status: 401 }),
      ),
    ).toBe(false);
    expect(
      isTransientAiError(
        Object.assign(new Error("bad input"), { status: 400 }),
      ),
    ).toBe(false);
    expect(
      isTransientAiError(
        Object.assign(new Error("rate limit"), { status: 429 }),
      ),
    ).toBe(false);
  });
});

describe("publicAiError", () => {
  it("does not leak SQL or the user prompt", () => {
    const message = publicAiError(drizzleInsertError);
    expect(message).toBe(
      "メッセージの保存に失敗しました。もう一度お試しください。",
    );
    expect(message).not.toMatch(/insert into|audit_content|今日のマーケット/);
  });

  it("keeps provider-specific copy", () => {
    expect(publicAiError(new Error("invalid_api_key"))).toBe(
      "AI プロバイダの認証に失敗しました。",
    );
    expect(publicAiError(new Error("rate limit 429"))).toBe(
      "利用制限に達しました。しばらくしてから再試行してください。",
    );
  });

  it("explains exhausted transient failures", () => {
    expect(
      publicAiError(
        Object.assign(new Error("upstream failed"), { status: 502 }),
      ),
    ).toBe("AIサービスへの接続が一時的に不安定です。もう一度お試しください。");
  });
});

describe("publicHttpError", () => {
  it("maps payload-too-large", () => {
    const err = Object.assign(new Error("request entity too large"), {
      status: 413,
      type: "entity.too.large",
    });
    expect(publicHttpError(err)).toEqual({
      status: 413,
      message: "リクエストが大きすぎます。添付は合計20MB以下にしてください。",
    });
  });

  it("hides Drizzle insert failures as 500", () => {
    const result = publicHttpError(drizzleInsertError);
    expect(result.status).toBe(500);
    expect(result.message).not.toContain("insert into");
    expect(result.message).not.toContain("今日のマーケット");
  });
});
