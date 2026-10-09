import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  detectProjectImageFormat,
  processProjectImage,
  storedImageFilename,
  toVisionDataUrl,
  PROJECT_IMAGE_VISION_MAX_SIDE,
} from "./project-images";
import { TINY_HEIC_BASE64 } from "./project-images.fixtures";

async function jpegWithGps(width = 40, height = 30): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#3366cc" },
  })
    .jpeg()
    .withExif({
      IFD0: { Make: "Apple", Model: "iPhone" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 39/1 29/1" },
    })
    .toBuffer();
}

describe("detectProjectImageFormat", () => {
  it("recognises the supported containers", async () => {
    const solid = sharp({
      create: { width: 8, height: 8, channels: 3, background: "#000" },
    });
    expect(detectProjectImageFormat(await solid.clone().png().toBuffer())).toBe(
      "png",
    );
    expect(
      detectProjectImageFormat(await solid.clone().jpeg().toBuffer()),
    ).toBe("jpeg");
    expect(
      detectProjectImageFormat(await solid.clone().webp().toBuffer()),
    ).toBe("webp");
    expect(detectProjectImageFormat(await solid.clone().gif().toBuffer())).toBe(
      "gif",
    );
    expect(
      detectProjectImageFormat(Buffer.from(TINY_HEIC_BASE64, "base64")),
    ).toBe("heic");
  });

  it("does not treat text, PDFs or M4A audio as images", () => {
    expect(
      detectProjectImageFormat(Buffer.from("hello world, plain text")),
    ).toBe(null);
    expect(
      detectProjectImageFormat(Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj")),
    ).toBe(null);
    const m4a = Buffer.alloc(32);
    m4a.writeUInt32BE(32, 0);
    m4a.write("ftypM4A ", 4, "latin1");
    m4a.write("M4A mp42isom", 16, "latin1");
    expect(detectProjectImageFormat(m4a)).toBe(null);
  });
});

describe("processProjectImage", () => {
  it("strips EXIF (including GPS) and keeps dimensions", async () => {
    const input = await jpegWithGps();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await processProjectImage(input, "jpeg");
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.width).toBe(40);
    expect(out.height).toBe(30);
    const meta = await sharp(out.stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    const thumb = await sharp(out.thumbnail).metadata();
    expect(thumb.format).toBe("webp");
  });

  it("applies EXIF orientation before stripping it", async () => {
    const rotated = await sharp({
      create: { width: 60, height: 20, channels: 3, background: "#fff" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await processProjectImage(rotated, "jpeg");
    expect(out.width).toBe(20);
    expect(out.height).toBe(60);
  });

  it("converts PNG to WebP and caps the long side", async () => {
    const big = await sharp({
      create: { width: 5000, height: 100, channels: 4, background: "#0f08" },
    })
      .png()
      .toBuffer();
    const out = await processProjectImage(big, "png");
    expect(out.mimeType).toBe("image/webp");
    expect(out.width).toBe(4096);
  });

  it("converts iPhone HEIC to JPEG", async () => {
    const out = await processProjectImage(
      Buffer.from(TINY_HEIC_BASE64, "base64"),
      "heic",
    );
    expect(out.mimeType).toBe("image/jpeg");
    expect([out.width, out.height]).toEqual([64, 48]);
    expect((await sharp(out.stored).metadata()).format).toBe("jpeg");
  });

  it("rejects bytes that only look like an image", async () => {
    const fake = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(64, 1),
    ]);
    await expect(processProjectImage(fake, "png")).rejects.toThrow(
      /画像を読み込めませんでした/,
    );
  });
});

describe("helpers", () => {
  it("renames to the stored extension", () => {
    expect(storedImageFilename("IMG_0001.HEIC", "jpg")).toBe("IMG_0001.jpg");
    expect(storedImageFilename("スクショ.png", "webp")).toBe("スクショ.webp");
    expect(storedImageFilename("noext", "jpg")).toBe("noext.jpg");
  });

  it("downsizes vision copies to the long-side limit", async () => {
    const big = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: "#123" },
    })
      .jpeg()
      .toBuffer();
    const url = await toVisionDataUrl(big);
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
    const meta = await sharp(
      Buffer.from(url.slice("data:image/jpeg;base64,".length), "base64"),
    ).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(
      PROJECT_IMAGE_VISION_MAX_SIDE,
    );
  });
});
