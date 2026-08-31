import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { writeXlsxWorkbook } from "./xlsx-writer";

interface ParsedZipEntry {
  crc: number;
  data: Buffer;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function independentCrc32(buffer: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function parseZip(buffer: Buffer): Map<string, ParsedZipEntry> {
  const endOffset = buffer.length - 22;
  expect(buffer.readUInt32LE(endOffset)).toBe(0x06054b50);
  expect(buffer.readUInt16LE(endOffset + 4)).toBe(0);
  expect(buffer.readUInt16LE(endOffset + 6)).toBe(0);
  expect(buffer.readUInt16LE(endOffset + 20)).toBe(0);

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  expect(centralOffset + centralSize).toBe(endOffset);

  const entries = new Map<string, ParsedZipEntry>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    expect(buffer.readUInt16LE(offset + 8) & 0x0800).toBe(0x0800);
    expect(buffer.readUInt16LE(offset + 10)).toBe(8);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");

    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(buffer.readUInt16LE(localOffset + 6) & 0x0800).toBe(0x0800);
    expect(buffer.readUInt16LE(localOffset + 8)).toBe(8);
    expect(buffer.readUInt32LE(localOffset + 14)).toBe(crc);
    expect(buffer.readUInt32LE(localOffset + 18)).toBe(compressedSize);
    expect(buffer.readUInt32LE(localOffset + 22)).toBe(uncompressedSize);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = inflateRawSync(
      buffer.subarray(dataOffset, dataOffset + compressedSize),
    );
    expect(data.length).toBe(uncompressedSize);
    expect(independentCrc32(data)).toBe(crc);

    entries.set(name, {
      crc,
      data,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  expect(offset).toBe(endOffset);
  expect(entries.size).toBe(entryCount);
  return entries;
}

describe("writeXlsxWorkbook", () => {
  it("creates a deterministic, structurally consistent multi-sheet ZIP", () => {
    const sheets = [
      {
        name: "売上/2026",
        headers: ["項目", "金額", "承認"],
        rows: [
          ["製品A", 1_000, true],
          ["製品B", 2_000, false],
        ],
      },
      {
        name: "売上:2026",
        headers: ["注記"],
        rows: [["重複名は安全に正規化"]],
      },
    ];
    const first = writeXlsxWorkbook(sheets);
    const second = writeXlsxWorkbook(sheets);
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(0, 2).toString("ascii")).toBe("PK");

    const entries = parseZip(first);
    expect([...entries.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]);
    const workbook =
      entries.get("xl/workbook.xml")?.data.toString("utf8") ?? "";
    expect(workbook).toContain('name="売上_2026"');
    expect(workbook).toContain('name="売上_2026 (1)"');
    const worksheet =
      entries.get("xl/worksheets/sheet1.xml")?.data.toString("utf8") ?? "";
    expect(worksheet).toContain('<c r="B2" t="n"><v>1000</v></c>');
    expect(worksheet).toContain('<c r="C2" t="b"><v>1</v></c>');
  });

  it("keeps every formula-like string as literal inline text", () => {
    const values = ["=1+1", "+SUM(A1:A2)", "-1+2", "@cmd", "\t=cmd", "\n=cmd"];
    const workbook = writeXlsxWorkbook([
      {
        name: "Formula safety",
        headers: ["value"],
        rows: values.map((value) => [value]),
      },
    ]);
    const worksheet =
      parseZip(workbook)
        .get("xl/worksheets/sheet1.xml")
        ?.data.toString("utf8") ?? "";
    expect(worksheet.match(/t="inlineStr"/g)).toHaveLength(values.length + 1);
    expect(worksheet).not.toMatch(/<f(?:\s|>)/);
    for (const value of values) expect(worksheet).toContain(value);
  });

  it("accepts finite numeric boundaries and normalizes negative zero", () => {
    const workbook = writeXlsxWorkbook([
      {
        name: "Numbers",
        headers: ["max", "min", "negative zero"],
        rows: [[Number.MAX_VALUE, Number.MIN_VALUE, -0]],
      },
    ]);
    const worksheet =
      parseZip(workbook)
        .get("xl/worksheets/sheet1.xml")
        ?.data.toString("utf8") ?? "";
    expect(worksheet).toContain(String(Number.MAX_VALUE));
    expect(worksheet).toContain(String(Number.MIN_VALUE));
    expect(worksheet).toContain('<c r="C2" t="n"><v>0</v></c>');
  });

  it("rejects invalid numbers and bounded workbook resources", () => {
    const sheet = { name: "Sheet", headers: ["value"], rows: [["x"]] };
    expect(() => writeXlsxWorkbook([])).toThrow(/at least one sheet/);
    expect(() =>
      writeXlsxWorkbook([{ ...sheet, rows: [[Number.NaN]] }]),
    ).toThrow(/finite numbers/);
    expect(() =>
      writeXlsxWorkbook([{ ...sheet, rows: [[Number.POSITIVE_INFINITY]] }]),
    ).toThrow(/finite numbers/);
    expect(() => writeXlsxWorkbook([sheet], { maxTextBytes: 5 })).toThrow(
      /text exceeds/,
    );
    expect(() => writeXlsxWorkbook([sheet], { maxOutputBytes: 256 })).toThrow(
      /output exceeds/,
    );
    expect(() => writeXlsxWorkbook([sheet], { maxNonNullCells: 1 })).toThrow(
      /cell limit/,
    );
    expect(() => writeXlsxWorkbook([sheet], { maxRowsPerSheet: 1 })).toThrow(
      /row server limit/,
    );
    expect(() =>
      writeXlsxWorkbook([sheet], { maxColumnsPerSheet: 1 }),
    ).not.toThrow();
    expect(() =>
      writeXlsxWorkbook([{ ...sheet, headers: ["a", "b"] }], {
        maxColumnsPerSheet: 1,
      }),
    ).toThrow(/column server limit/);
    expect(() => writeXlsxWorkbook([sheet], { maxCellCharacters: 1 })).toThrow(
      /cell text exceeds/,
    );
  });

  it("rejects configurations that would require ZIP64", () => {
    const sheet = { name: "Sheet", headers: [], rows: [] };
    expect(() => writeXlsxWorkbook([sheet], { maxSheets: 65_532 })).toThrow(
      /ZIP32 entry limit/,
    );
    expect(() =>
      writeXlsxWorkbook([sheet], { maxOutputBytes: 0x1_0000_0000 }),
    ).toThrow(/ZIP32 size limit/);
  });
});
