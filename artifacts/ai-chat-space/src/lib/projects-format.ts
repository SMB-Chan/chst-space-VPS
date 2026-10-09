/**
 * Small date helpers for project surfaces. Centralized so the project list and
 * detail pages render the same `2026年1月9日` style.
 */

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getFormatter(
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let formatter = FORMATTER_CACHE.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("ja-JP", options);
    FORMATTER_CACHE.set(key, formatter);
  }
  return formatter;
}

export function formatDateJa(value: string | number | Date): string {
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return getFormatter({
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date);
  } catch {
    return "—";
  }
}
