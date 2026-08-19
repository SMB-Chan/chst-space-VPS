import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from "docx";
import * as XLSX from "xlsx";
import PptxGenJS from "pptxgenjs";

export type FileFormat = "pdf" | "docx" | "xlsx" | "pptx";

export interface FileGenerationOptions {
  /** Explicitly requested format (from frontend picker). */
  requestedFormat?: FileFormat | null;
  /** Base filename without extension; a default is used when omitted. */
  filename?: string;
  /** Structured data from a previous generation attempt. */
  previousData?: ParsedFileData | null;
  /** Human-readable review feedback to incorporate into the next attempt. */
  feedback?: string;
}

export interface GeneratedFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  size: number;
  format: FileFormat;
}

interface SheetData {
  name: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
}

interface SlideData {
  title: string;
  bullets: string[];
}

export interface ParsedFileData {
  title?: string;
  content?: string;
  sheets?: SheetData[];
  slides?: SlideData[];
}

const FORMAT_MIME_TYPES: Record<FileFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const FORMAT_EXTENSIONS: Record<FileFormat, string> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
};

const FORMAT_KEYWORDS: Record<FileFormat, RegExp[]> = {
  pdf: [/pdf/i, /PDF/i, /レポート.*(pdf|PDF)/, /pdf.*レポート/],
  docx: [/word/i, /docx/i, /doc/i, /ドキュメント/, /文書/],
  xlsx: [/excel/i, /xlsx/i, /xls/i, /スプレッドシート/, /表.*エクセル/, /エクセル/],
  pptx: [/powerpoint/i, /pptx/i, /ppt/i, /スライド/, /プレゼン/, /パワーポイント/],
};

/**
 * Detect the requested file format from free-form user text, or fall back to
 * the explicitly selected format. Returns null when nothing is requested.
 */
export function detectFileFormat(
  userText: string,
  requested?: FileFormat | null,
): FileFormat | null {
  if (requested) return requested;
  const sample = userText.slice(0, 4000);
  const order: FileFormat[] = ["pdf", "docx", "xlsx", "pptx"];
  for (const fmt of order) {
    if (FORMAT_KEYWORDS[fmt].some((re) => re.test(sample))) return fmt;
  }
  return null;
}

export function generateFilename(format: FileFormat, title?: string): string {
  const safeTitle = title
    ? title.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 64)
    : "chat-space-export";
  return `${safeTitle}.${FORMAT_EXTENSIONS[format]}`;
}

/**
 * Build a prompt asking the model to return structured file content wrapped in
 * <file_data> JSON tags. The response should ONLY contain the JSON block.
 */
export function buildFileGenerationPrompt(
  format: FileFormat,
  conversationSummary: string,
  options: Pick<FileGenerationOptions, "previousData" | "feedback"> = {},
): string {
  const formatInstructions: Record<FileFormat, string> = {
    pdf:
      '{"title": "Document title", "content": "Full markdown content with headings, paragraphs and bullet lists"}',
    docx:
      '{"title": "Document title", "content": "Full markdown content with headings, paragraphs and bullet lists"}',
    xlsx:
      '{"title": "Workbook title", "sheets": [{"name": "Sheet1", "headers": ["Column A", "Column B"], "rows": [["a1", "b1"], ["a2", "b2"]]}]}',
    pptx:
      '{"title": "Presentation title", "slides": [{"title": "Slide title", "bullets": ["Point 1", "Point 2"]}]}',
  };

  const parts = [
    "You are a document generation assistant. Based on the conversation below, produce structured content for a downloadable file.",
    "",
    `Requested format: ${format.toUpperCase()}`,
    "",
    "Return ONLY a JSON object wrapped in <file_data>...</file_data> tags. Do not include markdown explanations outside the tags.",
    "",
    "Schema:",
    `<file_data>\n${formatInstructions[format]}\n</file_data>`,
  ];

  if (options.previousData) {
    parts.push("");
    parts.push("Previous structured data (preserve the title and structure unless the feedback says otherwise):");
    parts.push(JSON.stringify(options.previousData));
  }

  if (options.feedback) {
    parts.push("");
    parts.push("Review feedback to incorporate:");
    parts.push(options.feedback);
  }

  parts.push("");
  parts.push("Conversation summary:");
  parts.push(conversationSummary);

  return parts.join("\n");
}

/**
 * Parse the <file_data> JSON block from LLM output.
 */
export function parseFileData(rawText: string): ParsedFileData | null {
  const match = rawText.match(/<file_data>\s*([\s\S]*?)\s*<\/file_data>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as ParsedFileData;
  } catch {
    return null;
  }
}

export async function renderFile(
  format: FileFormat,
  rawModelOutput: string,
  options: FileGenerationOptions = {},
): Promise<GeneratedFile> {
  const newlyParsed = parseFileData(rawModelOutput) ?? {};
  const parsed = mergeFileData(options.previousData ?? {}, newlyParsed);
  const title = parsed.title || options.filename || "Chat Space Export";

  switch (format) {
    case "pdf":
      return renderPdf(parsed, title, format);
    case "docx":
      return renderDocx(parsed, title, format);
    case "xlsx":
      return renderXlsx(parsed, title, format);
    case "pptx":
      return renderPptx(parsed, title, format);
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unsupported format: ${_exhaustive}`);
    }
  }
}

function mergeFileData(base: ParsedFileData, update: ParsedFileData): ParsedFileData {
  return {
    title: update.title ?? base.title,
    content: update.content ?? base.content,
    sheets: update.sheets ?? base.sheets,
    slides: update.slides ?? base.slides,
  };
}

function normalizeContent(parsed: ParsedFileData, fallback: string): string {
  return (parsed.content ?? fallback).replace(/\r\n/g, "\n").trim();
}

async function renderPdf(parsed: ParsedFileData, title: string, format: FileFormat): Promise<GeneratedFile> {
  const content = normalizeContent(parsed, title);
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 50;
  const maxWidth = pageWidth - margin * 2;
  const lineHeight = 14;
  const footerMargin = 40;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const drawText = (text: string, opts: { font?: typeof font; size?: number; indent?: number } = {}) => {
    const f = opts.font ?? font;
    const size = opts.size ?? 11;
    const indent = opts.indent ?? 0;
    const words = text.split(" ");
    let line = "";

    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      const width = f.widthOfTextAtSize(test, size);
      if (width > maxWidth - indent && line) {
        if (y < margin + footerMargin) {
          page = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - margin;
        }
        page.drawText(line, { x: margin + indent, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
        y -= lineHeight * (size / 11);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      if (y < margin + footerMargin) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      page.drawText(line, { x: margin + indent, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
      y -= lineHeight * (size / 11);
    }
  };

  // Title
  drawText(title, { font: boldFont, size: 18 });
  y -= 12;

  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      y -= lineHeight;
      continue;
    }
    if (line.startsWith("# ")) {
      y -= 8;
      drawText(line.slice(2), { font: boldFont, size: 16 });
      y -= 6;
    } else if (line.startsWith("## ")) {
      y -= 6;
      drawText(line.slice(3), { font: boldFont, size: 14 });
      y -= 4;
    } else if (line.startsWith("### ")) {
      drawText(line.slice(4), { font: boldFont, size: 12 });
      y -= 2;
    } else if (line.startsWith("- ")) {
      drawText(`• ${line.slice(2)}`, { indent: 12 });
    } else {
      drawText(line);
    }
  }

  const buffer = Buffer.from(await pdfDoc.save());
  return {
    buffer,
    filename: generateFilename("pdf", title),
    mimeType: FORMAT_MIME_TYPES.pdf,
    size: buffer.length,
    format,
  };
}

function markdownToDocxParagraphs(content: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = content.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("# ")) {
      paragraphs.push(
        new Paragraph({
          text: line.slice(2),
          heading: HeadingLevel.HEADING_1,
          spacing: { after: 120 },
        }),
      );
    } else if (line.startsWith("## ")) {
      paragraphs.push(
        new Paragraph({
          text: line.slice(3),
          heading: HeadingLevel.HEADING_2,
          spacing: { after: 100 },
        }),
      );
    } else if (line.startsWith("### ")) {
      paragraphs.push(
        new Paragraph({
          text: line.slice(4),
          heading: HeadingLevel.HEADING_3,
          spacing: { after: 80 },
        }),
      );
    } else if (line.startsWith("- ")) {
      paragraphs.push(
        new Paragraph({
          text: line.slice(2),
          bullet: { level: 0 },
          spacing: { after: 80 },
        }),
      );
    } else {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun(line)],
          spacing: { after: 100 },
          alignment: AlignmentType.LEFT,
        }),
      );
    }
  }

  return paragraphs;
}

async function renderDocx(parsed: ParsedFileData, title: string, format: FileFormat): Promise<GeneratedFile> {
  const content = normalizeContent(parsed, title);
  const children: Paragraph[] = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
    }),
    ...markdownToDocxParagraphs(content),
  ];

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  const buffer = Buffer.from(await Packer.toBuffer(doc));
  return {
    buffer,
    filename: generateFilename("docx", title),
    mimeType: FORMAT_MIME_TYPES.docx,
    size: buffer.length,
    format,
  };
}

function normalizeSheets(parsed: ParsedFileData, title: string): SheetData[] {
  if (parsed.sheets && parsed.sheets.length > 0) {
    return parsed.sheets.map((sheet) => ({
      name: sheet.name || "Sheet1",
      headers: Array.isArray(sheet.headers) ? sheet.headers : [],
      rows: Array.isArray(sheet.rows) ? sheet.rows : [],
    }));
  }

  // Fallback: put the textual content into a single sheet.
  const lines = (parsed.content ?? title).split("\n").filter((l) => l.trim());
  return [
    {
      name: "Content",
      headers: ["Item"],
      rows: lines.map((line) => [line.trim()]),
    },
  ];
}

async function renderXlsx(parsed: ParsedFileData, title: string, format: FileFormat): Promise<GeneratedFile> {
  const workbook = XLSX.utils.book_new();
  const sheets = normalizeSheets(parsed, title);

  for (const sheet of sheets) {
    const data = [sheet.headers, ...sheet.rows];
    const worksheet = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name.slice(0, 31));
  }

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return {
    buffer,
    filename: generateFilename("xlsx", title),
    mimeType: FORMAT_MIME_TYPES.xlsx,
    size: buffer.length,
    format,
  };
}

function normalizeSlides(parsed: ParsedFileData, title: string): SlideData[] {
  if (parsed.slides && parsed.slides.length > 0) {
    return parsed.slides.map((slide) => ({
      title: slide.title || "Slide",
      bullets: Array.isArray(slide.bullets) ? slide.bullets : [],
    }));
  }

  const lines = (parsed.content ?? title).split("\n").filter((l) => l.trim());
  return [
    {
      title,
      bullets: lines,
    },
  ];
}

async function renderPptx(parsed: ParsedFileData, title: string, format: FileFormat): Promise<GeneratedFile> {
  const pres = new PptxGenJS();
  pres.title = title;
  pres.subject = "Generated by Chat Space";

  const slides = normalizeSlides(parsed, title);
  for (const slide of slides) {
    const s = pres.addSlide();
    s.addText(slide.title, { x: 0.5, y: 0.5, w: "90%", h: 1, fontSize: 24, bold: true });
    if (slide.bullets.length > 0) {
      s.addText(
        slide.bullets.map((b) => ({ text: b, options: { breakLine: true } })),
        { x: 0.5, y: 1.5, w: "90%", h: "70%", fontSize: 16, bullet: true },
      );
    }
  }

  const buffer = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  return {
    buffer,
    filename: generateFilename("pptx", title),
    mimeType: FORMAT_MIME_TYPES.pptx,
    size: buffer.length,
    format,
  };
}
