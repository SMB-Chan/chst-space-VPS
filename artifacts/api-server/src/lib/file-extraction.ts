import { Unzip, UnzipInflate } from "fflate";
import * as mammoth from "mammoth";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";
import { TranscriptionError, transcribeAudio } from "./audio-transcription";
import {
  readZipCentralDirectory,
  ZipFormatError,
  type ZipDirectoryInfo,
} from "./binary-detection";
import { logger } from "./logger";
import {
  parseUserMessageContent,
  type BinaryAttachment,
  type IncomingAttachment,
  type ParsedUserMessageContent,
} from "./message-content";

/**
 * Deterministic server-side file analysis. Files are parsed by trusted code
 * and reduced to capped plain text; nothing from a file is ever executed,
 * rendered, or fetched. The extracted text is treated as untrusted data
 * downstream (framing + notices live in message-content.ts).
 */

export class FileExtractionError extends Error {
  readonly publicMessage: string;

  constructor(publicMessage: string) {
    super(publicMessage);
    this.name = "FileExtractionError";
    this.publicMessage = publicMessage;
  }
}

/** Whole-route budget covering every attachment of one message. */
export const FILE_EXTRACTION_TIMEOUT_MS = 240_000;
/** Per-file cap on extracted characters (bounds prompt token cost). */
export const MAX_EXTRACTED_CHARS = 100_000;

const MAX_ZIP_ENTRIES = 1000;
const MAX_ZIP_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024;
const MAX_ZIP_TEXT_ENTRIES = 50;
const MAX_ZIP_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_ENTRY_CHARS = 50_000;
const MAX_ZIP_LISTING_LINES = 200;
const MAX_PPTX_SLIDES = 200;
const MAX_XLSX_SHEETS = 10;
const MAX_XLSX_ROWS = 2000;
const MAX_XLSX_COLS = 50;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "log",
  "yaml", "yml", "ini", "toml", "srt", "vtt",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
  "c", "h", "cpp", "hpp", "cs", "sh", "css", "sql",
]);

const ARCHIVE_EXTENSIONS = new Set([
  "zip", "7z", "rar", "gz", "tar", "bz2", "xz", "zst", "cab", "iso",
  "jar", "war", "epub", "apk", "odt", "ods", "odp", "docx", "xlsx", "pptx",
]);

function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const marker = `\n\n（${cap.toLocaleString("ja-JP")}文字を超えたため省略しました。）`;
  return text.slice(0, Math.max(0, cap - marker.length)) + marker;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  if (index < 0) return "";
  return name.slice(index + 1).toLowerCase();
}

/**
 * Zip entry names are attacker-controlled. Content is never written to disk,
 * but unsafe paths are still excluded from extraction to keep the produced
 * text index boring and predictable.
 */
function isSafeZipPath(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  if (name.includes("\\")) return false;
  return !name.split("/").some((segment) => segment === "..");
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      default: return match;
    }
  });
}

function decodeAsText(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.includes("\u0000") ? null : text;
}

/** Central-directory pre-flight shared by every zip-family parser. */
function assertZipReadable(buffer: Buffer): ZipDirectoryInfo {
  let directory: ZipDirectoryInfo;
  try {
    directory = readZipCentralDirectory(buffer);
  } catch (err) {
    if (err instanceof ZipFormatError) {
      throw new FileExtractionError(`ZIP構造を読み取れませんでした。${err.message}`);
    }
    throw new FileExtractionError("ZIP構造を読み取れませんでした。");
  }
  if (directory.entries.length > MAX_ZIP_ENTRIES) {
    throw new FileExtractionError(
      `ZIPのエントリ数が${MAX_ZIP_ENTRIES}を超えているため解析できません。`,
    );
  }
  if (directory.totalUncompressedBytes > MAX_ZIP_TOTAL_UNCOMPRESSED) {
    throw new FileExtractionError(
      `ZIPの展開後サイズが合計${formatBytes(MAX_ZIP_TOTAL_UNCOMPRESSED)}を超えると推定されるため解析できません。`,
    );
  }
  return directory;
}

class ZipBudgetExceededError extends Error {
  constructor() {
    super("zip decompression budget exceeded");
    this.name = "ZipBudgetExceededError";
  }
}

/**
 * Streaming unzip that enforces REAL decompressed-byte budgets (headers can
 * lie). Entries the filter rejects are never inflated; throwing from the
 * data handler aborts the whole pass, keeping memory bounded.
 */
function streamZipEntries(
  buffer: Buffer,
  accept: (name: string) => boolean,
  budget: { perEntryBytes: number; totalBytes: number },
  accountAllEntries = false,
): { contents: Map<string, Uint8Array>; aborted: boolean } {
  const contents = new Map<string, Uint8Array>();
  let decompressedTotal = 0;
  let aborted = false;

  const unzipper = new Unzip((file) => {
    const collect = accept(file.name);
    if (aborted || (!collect && !accountAllEntries)) return;
    const chunks: Uint8Array[] | undefined = collect ? [] : undefined;
    let entryBytes = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      entryBytes += chunk.length;
      decompressedTotal += chunk.length;
      if (entryBytes > budget.perEntryBytes || decompressedTotal > budget.totalBytes) {
        aborted = true;
        throw new ZipBudgetExceededError();
      }
      if (chunks) chunks.push(chunk);
      if (final && chunks) {
        let totalLength = 0;
        for (const part of chunks) totalLength += part.length;
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of chunks) {
          merged.set(part, offset);
          offset += part.length;
        }
        contents.set(file.name, merged);
      }
    };
    file.start();
  });
  unzipper.register(UnzipInflate);

  try {
    unzipper.push(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), true);
  } catch (err) {
    if (!(err instanceof ZipBudgetExceededError)) {
      throw new FileExtractionError("ZIP構造を読み取れませんでした。ファイルが破損している可能性があります。");
    }
  }
  return { contents, aborted };
}

function zipExpandedBudgetError(): FileExtractionError {
  return new FileExtractionError(
    `ZIPの展開後サイズが${formatBytes(MAX_ZIP_TOTAL_UNCOMPRESSED)}または1エントリ${formatBytes(MAX_ZIP_ENTRY_BYTES)}の上限を超えたため解析できません。`,
  );
}

/**
 * Run the streaming pass over every entry before an Office parser sees the
 * archive. This is deliberately separate from the selective content pass:
 * ignored images and metadata still count toward the decompression budget.
 */
function assertZipExpandedBudget(buffer: Buffer): ZipDirectoryInfo {
  const directory = assertZipReadable(buffer);
  const oversizedEntry = directory.entries.find(
    (entry) => entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES,
  );
  if (oversizedEntry) {
    throw new FileExtractionError(
      `ZIPのエントリ「${oversizedEntry.name}」の展開後サイズが${formatBytes(MAX_ZIP_ENTRY_BYTES)}を超えるため解析できません。`,
    );
  }
  const { aborted } = streamZipEntries(
    buffer,
    () => true,
    { perEntryBytes: MAX_ZIP_ENTRY_BYTES, totalBytes: MAX_ZIP_TOTAL_UNCOMPRESSED },
    true,
  );
  if (aborted) throw zipExpandedBudgetError();
  return directory;
}

type IsolatedExtractionResult = { ok: true; text: string } | {
  ok: false;
  message: string;
};

const ISOLATED_WORKER_URL = new URL("./file-extraction-worker.mjs", import.meta.url);

function extractionWorkerAvailable(): boolean {
  return existsSync(fileURLToPath(ISOLATED_WORKER_URL));
}

/**
 * Synchronous document parsers run in a worker in the built server. A rejected
 * Promise cannot stop PDF.js or a decompressor already executing JavaScript on
 * the event loop, while terminating this worker does.
 */
export async function runIsolatedBinaryExtraction(
  attachment: BinaryAttachment,
  signal?: AbortSignal,
  workerUrl: URL = ISOLATED_WORKER_URL,
): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new Error("Attachment extraction cancelled");
  if (!extractionWorkerAvailable() && workerUrl === ISOLATED_WORKER_URL) {
    return extractSynchronousBinaryText(attachment);
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerUrl);
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      const reason = signal?.reason ?? new Error("Attachment extraction cancelled");
      void worker.terminate();
      finish(() => reject(reason));
    };

    worker.once("message", (result: IsolatedExtractionResult) => {
      finish(() => {
        if (result.ok) resolve(result.text);
        else reject(new FileExtractionError(result.message));
      });
      void worker.terminate();
    });
    worker.once("error", (error) => {
      finish(() => reject(error));
    });
    worker.once("exit", (code) => {
      finish(() =>
        reject(
          new Error(
            code === 0
              ? "Attachment extraction worker exited without a result"
              : `Attachment extraction worker exited with code ${code}`,
          ),
        ),
      );
    });
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      worker.postMessage({
        family: attachment.family,
        buffer: attachment.buffer,
      });
    } catch (error) {
      finish(() => reject(error));
      void worker.terminate();
    }
  });
}

function isPasswordError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  const message = err instanceof Error ? err.message : String(err);
  return name === "PasswordException" || /password|no password|incorrect password/i.test(message);
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  let pages: string[];
  try {
    const document = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(document, { mergePages: false });
    pages = result.text;
  } catch (err) {
    if (isPasswordError(err)) {
      throw new FileExtractionError(
        "このPDFはパスワードで保護されているため読み取れません。パスワードを解除してから添付してください。",
      );
    }
    throw new FileExtractionError("PDFを読み取れませんでした。ファイルが破損している可能性があります。");
  }

  let output = "";
  let pagesUsed = 0;
  for (const page of pages) {
    const text = page.trim();
    if (!text) continue;
    if (output.length + text.length + 2 > MAX_EXTRACTED_CHARS) break;
    output += (output ? "\n\n" : "") + text;
    pagesUsed += 1;
  }
  if (!output.trim()) {
    throw new FileExtractionError(
      "PDFから抽出できるテキストが見つかりませんでした。画像のみのPDF（スキャン等）の可能性があります。",
    );
  }
  if (pagesUsed < pages.length) {
    output += `\n\n（全${pages.length}ページのうち、先頭から${pagesUsed}ページ分のみ抽出しました。）`;
  }
  return output;
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  assertZipExpandedBudget(buffer);
  let value: string;
  try {
    const result = await mammoth.extractRawText({ buffer });
    value = result.value;
  } catch {
    throw new FileExtractionError("Wordファイルを読み取れませんでした。ファイルが破損している可能性があります。");
  }
  const text = value.trim();
  if (!text) {
    throw new FileExtractionError("Wordファイルから抽出できるテキストが見つかりませんでした。");
  }
  return capText(text, MAX_EXTRACTED_CHARS);
}

/**
 * Bounded, dependency-free XLSX reader. The SheetJS `xlsx` package was
 * dropped from this workspace for security hardening, so uploaded workbooks
 * are parsed straight from their XML parts with hard caps. No formulas are
 * evaluated and no styles/dates are interpreted — values are read as data.
 */
const MAX_XLSX_SHARED_STRINGS = 200_000;

function toCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

function xmlAttrFromFragment(fragment: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = fragment.match(new RegExp(`${escaped}\\s*=\\s*"([^"]*)"`));
  return match ? decodeXmlEntities(match[1]) : undefined;
}

/** "C12" -> 2 (0-based column). Returns -1 when the ref has no letters. */
function columnRefToIndex(ref: string): number {
  let index = 0;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) index = index * 26 + (code - 64);
    else if (code >= 97 && code <= 122) index = index * 26 + (code - 96);
    else break;
  }
  return index > 0 ? index - 1 : -1;
}

function parseXlsxSharedStrings(xml: string): string[] {
  const shared: string[] = [];
  for (const si of xml.matchAll(/<(?:[A-Za-z0-9]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?si>/g)) {
    let value = "";
    for (const t of si[1].matchAll(/<(?:[A-Za-z0-9]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?t>/g)) {
      value += decodeXmlEntities(t[1]);
    }
    shared.push(value);
    if (shared.length >= MAX_XLSX_SHARED_STRINGS) break;
  }
  return shared;
}

function parseXlsxSheetRows(
  xml: string,
  shared: string[],
): { rows: string[][]; rowLimited: boolean; colLimited: boolean } {
  const rows: string[][] = [];
  let rowLimited = false;
  let colLimited = false;

  for (const row of xml.matchAll(/<(?:[A-Za-z0-9]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?row>/g)) {
    if (rows.length >= MAX_XLSX_ROWS) {
      rowLimited = true;
      break;
    }
    const cells: string[] = [];
    let nextColumn = 0;
    for (const cell of row[1].matchAll(/<(?:[A-Za-z0-9]+:)?c\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?c>/g)) {
      const attrs = cell[1];
      const inner = cell[2];
      const ref = xmlAttrFromFragment(attrs, "r");
      const refColumn = ref ? columnRefToIndex(ref) : -1;
      const column = refColumn >= 0 ? refColumn : nextColumn;
      nextColumn = column + 1;
      if (column >= MAX_XLSX_COLS) {
        colLimited = true;
        continue;
      }

      const type = xmlAttrFromFragment(attrs, "t") ?? "";
      let value = "";
      if (type === "inlineStr") {
        for (const t of inner.matchAll(/<(?:[A-Za-z0-9]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?t>/g)) {
          value += decodeXmlEntities(t[1]);
        }
      } else {
        const v = inner.match(/<(?:[A-Za-z0-9]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?v>/);
        const raw = v ? decodeXmlEntities(v[1]) : "";
        if (type === "s") {
          const sharedIndex = Number.parseInt(raw, 10);
          value =
            Number.isInteger(sharedIndex) && sharedIndex >= 0 && sharedIndex < shared.length
              ? shared[sharedIndex]
              : "";
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
        } else {
          // Numeric cells, formula string results, and error values stay verbatim.
          value = raw;
        }
      }
      while (cells.length < column) cells.push("");
      cells[column] = value;
    }
    rows.push(cells);
  }

  return { rows, rowLimited, colLimited };
}

interface XlsxSheetRef {
  name: string;
  target: string;
}

function parseXlsxWorkbookSheets(workbookXml: string, relsXml: string): XlsxSheetRef[] {
  const relTargets = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<(?:[A-Za-z0-9]+:)?Relationship\b[^>]*>/g)) {
    const id = xmlAttrFromFragment(rel[0], "Id");
    const target = xmlAttrFromFragment(rel[0], "Target");
    if (id && target) relTargets.set(id, target);
  }

  const sheets: XlsxSheetRef[] = [];
  for (const sheet of workbookXml.matchAll(/<(?:[A-Za-z0-9]+:)?sheet\b[^>]*>/g)) {
    const name = xmlAttrFromFragment(sheet[0], "name");
    const rid =
      xmlAttrFromFragment(sheet[0], "r:id") ??
      sheet[0].match(/[A-Za-z0-9_-]+:id\s*=\s*"(rId[^"]*)"/i)?.[1];
    if (!name || !rid) continue;
    const target = relTargets.get(rid);
    if (!target) continue;
    sheets.push({ name, target });
  }
  return sheets;
}

function normalizeXlsxSheetTarget(target: string): string {
  const cleaned = target.replace(/^\/+/, "");
  return cleaned.startsWith("xl/") ? cleaned : `xl/${cleaned}`;
}

export function extractXlsxText(buffer: Buffer): string {
  assertZipExpandedBudget(buffer);

  const fixedEntries = new Set([
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/sharedStrings.xml",
  ]);
  const { contents } = streamZipEntries(
    buffer,
    (name) => fixedEntries.has(name) || /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
    { perEntryBytes: MAX_ZIP_ENTRY_BYTES, totalBytes: MAX_ZIP_TOTAL_UNCOMPRESSED },
    true,
  );

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const workbookXml = contents.get("xl/workbook.xml");
  const relsXml = contents.get("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) {
    throw new FileExtractionError("Excelファイルの構造を読み取れませんでした。");
  }
  const sheets = parseXlsxWorkbookSheets(decoder.decode(workbookXml), decoder.decode(relsXml));
  if (sheets.length === 0) {
    throw new FileExtractionError("Excelファイルにシートが見つかりませんでした。");
  }
  const sharedStringsXml = contents.get("xl/sharedStrings.xml");
  const shared = sharedStringsXml ? parseXlsxSharedStrings(decoder.decode(sharedStringsXml)) : [];

  const sections: string[] = [];
  for (const sheet of sheets.slice(0, MAX_XLSX_SHEETS)) {
    const sheetXml = contents.get(normalizeXlsxSheetTarget(sheet.target));
    if (!sheetXml) continue;
    const { rows, rowLimited, colLimited } = parseXlsxSheetRows(decoder.decode(sheetXml), shared);
    const csv = rows
      .map((row) => row.map(toCsvCell).join(","))
      .join("\n")
      .trim();
    if (!csv) continue;
    const notes: string[] = [];
    if (rowLimited) notes.push(`行数を${MAX_XLSX_ROWS}行に制限`);
    if (colLimited) notes.push(`列数を${MAX_XLSX_COLS}列に制限`);
    const note = notes.length > 0 ? `（${notes.join("・")}）` : "";
    sections.push(`[シート: ${sheet.name}]${note}\n${csv}`);
  }
  if (sections.length === 0) {
    throw new FileExtractionError("Excelファイルから抽出できるデータが見つかりませんでした。");
  }

  const header =
    `[Excelブック: 全${sheets.length}シート` +
    (sheets.length > MAX_XLSX_SHEETS ? `、先頭${MAX_XLSX_SHEETS}シートのみ抽出` : "") +
    "]";
  return capText([header, ...sections].join("\n\n"), MAX_EXTRACTED_CHARS);
}

function extractSlideText(xml: string): string {
  const lines: string[] = [];
  for (const paragraph of xml.split("</a:p>")) {
    const runs = [...paragraph.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) =>
      decodeXmlEntities(match[1]),
    );
    if (runs.length > 0) lines.push(runs.join(""));
  }
  return lines.join("\n").trim();
}

export function extractPptxText(buffer: Buffer): string {
  assertZipExpandedBudget(buffer);
  const slideNameRegex = /^ppt\/slides\/slide(\d+)\.xml$/;
  const { contents, aborted } = streamZipEntries(
    buffer,
    (name) => slideNameRegex.test(name),
    { perEntryBytes: MAX_ZIP_ENTRY_BYTES, totalBytes: MAX_ZIP_TOTAL_UNCOMPRESSED },
    true,
  );
  if (aborted) throw zipExpandedBudgetError();

  const slides = [...contents.entries()]
    .map(([name, bytes]) => ({
      number: Number(name.match(slideNameRegex)?.[1] ?? "0"),
      text: extractSlideText(new TextDecoder("utf-8", { fatal: false }).decode(bytes)),
    }))
    .sort((a, b) => a.number - b.number);

  const sections = slides
    .slice(0, MAX_PPTX_SLIDES)
    .filter((slide) => slide.text)
    .map((slide) => `[スライド ${slide.number}]\n${slide.text}`);
  if (sections.length === 0) {
    throw new FileExtractionError("PowerPointファイルから抽出できるテキストが見つかりませんでした。");
  }

  const notes: string[] = [];
  if (slides.length > MAX_PPTX_SLIDES) notes.push(`先頭${MAX_PPTX_SLIDES}スライドのみ抽出`);
  if (aborted) notes.push("展開サイズ上限に達したため一部スライドを省略");
  const header = `[PowerPoint: 全${slides.length}スライド${notes.length > 0 ? `（${notes.join("・")}）` : ""}]`;
  return capText([header, ...sections].join("\n\n"), MAX_EXTRACTED_CHARS);
}

export function extractZipText(buffer: Buffer): string {
  const directory = assertZipReadable(buffer);
  const entries = directory.entries;

  const listingLines: string[] = [];
  for (const entry of entries.slice(0, MAX_ZIP_LISTING_LINES)) {
    const label = entry.name.endsWith("/") ? `${entry.name}（フォルダ）` : entry.name;
    listingLines.push(`- ${label}（${formatBytes(entry.uncompressedSize)}）`);
  }
  if (entries.length > MAX_ZIP_LISTING_LINES) {
    listingLines.push(`…他${entries.length - MAX_ZIP_LISTING_LINES}件を省略`);
  }

  const targets = new Set<string>();
  const unsafeNames: string[] = [];
  let oversizeCount = 0;
  for (const entry of entries) {
    const name = entry.name;
    if (name.endsWith("/")) continue;
    if (!isSafeZipPath(name)) {
      unsafeNames.push(name);
      continue;
    }
    const extension = extensionOf(name);
    if (ARCHIVE_EXTENSIONS.has(extension)) continue;
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      oversizeCount += 1;
      continue;
    }
    if (targets.size < MAX_ZIP_TEXT_ENTRIES) targets.add(name);
  }

  const { contents, aborted } = streamZipEntries(buffer, (name) => targets.has(name), {
    perEntryBytes: MAX_ZIP_ENTRY_BYTES,
    totalBytes: MAX_ZIP_TOTAL_UNCOMPRESSED,
  });

  const sections: string[] = [];
  for (const name of targets) {
    const bytes = contents.get(name);
    if (!bytes) continue;
    const text = decodeAsText(bytes);
    if (text === null) continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    sections.push(`=== ${name} ===\n${capText(trimmed, MAX_ZIP_ENTRY_CHARS)}`);
  }

  const parts: string[] = [
    `[ZIPエントリ一覧: 全${entries.length}件]\n${listingLines.join("\n")}`,
  ];
  if (sections.length > 0) {
    parts.push(`[テキスト抽出: ${sections.length}件]\n${sections.join("\n\n")}`);
  }
  const notes: string[] = [];
  if (entries.length === 0) notes.push("アーカイブは空です。");
  if (aborted) notes.push("展開サイズ上限に達したため、以降の抽出を中断しました。");
  if (targets.size === MAX_ZIP_TEXT_ENTRIES) {
    notes.push(`テキスト抽出は先頭${MAX_ZIP_TEXT_ENTRIES}件のみです。`);
  }
  if (oversizeCount > 0) {
    notes.push(`${formatBytes(MAX_ZIP_ENTRY_BYTES)}を超える${oversizeCount}件は抽出していません。`);
  }
  if (unsafeNames.length > 0) {
    notes.push(`安全でないパスの${unsafeNames.length}件は抽出していません。`);
  }
  if (notes.length > 0) parts.push(`[注記] ${notes.join(" ")}`);

  return capText(parts.join("\n\n"), MAX_EXTRACTED_CHARS);
}

/**
 * Dispatch one binary attachment to its parser. All failure paths raise
 * FileExtractionError / TranscriptionError carrying a user-facing message.
 */
async function extractSynchronousBinaryText(
  attachment: BinaryAttachment,
): Promise<string> {
  switch (attachment.family) {
    case "pdf":
      return extractPdfText(attachment.buffer);
    case "docx":
      return extractDocxText(attachment.buffer);
    case "xlsx":
      return extractXlsxText(attachment.buffer);
    case "pptx":
      return extractPptxText(attachment.buffer);
    case "zip":
      return extractZipText(attachment.buffer);
    case "audio":
      throw new FileExtractionError("音声ファイルは同期文書解析の対象外です。");
    default: {
      const exhaustive: never = attachment.family;
      throw new FileExtractionError(`未対応の添付種別です: ${String(exhaustive)}`);
    }
  }
}

export async function extractBinaryText(
  attachment: BinaryAttachment,
  signal?: AbortSignal,
): Promise<string> {
  switch (attachment.family) {
    case "audio": {
      const text = await transcribeAudio({
        buffer: attachment.buffer,
        filename: attachment.name,
        mime: attachment.mime,
        signal,
      });
      if (!text) {
        throw new FileExtractionError("音声から認識できる内容が見つかりませんでした。");
      }
      return capText(`[音声の文字起こし結果]\n${text}`, MAX_EXTRACTED_CHARS);
    }
    case "pdf":
    case "docx":
    case "xlsx":
    case "pptx":
    case "zip":
      return runIsolatedBinaryExtraction(attachment, signal);
    default: {
      const exhaustive: never = attachment.family;
      throw new FileExtractionError(`未対応の添付種別です: ${String(exhaustive)}`);
    }
  }
}

/**
 * Replace every binary attachment of a parsed message with its extracted
 * text, then re-parse so modelText/storedContent/validation are rebuilt.
 * Persisted history therefore contains only the extracted text — binaries
 * are never stored and never re-extracted on later turns.
 */
export async function resolveBinaryAttachments(
  parsed: ParsedUserMessageContent,
  onFileStart?: (name: string) => void,
  signal?: AbortSignal,
): Promise<ParsedUserMessageContent> {
  if (!parsed.hasBinaries) return parsed;

  const incoming: IncomingAttachment[] = [];
  for (const attachment of parsed.attachments) {
    if (signal?.aborted) throw signal.reason ?? new Error("Attachment extraction cancelled");
    if (attachment.kind === "image") {
      incoming.push({ kind: "image", name: attachment.name, content: attachment.content, isBase64: true });
      continue;
    }
    if (attachment.kind === "file") {
      incoming.push({ kind: "file", name: attachment.name, content: attachment.content, isBase64: false });
      continue;
    }

    onFileStart?.(attachment.name);
    const startedAt = Date.now();
    try {
      const text = await extractBinaryText(attachment, signal);
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Attachment extraction cancelled");
      }
      logger.info(
        {
          name: attachment.name,
          family: attachment.family,
          elapsedMs: Date.now() - startedAt,
          extractedChars: text.length,
        },
        "Binary attachment extracted",
      );
      incoming.push({ kind: "file", name: attachment.name, content: text, isBase64: false });
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? new Error("Attachment extraction cancelled");
      if (err instanceof FileExtractionError || err instanceof TranscriptionError) throw err;
      logger.warn({ err, name: attachment.name, family: attachment.family }, "Unexpected extraction failure");
      throw new FileExtractionError(
        `${attachment.name} の解析に失敗しました。ファイルが破損している可能性があります。`,
      );
    }
  }

  return parseUserMessageContent(parsed.question, incoming);
}
