import { deflateRawSync } from "node:zlib";

export type XlsxCell = string | number | boolean | null;

export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: XlsxCell[][];
}

export const XLSX_LIMITS = {
  maxSheets: 100,
  maxRowsPerSheet: 10_000,
  maxColumnsPerSheet: 256,
  maxCellsPerWorkbook: 200_000,
  maxCellTextChars: 32_767,
  maxSheetNameChars: 31,
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxZipEntries: 65_535,
} as const;

const EXCEL_MAX_ROWS = 1_048_576;
const EXCEL_MAX_COLUMNS = 16_384;
const ZIP32_MAX = 0xffff_ffff;
const ZIP32_MAX_ENTRIES = 0xffff;
const INVALID_SHEET_NAME = /[\\/*?:[\]]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const encoder = new TextEncoder();

export class XlsxLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxLimitError";
  }
}

function assertZip32Integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX) {
    throw new XlsxLimitError(`XLSX ZIP32 ${label} is out of range`);
  }
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlText(value: string): string {
  const escaped = xmlEscape(value.replace(CONTROL_CHARS, ""));
  return escaped.startsWith(" ") || escaped.endsWith(" ")
    ? `<t xml:space="preserve">${escaped}</t>`
    : `<t>${escaped}</t>`;
}

function columnName(column: number): string {
  let result = "";
  for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  }
  return result;
}

function cellXml(value: XlsxCell): string {
  if (value === null) return "";
  if (typeof value === "string") {
    // inlineStr cells have no formula element; formula-like input remains text.
    return `<c t="inlineStr"><is>${xmlText(value)}</is></c>`;
  }
  if (typeof value === "boolean") {
    return `<c t="b"><v>${value ? "1" : "0"}</v></c>`;
  }
  if (!Number.isFinite(value)) {
    throw new XlsxLimitError("XLSX numeric cells must be finite numbers");
  }
  return `<c><v>${String(value)}</v></c>`;
}

function normalizeSheetName(rawName: string, used: Set<string>): string {
  let name = rawName.replace(INVALID_SHEET_NAME, " ").replace(CONTROL_CHARS, "").trim();
  if (!name) name = "Sheet";
  name = name.slice(0, XLSX_LIMITS.maxSheetNameChars).trim() || "Sheet";

  const base = name;
  let suffix = 1;
  while (used.has(name.toLowerCase())) {
    const marker = ` (${suffix++})`;
    name = `${base.slice(0, XLSX_LIMITS.maxSheetNameChars - marker.length)}${marker}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function makeSheetXml(sheet: XlsxSheet, sheetIndex: number): string {
  const rows = [sheet.headers, ...sheet.rows];
  const maxColumns = Math.max(0, ...rows.map((row) => row.length));
  if (rows.length > EXCEL_MAX_ROWS || rows.length > XLSX_LIMITS.maxRowsPerSheet) {
    throw new XlsxLimitError(
      `XLSX sheet ${sheetIndex + 1} exceeds the ${XLSX_LIMITS.maxRowsPerSheet}-row server limit`,
    );
  }
  if (maxColumns > EXCEL_MAX_COLUMNS || maxColumns > XLSX_LIMITS.maxColumnsPerSheet) {
    throw new XlsxLimitError(
      `XLSX sheet ${sheetIndex + 1} exceeds the ${XLSX_LIMITS.maxColumnsPerSheet}-column server limit`,
    );
  }

  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (typeof value === "string" && value.length > XLSX_LIMITS.maxCellTextChars) {
            throw new XlsxLimitError(
              `XLSX cell ${columnName(columnIndex)}${rowIndex + 1} exceeds the ${XLSX_LIMITS.maxCellTextChars}-character limit`,
            );
          }
          const content = cellXml(value);
          return content ? `<c r="${columnName(columnIndex)}${rowIndex + 1}"${content.slice(2)}` : "";
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  const dimension = rows.length && maxColumns
    ? `<dimension ref="A1:${columnName(maxColumns - 1)}${rows.length}"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension}<sheetData>${rowXml}</sheetData></worksheet>`;
}

function u16(value: number): Buffer {
  assertZip32Integer(value, "16-bit field");
  if (value > 0xffff) throw new XlsxLimitError("XLSX ZIP16 field is out of range");
  const out = Buffer.allocUnsafe(2);
  out.writeUInt16LE(value);
  return out;
}

function u32(value: number): Buffer {
  assertZip32Integer(value, "32-bit field");
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32LE(value);
  return out;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function zipStore(entries: Array<{ name: string; content: string }>): Buffer {
  if (entries.length === 0 || entries.length > ZIP32_MAX_ENTRIES || entries.length > XLSX_LIMITS.maxZipEntries) {
    throw new XlsxLimitError("XLSX ZIP entry count exceeds ZIP32 limits");
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const source = Buffer.from(entry.content, "utf8");
    if (name.length > 0xffff) throw new XlsxLimitError("XLSX ZIP entry name exceeds ZIP16 limits");
    const compressed = deflateRawSync(source, { level: 6 });
    assertZip32Integer(source.length, "uncompressed entry size");
    assertZip32Integer(compressed.length, "compressed entry size");
    assertZip32Integer(offset, "local entry offset");

    const crc = crc32(source);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x800), u16(8), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(source.length), u16(name.length), u16(0),
      name, compressed,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(8), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(source.length), u16(name.length), u16(0),
      u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
    assertZip32Integer(offset, "next local entry offset");
  }

  const central = Buffer.concat(centralParts);
  assertZip32Integer(central.length, "central directory size");
  assertZip32Integer(offset + central.length, "archive payload size");
  const output = Buffer.concat([
    ...localParts,
    central,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  assertXlsxOutputWithinLimit(output);
  return output;
}

export function assertXlsxOutputWithinLimit(output: Buffer): void {
  if (output.length > XLSX_LIMITS.maxOutputBytes) {
    throw new XlsxLimitError(`XLSX output exceeds the ${XLSX_LIMITS.maxOutputBytes}-byte limit`);
  }
}

export function normalizeXlsxSheets(sheets: XlsxSheet[]): XlsxSheet[] {
  if (sheets.length === 0) throw new XlsxLimitError("XLSX workbook must contain at least one sheet");
  if (sheets.length > XLSX_LIMITS.maxSheets) {
    throw new XlsxLimitError(`XLSX workbook exceeds the ${XLSX_LIMITS.maxSheets}-sheet server limit`);
  }
  const used = new Set<string>();
  return sheets.map((sheet) => ({ ...sheet, name: normalizeSheetName(sheet.name, used) }));
}

export function writeXlsx(sheets: XlsxSheet[]): Buffer {
  const normalizedSheets = normalizeXlsxSheets(sheets);
  let inputBytes = 0;
  let totalCells = 0;
  for (const sheet of normalizedSheets) {
    inputBytes += utf8Bytes(sheet.name);
    const rows = [sheet.headers, ...sheet.rows];
    for (const row of rows) {
      for (const value of row) {
        if (typeof value === "string") inputBytes += utf8Bytes(value);
        if (value !== null) totalCells++;
      }
    }
  }
  if (inputBytes > XLSX_LIMITS.maxInputBytes) {
    throw new XlsxLimitError(`XLSX UTF-8 input exceeds the ${XLSX_LIMITS.maxInputBytes}-byte limit`);
  }
  if (totalCells > XLSX_LIMITS.maxCellsPerWorkbook) {
    throw new XlsxLimitError(`XLSX workbook exceeds the ${XLSX_LIMITS.maxCellsPerWorkbook}-cell server limit`);
  }
  const worksheets = normalizedSheets.map(makeSheetXml);
  const workbookSheets = normalizedSheets.map((sheet, index) =>
    `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const workbookRels = normalizedSheets.map((_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const contentTypes = normalizedSheets.map((_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");

  return zipStore([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${contentTypes}</Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}</Relationships>` },
    ...worksheets.map((content, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content })),
  ]);
}