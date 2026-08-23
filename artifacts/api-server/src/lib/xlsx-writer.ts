import { deflateRawSync } from "node:zlib";

export type XlsxCell = string | number | boolean | null;

export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: XlsxCell[][];
}

export interface XlsxWriterLimits {
  maxSheets: number;
  maxRowsPerSheet: number;
  maxColumnsPerSheet: number;
  maxNonNullCells: number;
  maxCellCharacters: number;
  maxTextBytes: number;
  maxOutputBytes: number;
}

export const DEFAULT_XLSX_WRITER_LIMITS: Readonly<XlsxWriterLimits> = Object.freeze({
  maxSheets: 100,
  maxRowsPerSheet: 10_000,
  maxColumnsPerSheet: 256,
  maxNonNullCells: 200_000,
  maxCellCharacters: 32_767,
  maxTextBytes: 16 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
});

const EXCEL_MAX_ROWS = 1_048_576;
const EXCEL_MAX_COLUMNS = 16_384;
const EXCEL_MAX_SHEET_NAME_CHARACTERS = 31;
const ZIP32_MAX_ENTRIES = 65_535;
const ZIP32_MAX_VALUE = 0xffff_ffff;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DEFLATE_METHOD = 8;
const ZIP_DOS_EPOCH_DATE = 33;

interface NormalizedSheet {
  name: string;
  headers: string[];
  rows: XlsxCell[][];
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function resolveLimits(overrides: Partial<XlsxWriterLimits>): XlsxWriterLimits {
  const limits = { ...DEFAULT_XLSX_WRITER_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`XLSX ${name} must be a positive safe integer`);
    }
  }
  if (limits.maxSheets + 4 > ZIP32_MAX_ENTRIES) {
    throw new Error("XLSX sheet limit exceeds the ZIP32 entry limit");
  }
  if (limits.maxRowsPerSheet > EXCEL_MAX_ROWS) {
    throw new Error("XLSX row limit exceeds the Excel format limit");
  }
  if (limits.maxColumnsPerSheet > EXCEL_MAX_COLUMNS) {
    throw new Error("XLSX column limit exceeds the Excel format limit");
  }
  if (limits.maxOutputBytes > ZIP32_MAX_VALUE) {
    throw new Error("XLSX output limit exceeds the ZIP32 size limit");
  }
  return limits;
}

function stripInvalidXmlCharacters(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
}

function escapeXml(value: string): string {
  return stripInvalidXmlCharacters(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncateSheetName(value: string, maxCharacters: number): string {
  return Array.from(value).slice(0, maxCharacters).join("");
}

function normalizeSheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((rawName, index) => {
    const cleaned = stripInvalidXmlCharacters(rawName)
      .replace(/[\\/:?*\[\]]/g, "_")
      .trim()
      .replace(/^'+|'+$/g, "");
    const fallback = `Sheet${index + 1}`;
    const base = truncateSheetName(cleaned || fallback, EXCEL_MAX_SHEET_NAME_CHARACTERS);
    let candidate = base;
    let suffixNumber = 1;
    while (used.has(candidate.toLocaleLowerCase("en-US"))) {
      const suffix = ` (${suffixNumber})`;
      candidate = `${truncateSheetName(
        base,
        EXCEL_MAX_SHEET_NAME_CHARACTERS - Array.from(suffix).length,
      )}${suffix}`;
      suffixNumber += 1;
    }
    used.add(candidate.toLocaleLowerCase("en-US"));
    return candidate;
  });
}

function validateAndNormalizeSheets(
  sheets: readonly XlsxSheet[],
  limits: XlsxWriterLimits,
): NormalizedSheet[] {
  if (sheets.length === 0) throw new Error("XLSX workbook must contain at least one sheet");
  if (sheets.length > limits.maxSheets) {
    throw new Error(`XLSX workbook exceeds the ${limits.maxSheets}-sheet limit`);
  }

  const normalizedNames = normalizeSheetNames(sheets.map((sheet) => sheet.name));
  let nonNullCells = 0;
  let textBytes = 0;

  const countText = (value: string): void => {
    if (value.length > limits.maxCellCharacters) {
      throw new Error(
        `XLSX cell text exceeds the ${limits.maxCellCharacters}-character limit`,
      );
    }
    textBytes += Buffer.byteLength(value, "utf8");
    if (textBytes > limits.maxTextBytes) {
      throw new Error(`XLSX text exceeds the ${limits.maxTextBytes}-byte limit`);
    }
  };

  return sheets.map((sheet, sheetIndex) => {
    const rowCount = 1 + sheet.rows.length;
    if (rowCount > limits.maxRowsPerSheet || rowCount > EXCEL_MAX_ROWS) {
      throw new Error(
        `XLSX sheet exceeds the ${limits.maxRowsPerSheet}-row server limit`,
      );
    }

    const rows: XlsxCell[][] = [sheet.headers, ...sheet.rows];
    for (const row of rows) {
      if (row.length > limits.maxColumnsPerSheet || row.length > EXCEL_MAX_COLUMNS) {
        throw new Error(
          `XLSX sheet exceeds the ${limits.maxColumnsPerSheet}-column server limit`,
        );
      }
      for (const cell of row) {
        if (cell === null) continue;
        nonNullCells += 1;
        if (nonNullCells > limits.maxNonNullCells) {
          throw new Error(
            `XLSX workbook exceeds the ${limits.maxNonNullCells}-cell limit`,
          );
        }
        if (typeof cell === "string") countText(cell);
        else if (typeof cell === "number" && !Number.isFinite(cell)) {
          throw new Error("XLSX numeric cells must be finite numbers");
        }
      }
    }

    textBytes += Buffer.byteLength(normalizedNames[sheetIndex], "utf8");
    if (textBytes > limits.maxTextBytes) {
      throw new Error(`XLSX text exceeds the ${limits.maxTextBytes}-byte limit`);
    }

    return {
      name: normalizedNames[sheetIndex],
      headers: [...sheet.headers],
      rows: sheet.rows.map((row) => [...row]),
    };
  });
}

function columnName(columnIndex: number): string {
  let value = columnIndex + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function cellXml(value: XlsxCell, reference: string): string {
  if (value === null) return "";
  if (typeof value === "string") {
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  return `<c r="${reference}" t="n"><v>${Object.is(value, -0) ? "0" : String(value)}</v></c>`;
}

function worksheetXml(sheet: NormalizedSheet): string {
  const chunks = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  ];
  const rows: XlsxCell[][] = [sheet.headers, ...sheet.rows];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const rowNumber = rowIndex + 1;
    const cells: string[] = [];
    const row = rows[rowIndex];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const reference = `${columnName(columnIndex)}${rowNumber}`;
      const rendered = cellXml(row[columnIndex], reference);
      if (rendered) cells.push(rendered);
    }
    chunks.push(`<row r="${rowNumber}">${cells.join("")}</row>`);
  }
  chunks.push("</sheetData></worksheet>");
  return chunks.join("");
}

function workbookXml(sheets: readonly NormalizedSheet[]): string {
  const sheetNodes = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets>${sheetNodes}</sheets></workbook>`,
  ].join("");
}

function workbookRelationshipsXml(sheetCount: number): string {
  const relationships = Array.from({ length: sheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    relationships,
    "</Relationships>",
  ].join("");
}

function contentTypesXml(sheetCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    sheets,
    "</Types>",
  ].join("");
}

const ROOT_RELATIONSHIPS_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
  "</Relationships>",
].join("");

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function assertZip32Value(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX_VALUE) {
    throw new Error(`XLSX ${label} exceeds the ZIP32 limit`);
  }
}

function createZip(entries: readonly ZipEntry[], maxOutputBytes: number): Buffer {
  if (entries.length === 0 || entries.length > ZIP32_MAX_ENTRIES) {
    throw new Error("XLSX ZIP entry count is outside the ZIP32 range");
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    if (name.length === 0 || name.length > 0xffff) {
      throw new Error("XLSX ZIP entry name is outside the ZIP32 range");
    }
    const compressed = deflateRawSync(entry.data, { level: 6 });
    assertZip32Value(entry.data.length, "uncompressed entry size");
    assertZip32Value(compressed.length, "compressed entry size");
    assertZip32Value(localOffset, "local header offset");

    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(ZIP_DEFLATE_METHOD, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(ZIP_DOS_EPOCH_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(ZIP_DEFLATE_METHOD, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(ZIP_DOS_EPOCH_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    localParts.push(localHeader, name, compressed);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressed.length;
    centralSize += centralHeader.length + name.length;
    assertZip32Value(localOffset, "central directory offset");
    assertZip32Value(centralSize, "central directory size");

    if (localOffset + centralSize + 22 > maxOutputBytes) {
      throw new Error(`XLSX output exceeds the ${maxOutputBytes}-byte limit`);
    }
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  const output = Buffer.concat([...localParts, ...centralParts, end]);
  if (output.length > maxOutputBytes) {
    throw new Error(`XLSX output exceeds the ${maxOutputBytes}-byte limit`);
  }
  return output;
}

export function writeXlsxWorkbook(
  inputSheets: readonly XlsxSheet[],
  limitOverrides: Partial<XlsxWriterLimits> = {},
): Buffer {
  const limits = resolveLimits(limitOverrides);
  const sheets = validateAndNormalizeSheets(inputSheets, limits);
  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(contentTypesXml(sheets.length), "utf8"),
    },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELATIONSHIPS_XML, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml(sheets), "utf8") },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(workbookRelationshipsXml(sheets.length), "utf8"),
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: Buffer.from(worksheetXml(sheet), "utf8"),
    })),
  ];
  return createZip(entries, limits.maxOutputBytes);
}
