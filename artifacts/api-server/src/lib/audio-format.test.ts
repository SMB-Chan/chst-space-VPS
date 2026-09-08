import { describe, expect, it } from "vitest";
import {
  CONTAINER_MIME,
  containerFromFilename,
  containerFromMime,
  detectAudioContainer,
  wavSampleRate,
} from "./audio-format";

function wavBuffer(sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  return header;
}

describe("audio container detection", () => {
  it("recognises containers from magic bytes", () => {
    expect(
      detectAudioContainer(Buffer.from("ID3\u0003\u0000\u0000\u0000")),
    ).toBe("mp3");
    expect(detectAudioContainer(Buffer.from([0xff, 0xfb, 0x90, 0xc4]))).toBe(
      "mp3",
    );
    expect(detectAudioContainer(wavBuffer(16_000))).toBe("wav");
    expect(
      detectAudioContainer(Buffer.from("fLaC\u0000\u0000\u0000\u0000")),
    ).toBe("flac");
    expect(
      detectAudioContainer(Buffer.from("OggS\u0000\u0000\u0000\u0000")),
    ).toBe("ogg");
    expect(
      detectAudioContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00])),
    ).toBe("webm");
    expect(
      detectAudioContainer(Buffer.from("not audio at all")),
    ).toBeUndefined();
  });

  it("recognises an m4a from its ftyp box", () => {
    const buffer = Buffer.alloc(12);
    buffer.writeUInt32BE(8, 0);
    buffer.write("ftyp", 4, "ascii");
    expect(detectAudioContainer(buffer)).toBe("m4a");
  });

  it("maps MIME types and extensions onto containers", () => {
    expect(containerFromMime("audio/mpeg")).toBe("mp3");
    expect(containerFromMime("AUDIO/X-WAV; codecs=pcm")).toBe("wav");
    expect(containerFromMime("audio/ogg")).toBe("ogg");
    expect(containerFromMime("text/plain")).toBeUndefined();
    expect(containerFromFilename("memo.M4A")).toBe("m4a");
    expect(containerFromFilename("clip.opus")).toBe("ogg");
    expect(containerFromFilename("notes.pdf")).toBeUndefined();
  });

  it("gives every container a MIME type", () => {
    for (const [container, mime] of Object.entries(CONTAINER_MIME)) {
      expect(mime).toMatch(/^audio\//);
      expect(containerFromMime(mime)).toBe(container);
    }
  });
});

describe("wavSampleRate", () => {
  it("reads the sample rate out of the fmt chunk", () => {
    expect(wavSampleRate(wavBuffer(22_050))).toBe(22_050);
    expect(wavSampleRate(wavBuffer(16_000))).toBe(16_000);
  });

  it("ignores non-wav bytes and implausible rates", () => {
    expect(
      wavSampleRate(Buffer.from("ID3\u0003\u0000\u0000\u0000")),
    ).toBeUndefined();
    expect(wavSampleRate(wavBuffer(4))).toBeUndefined();
  });
});
