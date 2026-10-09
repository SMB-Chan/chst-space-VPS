/**
 * Pure helpers for the Google Drive integration (no DB / network imports so
 * tool modules stay importable without a database).
 */
import { clipHeadUtf8Safe } from "./text-truncation";

/** Escape a user string for a Drive `q` literal ('...'): backslash first. */
export function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Drive file ids are URL-safe base64-ish; reject anything else early. */
export function isValidDriveFileId(id: string): boolean {
  return /^[A-Za-z0-9_-]{10,200}$/.test(id);
}

/**
 * Accept a bare id or a Drive/Docs URL (…/d/<id>/…, ?id=<id>) and return the
 * file id, or null.
 */
export function parseDriveFileId(input: string): string | null {
  const trimmed = input.trim();
  if (isValidDriveFileId(trimmed)) return trimmed;
  const match =
    trimmed.match(/\/d\/([A-Za-z0-9_-]{10,200})(?:[/?#]|$)/) ??
    trimmed.match(/[?&]id=([A-Za-z0-9_-]{10,200})(?:&|$)/);
  return match ? match[1]! : null;
}

/** Clip extracted Drive text for a chat tool result. */
export function clipDriveTextForTool(text: string, maxChars = 20_000): string {
  return clipHeadUtf8Safe(text, maxChars, "\n…（以降省略）…\n");
}
