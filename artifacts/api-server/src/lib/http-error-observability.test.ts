import { describe, expect, it, vi } from "vitest";
import {
  createSafeHttpAccessFields,
  createSafeHttpLogFields,
  httpLogLevel,
  logSafeHttpError,
} from "./http-error-observability";
import { safeErrorSerializer } from "./logger";
import { publicHttpError } from "./public-error";

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "server-request-42",
    method: "GET",
    baseUrl: "/api",
    route: { path: "/openai/conversations/:conversationId" },
    headers: {},
    ...overrides,
  };
}

describe("safe HTTP error observability", () => {
  it("keeps only bounded correlation and fixed diagnostic fields", () => {
    const secret = "Bearer do-not-log-this-user-secret";
    const error = new Error(`database failed for ${secret}`);
    error.name = "BearerSecret";
    error.stack = `Error: ${secret}\n    at ${secret}`;

    const fields = createSafeHttpLogFields(
      request({
        headers: {
          authorization: secret,
          cookie: `session=${secret}`,
          traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        },
      }),
      500,
      error,
      "HTTP_DATABASE",
    );

    expect(fields).toEqual({
      requestId: "server-request-42",
      traceId: "0123456789abcdef0123456789abcdef",
      method: "GET",
      route: "/api/openai/conversations/:conversationId",
      status: 500,
      exceptionName: "UnknownError",
      errorCode: "HTTP_DATABASE",
    });
    expect(JSON.stringify(fields)).not.toContain(secret);
    expect(fields).not.toHaveProperty("message");
    expect(fields).not.toHaveProperty("stack");
    expect(fields).not.toHaveProperty("authorization");
    expect(fields).not.toHaveProperty("cookie");
  });

  it("does not use a route value or an invalid traceparent as observability data", () => {
    const fields = createSafeHttpLogFields(
      request({
        route: { path: "/openai/conversations/user-private-value" },
        headers: {
          traceparent: "not-a-trace-id",
        },
      }),
      500,
      new Error("private request body"),
    );

    expect(fields.route).toBe("route_unknown");
    expect(fields).not.toHaveProperty("traceId");
    expect(JSON.stringify(fields)).not.toContain("user-private-value");
    expect(JSON.stringify(fields)).not.toContain("private request body");
  });

  it("falls back to fixed values for unsafe request IDs and malformed methods", () => {
    const fields = createSafeHttpLogFields(
      request({ id: "request id with spaces and secrets", method: "get /private" }),
      500,
      new Error("internal"),
    );

    expect(fields.requestId).toBe("request_unknown");
    expect(fields.method).toBe("UNKNOWN");
  });

  it("keeps access logs safe and marks 5xx access at error level", () => {
    const accessFields = createSafeHttpAccessFields(request(), 503);

    expect(accessFields).toEqual({
      method: "GET",
      route: "/api/openai/conversations/:conversationId",
      status: 503,
      exceptionName: "None",
      errorCode: "HTTP_UPSTREAM",
    });
    expect(httpLogLevel(500)).toBe("error");
    expect(httpLogLevel(404)).toBe("warn");
    expect(httpLogLevel(200)).toBe("info");
  });

  it("emits one exception record per request even when error paths repeat", () => {
    const target = { error: vi.fn() };
    const req = request();
    const error = new Error("raw message must not be passed to the logger");

    expect(logSafeHttpError(req, 500, error, "HTTP_INTERNAL", target)).toBe(true);
    expect(logSafeHttpError(req, 500, error, "HTTP_INTERNAL", target)).toBe(false);

    expect(target.error).toHaveBeenCalledTimes(1);
    expect(target.error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "server-request-42",
        route: "/api/openai/conversations/:conversationId",
        status: 500,
        errorCode: "HTTP_INTERNAL",
      }),
      "HTTP request failed",
    );
    expect(JSON.stringify(target.error.mock.calls[0])).not.toContain("raw message");
  });

  it("preserves public error mapping while keeping its raw cause out of logs", () => {
    const error = Object.assign(new Error("select secret_table where token = 'private'"), {
      status: 413,
      type: "entity.too.large",
    });
    const publicError = publicHttpError(error);

    expect(publicError).toEqual({
      status: 413,
      message: "リクエストが大きすぎます。添付は合計20MB以下にしてください。",
    });

    const target = { error: vi.fn() };
    logSafeHttpError(request(), publicError.status, error, undefined, target);
    expect(JSON.stringify(target.error.mock.calls[0])).not.toContain("select secret_table");
    expect(JSON.stringify(target.error.mock.calls[0])).not.toContain("private");
  });

  it("serializes both err and error values to a bounded exception name only", () => {
    const secret = "api-key-and-stack-secret";
    const error = new Error(`raw message ${secret}`);
    error.name = "BearerSecret";
    error.stack = `Error: ${secret}\n at ${secret}`;

    expect(safeErrorSerializer(error)).toEqual({ name: "UnknownError" });
    expect(JSON.stringify(safeErrorSerializer(error))).not.toContain(secret);
    expect(safeErrorSerializer({ error, message: secret, stack: secret })).toEqual({
      name: "UnknownError",
    });
  });
});