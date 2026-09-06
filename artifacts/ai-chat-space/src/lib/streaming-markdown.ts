export type StreamingMarkdownMode = "incremental" | "full";

export interface StreamingMarkdownParts {
  mode: StreamingMarkdownMode;
  stableBlocks: string[];
  tail: string;
}

interface BlockCandidate {
  text: string;
  separator: string;
  hasBoundary: boolean;
}

const FENCE_START_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM_RE = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/;
const INDENTED_LINE_RE = /^ {4,}\S/;
const BLOCKQUOTE_LINE_RE = /^\s{0,3}>/;

// These constructs can make an earlier Markdown node change when later input
// arrives. Falling back to the normal full render is safer than guessing.
const REFERENCE_DEFINITION_RE = /^\s{0,3}\[[^\]\n]+\]:(?:\s|$)/m;
const REFERENCE_LINK_RE = /\[[^\]\n]+\]\s*\[[^\]\n]*\]/;
const HTML_RE = /<!--|<![A-Z]|<\/?[A-Za-z][^>\n]*(?:>|$)/;

function hasUnsafeCrossBlockSyntax(content: string): boolean {
  return (
    REFERENCE_DEFINITION_RE.test(content) ||
    REFERENCE_LINK_RE.test(content) ||
    HTML_RE.test(content)
  );
}

function hasFence(line: string): boolean {
  return FENCE_START_RE.test(line);
}

function isBalancedFenceBlock(block: string): boolean {
  let open: { marker: string; length: number } | null = null;

  for (const line of block.split("\n")) {
    const match = FENCE_START_RE.exec(line);
    if (!match) continue;

    const marker = match[1][0];
    const length = match[1].length;
    if (!open) {
      open = { marker, length };
      continue;
    }

    if (marker === open.marker && length >= open.length) {
      open = null;
    }
  }

  return open === null;
}

function startsListOrContinuation(block: string): boolean {
  return block
    .split("\n")
    .some(
      (line) =>
        LIST_ITEM_RE.test(line) ||
        INDENTED_LINE_RE.test(line) ||
        BLOCKQUOTE_LINE_RE.test(line),
    );
}

function isStableBlock(
  candidate: BlockCandidate,
  nextCandidate: BlockCandidate | undefined,
): boolean {
  if (!candidate.hasBoundary || candidate.text.trim() === "") return false;

  const lines = candidate.text.split("\n");
  const nonBlankLines = lines.filter((line) => line.trim() !== "");
  const hasFenceSyntax = nonBlankLines.some(hasFence);
  if (hasFenceSyntax && !isBalancedFenceBlock(candidate.text)) return false;

  const hasList = nonBlankLines.some((line) => LIST_ITEM_RE.test(line));
  if (hasList) {
    // A trailing list item may still be joined by a later append. Keep it in
    // the mutable tail unless the current content already proves the list was
    // followed by a different, non-indented block.
    if (!nextCandidate || startsListOrContinuation(nextCandidate.text)) {
      return false;
    }
  }

  const hasBlockquote = nonBlankLines.some((line) =>
    BLOCKQUOTE_LINE_RE.test(line),
  );
  if (hasBlockquote) {
    // Lazy continuation and nested blocks are deliberately conservative.
    if (
      nonBlankLines.some((line) => !BLOCKQUOTE_LINE_RE.test(line)) ||
      !nextCandidate ||
      startsListOrContinuation(nextCandidate.text)
    ) {
      return false;
    }
  }

  return true;
}

function splitCandidates(content: string): BlockCandidate[] {
  const candidates: BlockCandidate[] = [];
  const separatorRe = /\n[ \t]*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = separatorRe.exec(content)) !== null) {
    const text = content.slice(start, match.index);
    if (text.trim() !== "") {
      candidates.push({ text, separator: match[0], hasBoundary: true });
    }
    start = match.index + match[0].length;
  }

  const tail = content.slice(start);
  if (tail.trim() !== "" || candidates.length === 0) {
    candidates.push({ text: tail, separator: "", hasBoundary: false });
  }

  return candidates;
}

export function splitStreamingMarkdown(
  content: string,
): StreamingMarkdownParts {
  if (!content || hasUnsafeCrossBlockSyntax(content)) {
    return { mode: "full", stableBlocks: [], tail: content };
  }

  const candidates = splitCandidates(content);
  const stableBlocks: string[] = [];
  let freezeCount = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!isStableBlock(candidate, candidates[index + 1])) break;
    stableBlocks.push(candidate.text);
    freezeCount = index + 1;
  }

  if (freezeCount === 0) {
    return { mode: "incremental", stableBlocks: [], tail: content };
  }

  const tail = candidates
    .slice(freezeCount)
    .map((candidate) => candidate.text + candidate.separator)
    .join("");

  return {
    mode: "incremental",
    stableBlocks,
    tail,
  };
}
