import { describe, expect, it } from "vitest";
import { projectFileJsonLimitBytes } from "./json-limits";
import { decodeProjectText } from "./project-files-store";

describe("decodeProjectText", () => {
  it("decodes UTF-8 and strips a UTF-8 BOM", () => {
    expect(decodeProjectText(Buffer.from("こんにちは", "utf8"))).toBe(
      "こんにちは",
    );
    expect(
      decodeProjectText(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b")]),
      ),
    ).toBe("a,b");
  });

  it("falls back to Shift_JIS (CP932) for Japanese Excel CSVs", () => {
    const sjis = Buffer.from("96bc914f2c935f9094", "hex");
    expect(decodeProjectText(sjis)).toBe("名前,点数");
  });

  it("decodes UTF-16 LE/BE with a BOM", () => {
    const le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("表", "utf16le"),
    ]);
    expect(decodeProjectText(le)).toBe("表");
    const beBody = Buffer.from("表", "utf16le").swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
    expect(decodeProjectText(be)).toBe("表");
  });

  it("returns null for bytes that are neither UTF-8 nor Shift_JIS", () => {
    expect(decodeProjectText(Buffer.from([0x80, 0xa0, 0xfd]))).toBeNull();
  });
});

describe("projectFileJsonLimitBytes", () => {
  it("leaves room for base64 overhead", () => {
    const raw = 20 * 1024 * 1024;
    const base64Len = Math.ceil(raw / 3) * 4;
    expect(projectFileJsonLimitBytes(raw)).toBeGreaterThan(base64Len + 1024);
  });
});
