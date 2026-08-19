import { createHash } from "node:crypto";

const MAX_EXTERNAL_TEXT_LENGTH = 2_000;
const ALLOWED_EXTERNAL_COMMANDS = new Set(["libreoffice", "pdftocairo"]);

function sanitizeDiagnosticText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || !value) return undefined;

  return value
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, "[redacted-data-url]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted-credential]")
    .replace(
      /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^,;\s"']+/gi,
      "$1=[redacted-credential]",
    )
    .replace(/[A-Za-z0-9+/=_-]{256,}/g, "[redacted-binary-or-credential]")
    .slice(0, maxLength);
}

function numericProperty(
  record: Record<string, unknown>,
  property: string,
): number | undefined {
  const value = record[property];
  return typeof value === "number" ? value : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value)
    ? value
    : undefined;
}

function fingerprintError(
  error: unknown,
  name: string,
  code?: string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return createHash("sha256")
    .update(`${name}\0${code ?? ""}\0${message}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Return only diagnostic-safe error fields. In particular, do not pass database
 * errors directly to pino because a driver can attach query parameters containing
 * the generated file's base64 payload.
 */
export function getFileGenerationErrorDetails(error: unknown): {
  name: string;
  kind:
    | "cjk-font-unavailable"
    | "external-command-failure"
    | "upstream-or-storage-failure"
    | "unclassified-failure";
  fingerprint: string;
  code?: string;
  status?: number;
  command?: string;
  commandArgs?: string[];
  exitCode?: number | null;
  stderr?: string;
} {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const name =
    safeIdentifier(error instanceof Error ? error.name : undefined) ??
    "UnknownError";
  const code = safeIdentifier(record.code);
  const status = numericProperty(record, "status");
  const command = safeIdentifier(record.command);
  const isAllowedExternalCommand =
    name === "ExternalCommandError" &&
    Boolean(command && ALLOWED_EXTERNAL_COMMANDS.has(command));
  const commandArgs =
    isAllowedExternalCommand && Array.isArray(record.commandArgs)
      ? record.commandArgs
          .map((arg) => sanitizeDiagnosticText(arg, 500))
          .filter((arg): arg is string => Boolean(arg))
      : undefined;
  const kind =
    code === "CJK_FONT_UNAVAILABLE"
      ? "cjk-font-unavailable"
      : isAllowedExternalCommand
        ? "external-command-failure"
        : code || status
          ? "upstream-or-storage-failure"
          : "unclassified-failure";

  return {
    name,
    kind,
    fingerprint: fingerprintError(error, name, code),
    code,
    status,
    command: isAllowedExternalCommand ? command : undefined,
    commandArgs,
    exitCode:
      isAllowedExternalCommand &&
      (typeof record.exitCode === "number" || record.exitCode === null)
        ? record.exitCode
        : undefined,
    stderr: isAllowedExternalCommand
      ? sanitizeDiagnosticText(record.stderr, MAX_EXTERNAL_TEXT_LENGTH)
      : undefined,
  };
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}