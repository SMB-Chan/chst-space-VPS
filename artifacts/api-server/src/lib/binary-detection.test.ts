import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  classifyZipByEntryNames,
  detectBinaryFamily,
  isLegacyOleFile,
  readZipCentralDirectory,
  ZipFormatError,
} from "./binary-detection";

function zipBuffer(entries: Record<string, string>): Buffer {
  const data: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) {
    data[name] = strToU8(content);
  }
  return Buffer.from(zipSync(data));
}

describe("detectBinaryFamily", () => {
  it("detects PDF by signature", () => {
    const buffer = Buffer.from("%PDF-1.7\n%fake body");
    expect(detectBinaryFamily(buffer)).toBe("pdf");
  });

  it("classifies plain zips", () => {
    expect(detectBinaryFamily(zipBuffer({ "readme.txt": "hello" }))).toBe(
      "zip",
    );
  });

  it("classifies office formats by internal entry names", () => {
    expect(
      detectBinaryFamily(zipBuffer({ "word/document.xml": "<w:document/>" })),
    ).toBe("docx");
    expect(
      detectBinaryFamily(zipBuffer({ "xl/workbook.xml": "<workbook/>" })),
    ).toBe("xlsx");
    expect(
      detectBinaryFamily(
        zipBuffer({ "ppt/presentation.xml": "<p:presentation/>" }),
      ),
    ).toBe("pptx");
  });

  it("ignores client-claimed names: a renamed docx is still a docx", () => {
    const buffer = zipBuffer({
      "word/document.xml": "<w:document/>",
      "notes.txt": "hi",
    });
    expect(detectBinaryFamily(buffer)).toBe("docx");
  });

  it("detects common audio containers", () => {
    expect(
      detectBinaryFamily(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(16)])),
    ).toBe("audio");
    expect(detectBinaryFamily(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(
      "audio",
    ); // mp3 frame sync
    const wav = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WAVE"),
    ]);
    expect(detectBinaryFamily(wav)).toBe("audio");
    expect(detectBinaryFamily(Buffer.from("OggSxxxx"))).toBe("audio");
    expect(detectBinaryFamily(Buffer.from("fLaCxxxx"))).toBe("audio");
    const m4a = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from("ftypM4A "),
      Buffer.alloc(8),
    ]);
    expect(detectBinaryFamily(m4a)).toBe("audio");
    expect(
      detectBinaryFamily(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00])),
    ).toBe("audio"); // webm
  });

  it("returns null for unknown or corrupted payloads", () => {
    expect(detectBinaryFamily(Buffer.from("just some text"))).toBeNull();
    // Zip signature with garbage central directory.
    expect(
      detectBinaryFamily(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])),
    ).toBeNull();
  });
});

describe("isLegacyOleFile", () => {
  it("flags OLE2 containers", () => {
    const buffer = Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00,
    ]);
    expect(isLegacyOleFile(buffer)).toBe(true);
    expect(isLegacyOleFile(Buffer.from("%PDF-1.7"))).toBe(false);
  });
});

describe("readZipCentralDirectory", () => {
  it("lists entry names and uncompressed sizes", () => {
    const buffer = zipBuffer({ "a.txt": "hello", "dir/b.md": "world!" });
    const directory = readZipCentralDirectory(buffer);
    expect(directory.entries.map((entry) => entry.name).sort()).toEqual([
      "a.txt",
      "dir/b.md",
    ]);
    expect(directory.totalUncompressedBytes).toBe(
      "hello".length + "world!".length,
    );
  });

  it("rejects data without a central directory", () => {
    expect(() => readZipCentralDirectory(Buffer.alloc(64))).toThrow(
      ZipFormatError,
    );
  });
});

describe("classifyZipByEntryNames", () => {
  it("falls back to plain zip", () => {
    expect(classifyZipByEntryNames(["a.txt"])).toBe("zip");
    expect(classifyZipByEntryNames([])).toBe("zip");
  });
});
