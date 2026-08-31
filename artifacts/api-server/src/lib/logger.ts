import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export function safeExceptionName(error: unknown): string {
  const candidate =
    error instanceof Error
      ? error.name
      : error && typeof error === "object" && "name" in error
        ? String(error.name)
        : "";
  if (
    candidate === "Error" ||
    !/^[A-Z][A-Za-z0-9]{0,62}(?:Error|Exception)$/.test(candidate)
  ) {
    return "UnknownError";
  }
  return candidate;
}

export function safeFailureFields(
  error: unknown,
  component: string,
  errorCode: string,
  status?: number,
): {
  component: string;
  errorCode: string;
  exceptionName: string;
  status?: number;
} {
  return {
    component,
    errorCode,
    exceptionName: error ? safeExceptionName(error) : "None",
    ...(status === undefined ? {} : { status }),
  };
}

const safeErrorSerializer = (error: unknown) => ({
  name: safeExceptionName(error),
});

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  serializers: {
    err: safeErrorSerializer,
    error: safeErrorSerializer,
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
