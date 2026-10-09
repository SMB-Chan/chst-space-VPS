/**
 * Project-scoped file quotas and per-file caps. All values are env-overridable
 * so an operator can dial storage up or down per deployment, but we clamp to
 * sane ranges to keep a misconfigured deployment from accidentally disabling
 * the safety net (0 / negative / absurdly large values are rejected).
 */

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const PROJECT_FILE_MAX_BYTES_DEFAULT = 20 * 1024 * 1024;
export const PROJECT_MAX_FILES_DEFAULT = 50;
export const PROJECT_USER_MAX_TOTAL_BYTES_DEFAULT = 500 * 1024 * 1024;
export const PROJECT_FILE_TEXT_MAX_CHARS_DEFAULT = 100_000;
export const PROJECT_INSTRUCTIONS_MAX_CHARS_DEFAULT = 4000;
export const PROJECT_FILES_CONTEXT_MAX_CHARS_DEFAULT = 8000;
export const PROJECT_FILE_CONTEXT_PER_FILE_MAX_CHARS_DEFAULT = 4000;

const PROJECT_FILE_MAX_BYTES = parseNonNegativeInt(
  process.env.PROJECT_FILE_MAX_BYTES,
  PROJECT_FILE_MAX_BYTES_DEFAULT,
  1024,
  100 * 1024 * 1024,
);
const PROJECT_MAX_FILES = parseNonNegativeInt(
  process.env.PROJECT_MAX_FILES,
  PROJECT_MAX_FILES_DEFAULT,
  1,
  1000,
);
const PROJECT_USER_MAX_TOTAL_BYTES = parseNonNegativeInt(
  process.env.PROJECT_USER_MAX_TOTAL_BYTES,
  PROJECT_USER_MAX_TOTAL_BYTES_DEFAULT,
  PROJECT_FILE_MAX_BYTES,
  10 * 1024 * 1024 * 1024,
);
/** Per-file cap on the extracted text we persist in project_files.extracted_text. */
export const PROJECT_FILE_TEXT_MAX_CHARS = PROJECT_FILE_TEXT_MAX_CHARS_DEFAULT;
/** Hard cap on the user-authored instructions field of a project. */
export const PROJECT_INSTRUCTIONS_MAX_CHARS =
  PROJECT_INSTRUCTIONS_MAX_CHARS_DEFAULT;
const PROJECT_FILES_CONTEXT_MAX_CHARS = parseNonNegativeInt(
  process.env.PROJECT_FILES_CONTEXT_MAX_CHARS,
  PROJECT_FILES_CONTEXT_MAX_CHARS_DEFAULT,
  500,
  200_000,
);
const PROJECT_FILE_CONTEXT_PER_FILE_MAX_CHARS = parseNonNegativeInt(
  process.env.PROJECT_FILE_CONTEXT_PER_FILE_MAX_CHARS,
  PROJECT_FILE_CONTEXT_PER_FILE_MAX_CHARS_DEFAULT,
  200,
  PROJECT_FILES_CONTEXT_MAX_CHARS,
);

export interface ProjectLimits {
  fileMaxBytes: number;
  maxFilesPerProject: number;
  userTotalMaxBytes: number;
  fileTextMaxChars: number;
  instructionsMaxChars: number;
  filesContextMaxChars: number;
  fileContextPerFileMaxChars: number;
}

export function getProjectLimits(): ProjectLimits {
  return {
    fileMaxBytes: PROJECT_FILE_MAX_BYTES,
    maxFilesPerProject: PROJECT_MAX_FILES,
    userTotalMaxBytes: PROJECT_USER_MAX_TOTAL_BYTES,
    fileTextMaxChars: PROJECT_FILE_TEXT_MAX_CHARS,
    instructionsMaxChars: PROJECT_INSTRUCTIONS_MAX_CHARS,
    filesContextMaxChars: PROJECT_FILES_CONTEXT_MAX_CHARS,
    fileContextPerFileMaxChars: PROJECT_FILE_CONTEXT_PER_FILE_MAX_CHARS,
  };
}
