import { describe, expect, it } from "vitest";
import {
  compressedFileName,
  formatBytes,
  shouldCompressImage,
} from "./compress-image";

describe("shouldCompressImage", () => {
  it("skips small images, gifs, and svg", () => {
    expect(shouldCompressImage({ type: "image/jpeg", size: 100_000 })).toBe(
      false,
    );
    expect(shouldCompressImage({ type: "image/gif", size: 2_000_000 })).toBe(
      false,
    );
    expect(
      shouldCompressImage({ type: "image/svg+xml", size: 2_000_000 }),
    ).toBe(false);
    expect(shouldCompressImage({ type: "text/plain", size: 2_000_000 })).toBe(
      false,
    );
  });

  it("compresses large raster images", () => {
    expect(shouldCompressImage({ type: "image/png", size: 2_000_000 })).toBe(
      true,
    );
    expect(shouldCompressImage({ type: "image/jpeg", size: 900_000 })).toBe(
      true,
    );
  });
});

describe("compressedFileName", () => {
  it("replaces the extension with jpg", () => {
    expect(compressedFileName("photo.PNG")).toBe("photo.jpg");
    expect(compressedFileName("a.b.jpeg")).toBe("a.b.jpg");
  });
});

describe("formatBytes", () => {
  it("formats KB and MB", () => {
    expect(formatBytes(2048)).toBe("2KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5MB");
  });
});
