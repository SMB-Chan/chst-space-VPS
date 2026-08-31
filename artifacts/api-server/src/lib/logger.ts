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

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  serializers: {
    err: (error) => ({ name: safeExceptionName(error) }),
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
