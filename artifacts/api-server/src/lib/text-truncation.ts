/**
 * UTF-8 safe text truncation helpers.
 *
 * Model prompts are assembled from untrusted web pages, attachments, and
 * long histories. Naive `slice(0, n)` can split a surrogate pair or a
 * multi-byte sequence, producing U+FFFD mojibake inside prompts and making
 * "omitted" markers inconsistent across stages. These helpers work in UTF-16
 * code points (never splitting surrogate pairs), snap to line boundaries when
 * cheap, and always append an explicit marker — never silent truncation.
 */

export function clipHeadUtf8Safe(
  text: string,
  maxChars: number,
  marker = "\n…（入力を省略）…\n",
): string {
  const value = String(text ?? "");
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) return "";
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  if (maxChars <= marker.length + 16) return marker.trim();
  const budget = maxChars - marker.length;
  const head = chars.slice(0, budget).join("");
  const newline = head.lastIndexOf("\n");
  if (newline > budget * 0.4) return head.slice(0, newline) + marker;
  return head + marker;
}

export function clipHeadTailUtf8Safe(
  text: string,
  maxChars: number,
  marker = "\n…（入力を省略）…\n",
  headShare = 0.6,
): string {
  const value = String(text ?? "");
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) return "";
  const chars = [...value];
  if (chars.length <= maxChars) return value.trim() ? value : value;
  if (maxChars <= marker.length + 16) return marker.trim();
  const available = maxChars - marker.length;
  const headChars = Math.max(1, Math.ceil(available * headShare));
  const tailChars = Math.max(0, available - headChars);
  const head = chars.slice(0, headChars).join("");
  const tail =
    tailChars > 0 ? chars.slice(chars.length - tailChars).join("") : "";
  const headCut = head.lastIndexOf("\n");
  const cleanHead =
    headCut > headChars * 0.4 ? head.slice(0, headCut) : head;
  const tailCut = tail.indexOf("\n");
  const cleanTail =
    tailCut >= 0 && tailCut < tail.length * 0.5
      ? tail.slice(tailCut + 1)
      : tail;
  return `${cleanHead}${marker}${cleanTail}`;
}
