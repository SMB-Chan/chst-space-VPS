import { execFileSync } from "node:child_process";
import {
  constants,
  accessSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PPTX_WRITER_LIMITS,
  writePptxPresentation,
} from "./pptx-writer";

interface ZipEntry {
  name: string;
  content: Buffer;
  crc: number;
  localOffset: number;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocdOffset).toBeGreaterThan(0);
  const count = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  expect(buffer.readUInt16LE(eocdOffset + 8)).toBe(count);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const expectedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");

    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(buffer.readUInt32LE(localOffset + 14)).toBe(expectedCrc);
    expect(buffer.readUInt32LE(localOffset + 18)).toBe(compressedSize);
    expect(buffer.readUInt32LE(localOffset + 22)).toBe(expectedSize);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    expect(
      buffer
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .toString("utf8"),
    ).toBe(name);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = inflateRawSync(compressed);
    expect(content.length).toBe(expectedSize);
    expect(crc32(content)).toBe(expectedCrc);
    entries.push({ name, content, crc: expectedCrc, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  expect(offset).toBe(eocdOffset);
  return entries;
}

function findOfficeCommand(): string | null {
  const pathDirectories = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  for (const command of ["libreoffice", "soffice"]) {
    for (const directory of pathDirectories) {
      const candidate = join(directory, command);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

const officeCommand = findOfficeCommand();

describe("bounded write-only PPTX writer", () => {
  it("writes deterministic multi-slide OOXML with valid ZIP32 metadata and CRCs", () => {
    const slides = [
      { title: "概要", bullets: ["日本語", "=SUM(A1)", "A&B <C>"] },
      { title: "結論", bullets: ["安全な出力専用writer"] },
    ];
    const first = writePptxPresentation(slides, "Chat Space");
    const second = writePptxPresentation(slides, "Chat Space");
    expect(first.equals(second)).toBe(true);
    expect(first.readUInt32LE(0)).toBe(0x04034b50);

    const entries = readZipEntries(first);
    expect(entries).toHaveLength(15);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(
      entries.length,
    );
    expect(entries.map((entry) => entry.localOffset)).toEqual(
      [...entries.map((entry) => entry.localOffset)].sort((a, b) => a - b),
    );
    expect(entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "ppt/presentation.xml",
        "ppt/slideMasters/slideMaster1.xml",
        "ppt/slideLayouts/slideLayout1.xml",
        "ppt/theme/theme1.xml",
        "ppt/slides/slide1.xml",
        "ppt/slides/_rels/slide2.xml.rels",
      ]),
    );

    const presentation = entries
      .find((entry) => entry.name === "ppt/presentation.xml")!
      .content.toString("utf8");
    expect(presentation).toContain('<p:sldId id="256" r:id="rId2"/>');
    expect(presentation).toContain('<p:sldId id="257" r:id="rId3"/>');

    const slide = entries
      .find((entry) => entry.name === "ppt/slides/slide1.xml")!
      .content.toString("utf8");
    expect(slide).toContain("概要");
    expect(slide).toContain("日本語");
    expect(slide).toContain("=SUM(A1)");
    expect(slide).toContain("A&amp;B &lt;C&gt;");
  });

  it("escapes structural input and strips XML 1.0-invalid characters", () => {
    const output = writePptxPresentation([
      { title: '</a:t><script id="x">', bullets: ["safe\u0000\ufffe text"] },
    ]);
    const slide = readZipEntries(output)
      .find((entry) => entry.name === "ppt/slides/slide1.xml")!
      .content.toString("utf8");
    expect(slide).toContain("&lt;/a:t&gt;&lt;script id=&quot;x&quot;&gt;");
    expect(slide).not.toContain("<script");
    expect(slide).not.toContain("\u0000");
    expect(slide).not.toContain("\ufffe");
  });

  it("enforces slide, bullet, run, character, UTF-8, output, and ZIP32 limits", () => {
    expect(() => writePptxPresentation([])).toThrow(/at least one slide/);
    expect(() =>
      writePptxPresentation(
        [
          { title: "1", bullets: [] },
          { title: "2", bullets: [] },
        ],
        "x",
        { maxSlides: 1 },
      ),
    ).toThrow(/slide limit/);
    expect(() =>
      writePptxPresentation([{ title: "x", bullets: ["1", "2"] }], "x", {
        maxBulletsPerSlide: 1,
      }),
    ).toThrow(/bullet limit/);
    expect(() =>
      writePptxPresentation([{ title: "x", bullets: ["y"] }], "x", {
        maxTextRuns: 1,
      }),
    ).toThrow(/text-run limit/);
    expect(() =>
      writePptxPresentation([{ title: "abcd", bullets: [] }], "x", {
        maxTextCharacters: 3,
      }),
    ).toThrow(/character limit/);
    expect(() =>
      writePptxPresentation([{ title: "日", bullets: [] }], "x", {
        maxTextBytes: 3,
      }),
    ).toThrow(/byte limit/);
    expect(() =>
      writePptxPresentation([{ title: "x", bullets: [] }], "x", {
        maxOutputBytes: 100,
      }),
    ).toThrow(/output exceeds/);
    expect(() =>
      writePptxPresentation([{ title: "x", bullets: [] }], "x", {
        maxSlides: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(/ZIP32 entry limit/);
    expect(() =>
      writePptxPresentation([{ title: "x", bullets: [] }], "x", {
        maxTextBytes: 0,
      }),
    ).toThrow(/positive safe integer/);
    expect(DEFAULT_PPTX_WRITER_LIMITS.maxOutputBytes).toBe(16 * 1024 * 1024);
  });

  it.runIf(officeCommand !== null)(
    "opens in LibreOffice and converts to PDF",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "bounded-pptx-"));
      const profile = mkdtempSync(join(tmpdir(), "bounded-pptx-lo-"));
      const input = join(directory, "presentation.pptx");
      const outputDirectory = join(directory, "output");
      mkdirSync(outputDirectory);
      writeFileSync(
        input,
        writePptxPresentation(
          [
            { title: "日本語", bullets: ["開閉テスト", "literal =SUM(A1)"] },
            { title: "Second", bullets: ["Two slides"] },
          ],
          "互換性テスト",
        ),
      );
      try {
        execFileSync(
          officeCommand!,
          [
            `-env:UserInstallation=file://${profile}`,
            "--headless",
            "--convert-to",
            "pdf",
            "--outdir",
            outputDirectory,
            input,
          ],
          { stdio: "pipe", timeout: 30_000 },
        );
        const pdf = readFileSync(join(outputDirectory, "presentation.pdf"));
        expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
      } finally {
        rmSync(directory, { recursive: true, force: true });
        rmSync(profile, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
