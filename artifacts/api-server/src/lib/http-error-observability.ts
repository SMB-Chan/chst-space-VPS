import type { Logger } from "pino";
import { isDatabaseError } from "./public-error";
import { logger, safeExceptionName } from "./logger";

const SAFE_ROUTE_PATTERN = /^\/[A-Za-z0-9._~:/{}*+()[\]-]{0,159}$/;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const SAFE_METHOD_PATTERN = /^[A-Z]{3,12}$/;
const SAFE_ERROR_LOGGED = Symbol("safeHttpErrorLogged");

export const SAFE_HTTP_ERROR_MESSAGE = "HTTP request failed";
export const SAFE_HTTP_ACCESS_MESSAGE = "HTTP request completed";

export const SAFE_HTTP_ERROR_CODES = [
  "HTTP_OK",
  "HTTP_CLIENT_ERROR",
  "HTTP_AUTHENTICATION",
  "HTTP_NOT_FOUND",
  "HTTP_PAYLOAD_TOO_LARGE",
  "HTTP_VALIDATION",
  "HTTP_DATABASE",
  "HTTP_TIMEOUT",
  "HTTP_PROVIDER",
  "HTTP_UPSTREAM",
  "HTTP_INTERNAL",
  "HTTP_UNKNOWN",
] as const;

export type SafeHttpErrorCode = (typeof SAFE_HTTP_ERROR_CODES)[number];

type HeaderValue = string | string[] | undefined;

export interface SafeHttpRequest {
  id?: unknown;
  method?: unknown;
  baseUrl?: unknown;
  route?: { path?: unknown };
  headers?: Record<string, HeaderValue>;
}

export interface SafeHttpLogFields {
  requestId: string;
  traceId?: string;
  method: string;
  route: string;
  status: number;
  exceptionName: string;
  errorCode: SafeHttpErrorCode;
}

interface SafeHttpRequestWithState extends SafeHttpRequest {
  [SAFE_ERROR_LOGGED]?: boolean;
}

interface ErrorLogger {
  error(fields: SafeHttpLogFields, message: string): void;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstHeader(value: HeaderValue): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function normalizeRequestId(value: unknown): string {
  const candidate =
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  return SAFE_REQUEST_ID_PATTERN.test(candidate) ? candidate : "request_unknown";
}

function normalizeMethod(value: unknown): string {
  const candidate = asString(value).toUpperCase();
  return SAFE_METHOD_PATTERN.test(candidate) ? candidate : "UNKNOWN";
}

function normalizeRoute(request: SafeHttpRequest): string {
  const routePath = request.route?.path;
  const template = Array.isArray(routePath)
    ? routePath.length === 1
      ? routePath[0]
      : undefined
    : routePath;
  const baseUrl = asString(request.baseUrl);
  const candidate = `${baseUrl}${asString(template)}`;

  if (candidate.length === 0 || !SAFE_ROUTE_PATTERN.test(candidate)) {
    return "route_unknown";
  }
  return candidate;
}

function extractTraceId(request: SafeHttpRequest): string | undefined {
  const traceparent = firstHeader(request.headers?.["traceparent"]);
  const match = traceparent.match(TRACEPARENT_PATTERN);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) {
    return undefined;
  }
  return match[1].toLowerCase();
}

function normalizeStatus(status: number | undefined): number {
  return Number.isInteger(status) && status !== undefined && status >= 100 && status <= 599
    ? status
    : 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function inferredErrorCode(
  error: unknown,
  status: number,
  override?: SafeHttpErrorCode,
): SafeHttpErrorCode {
  if (override) return override;
  if (status >= 200 && status < 300) return "HTTP_OK";
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid[_ ]api[_ ]key/i.test(errorMessage(error))) {
    return "HTTP_AUTHENTICATION";
  }
  if (status === 404) return "HTTP_NOT_FOUND";
  if (status === 413) return "HTTP_PAYLOAD_TOO_LARGE";
  if (status === 400) return "HTTP_VALIDATION";
  if (isDatabaseError(error)) return "HTTP_DATABASE";
  if (/timeout|timed out|etimedout|aborted/i.test(errorMessage(error))) return "HTTP_TIMEOUT";
  if (/provider|api[_ ]key|upstream|gateway/i.test(errorMessage(error))) return "HTTP_PROVIDER";
  if (status === 502 || status === 503 || status === 504) return "HTTP_UPSTREAM";
  if (status >= 400 && status < 500) return "HTTP_CLIENT_ERROR";
  if (status >= 500) return "HTTP_INTERNAL";
  return "HTTP_UNKNOWN";
}

export function createSafeHttpLogFields(
  request: SafeHttpRequest,
  status: number | undefined,
  error?: unknown,
  errorCode?: SafeHttpErrorCode,
): SafeHttpLogFields {
  const normalizedStatus = normalizeStatus(status);
  return {
    requestId: normalizeRequestId(request.id),
    ...(extractTraceId(request) ? { traceId: extractTraceId(request) } : {}),
    method: normalizeMethod(request.method),
    route: normalizeRoute(request),
    status: normalizedStatus,
    exceptionName: error ? safeExceptionName(error) : "None",
    errorCode: inferredErrorCode(error, normalizedStatus, errorCode),
  };
}

export function createSafeHttpAccessFields(
  request: SafeHttpRequest,
  status: number | undefined,
): Omit<SafeHttpLogFields, "requestId"> {
  const { requestId: _requestId, ...fields } = createSafeHttpLogFields(request, status);
  return fields;
}

export function httpLogLevel(status: number, error?: unknown): "error" | "warn" | "info" {
  if (error || status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

export function logSafeHttpError(
  request: SafeHttpRequest,
  status: number | undefined,
  error: unknown,
  errorCode?: SafeHttpErrorCode,
  target: ErrorLogger | Logger = logger,
): boolean {
  const requestWithState = request as SafeHttpRequestWithState;
  if (requestWithState[SAFE_ERROR_LOGGED]) return false;
  requestWithState[SAFE_ERROR_LOGGED] = true;
  target.error(createSafeHttpLogFields(request, status, error, errorCode), SAFE_HTTP_ERROR_MESSAGE);
  return true;
}