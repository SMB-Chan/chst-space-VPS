import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  XLSX_LIMITS,
  XlsxLimitError,
  assertXlsxOutputWithinLimit,
  normalizeXlsxSheets,
  writeXlsx,
} from "./xlsx-writer";

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function readZipEntries(buffer: Buffer): Array<{ name: string; content: Buffer; crc: number }> {
  const entries: Array<{ name: string; content: Buffer; crc: number }> = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    entries.push({ name, content, crc: expectedCrc });
    offset = dataStart + compressedSize;
  }
  return entries;
}

const libreOfficeAvailable = spawnSync("libreoffice", ["--version"], { stdio: "ignore" }).status === 0;

describe("safe write-only XLSX writer", () => {
  it("writes typed multi-sheet OOXML with valid CRCs and central-directory entries", () => {
    const output = writeXlsx([
      {
        name: "売上",
        headers: ["文字列", "数値", "真偽", "空", "極端値"],
        rows: [["東京", 42.5, true, null, Number.MAX_VALUE]],
      },
      { name: "売上", headers: ["日本語"], rows: [["データ"]] },
    ]);
    expect(output.subarray(0, 4).readUInt32LE()).toBe(0x04034b50);
    const entries = readZipEntries(output);
    expect(entries).toHaveLength(6);
    for (const entry of entries) expect(entry.crc).toBe(crc32(entry.content));
    expect(entries.map((entry) => entry.name)).toContain("xl/workbook.xml");
    expect(entries.map((entry) => entry.name)).toContain("xl/worksheets/sheet2.xml");
    const workbook = entries.find((entry) => entry.name === "xl/workbook.xml")!.content.toString();
    expect(workbook).toContain('name="売上"');
    expect(workbook).toContain('name="売上 (1)"');
    const sheet = entries.find((entry) => entry.name === "xl/worksheets/sheet1.xml")!.content.toString();
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain("<v>42.5</v>");
    expect(sheet).toContain('t="b"><v>1</v>');
    expect(sheet).not.toContain("<f>");
    const eocdOffset = output.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocdOffset).toBeGreaterThan(0);
    expect(output.readUInt16LE(eocdOffset + 8)).toBe(entries.length);
    expect(output.readUInt16LE(eocdOffset + 10)).toBe(entries.length);
    const centralSize = output.readUInt32LE(eocdOffset + 12);
    const centralOffset = output.readUInt32LE(eocdOffset + 16);
    expect(centralOffset + centralSize).toBe(eocdOffset);
  });

  it.each(["=1+1", "+SUM(A1)", "-1+1", "@cmd", "\t=1+1", "\n=1+1"])(
    "keeps formula-like string %j out of formula elements",
    (value) => {
      const output = writeXlsx([{ name: "Sheet", headers: ["value"], rows: [[value]] }]);
      const sheet = readZipEntries(output).find((entry) => entry.name.endsWith("sheet1.xml"))!.content.toString();
      expect(sheet).toContain('t="inlineStr"');
      expect(sheet).not.toContain("<f>");
      expect(sheet).toContain(value);
    },
  );

  it("normalizes invalid, empty, duplicate, and overlong sheet names", () => {
    const sheets = normalizeXlsxSheets([
      { name: " /\\:*?[ ] ", headers: [], rows: [] },
      { name: "", headers: [], rows: [] },
      { name: "Sheet", headers: [], rows: [] },
      { name: "x".repeat(100), headers: [], rows: [] },
    ]);
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Sheet", "Sheet (1)", "Sheet (2)", "x".repeat(31)]);
  });

  it("rejects non-finite numbers and preserves extreme finite numbers", () => {
    expect(() => writeXlsx([{ name: "Sheet", headers: [Number.NaN], rows: [] }])).toThrow(XlsxLimitError);
    expect(() => writeXlsx([{ name: "Sheet", headers: [Number.POSITIVE_INFINITY], rows: [] }])).toThrow(XlsxLimitError);
    const output = writeXlsx([{ name: "Sheet", headers: [Number.MAX_VALUE, Number.MIN_VALUE], rows: [] }]);
    const sheet = readZipEntries(output).find((entry) => entry.name.endsWith("sheet1.xml"))!.content.toString();
    expect(sheet).toContain(String(Number.MAX_VALUE));
    expect(sheet).toContain(String(Number.MIN_VALUE));
  });

  it("enforces workbook, row, column, cell, and UTF-8 input caps", () => {
    expect(() => writeXlsx([])).toThrow(XlsxLimitError);
    expect(() => writeXlsx(Array.from({ length: XLSX_LIMITS.maxSheets + 1 }, () => ({
      name: "Sheet", headers: [], rows: [],
    })))).toThrow(/sheet server limit/);
    expect(() => writeXlsx([{
      name: "Sheet", headers: ["x".repeat(XLSX_LIMITS.maxCellTextChars + 1)], rows: [],
    }])).toThrow(/character limit/);
    expect(() => writeXlsx([{
      name: "Sheet", headers: [], rows: Array.from({ length: XLSX_LIMITS.maxRowsPerSheet }, () => []),
    }])).toThrow(/row server limit/);
    expect(() => writeXlsx([{
      name: "Sheet", headers: Array.from({ length: XLSX_LIMITS.maxColumnsPerSheet + 1 }, () => "x"), rows: [],
    }])).toThrow(/column server limit/);
    const long = "a".repeat(XLSX_LIMITS.maxCellTextChars);
    const overInput = Array.from({ length: 513 }, () => long);
    expect(() => writeXlsx([{ name: "Sheet", headers: overInput.slice(0, 256), rows: [overInput.slice(256)] }]))
      .toThrow(/UTF-8 input/);
  });

  it("enforces the final 16 MiB output cap", () => {
    expect(() => assertXlsxOutputWithinLimit(Buffer.alloc(XLSX_LIMITS.maxOutputBytes + 1)))
      .toThrow(/output exceeds/);
    expect(() => assertXlsxOutputWithinLimit(Buffer.alloc(XLSX_LIMITS.maxOutputBytes)))
      .not.toThrow();
  });

  it.runIf(libreOfficeAvailable)("opens successfully in LibreOffice when available", () => {
    const dir = mkdtempSync(join(tmpdir(), "safe-xlsx-"));
    const input = join(dir, "test.xlsx");
    const outputDir = join(dir, "out");
    mkdirSync(outputDir);
    writeFileSync(input, writeXlsx([{ name: "日本語", headers: ["項目"], rows: [["開閉テスト"]] }]));
    try {
      execFileSync("libreoffice", ["--headless", "--convert-to", "pdf", "--outdir", outputDir, input], {
        stdio: "pipe",
        timeout: 30_000,
      });
      const pdf = readFileSync(join(outputDir, "test.pdf"));
      expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
