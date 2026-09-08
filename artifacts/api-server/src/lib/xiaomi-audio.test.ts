import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, probeDurationMock, ffmpegAvailableMock, transcodeMock } =
  vi.hoisted(() => ({
    createMock: vi.fn(),
    probeDurationMock: vi.fn(),
    ffmpegAvailableMock: vi.fn(),
    transcodeMock: vi.fn(),
  }));

vi.mock("./ai-clients", () => ({
  xiaomiClient: { chat: { completions: { create: createMock } } },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./audio-format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audio-format")>();
  return {
    ...actual,
    probeAudioDurationSeconds: probeDurationMock,
    isFfmpegAvailable: ffmpegAvailableMock,
    transcodeToWav: transcodeMock,
  };
});

import {
  MIMO_DEFAULT_VOICE_DESIGN_INSTRUCTION,
  XiaomiAudioError,
  isXiaomiAudioConfigured,
  synthesizeXiaomiSpeech,
  transcribeXiaomiAudio,
} from "./xiaomi-audio";

function speechResponse(bytes: string) {
  return {
    choices: [
      { message: { audio: { data: Buffer.from(bytes).toString("base64") } } },
    ],
  };
}

function transcriptResponse(text: string) {
  return { choices: [{ message: { content: text } }] };
}

function lastRequestBody() {
  return createMock.mock.calls[createMock.mock.calls.length - 1][0] as Record<
    string,
    never
  > & {
    model: string;
    audio?: { format?: string; voice?: string };
    messages: { role: string; content: unknown }[];
  };
}

const mp3Bytes = Buffer.from("ID3fakeaudio");
const webmBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);

describe("isXiaomiAudioConfigured", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is true with a client and no freeze flag", () => {
    expect(isXiaomiAudioConfigured({})).toBe(true);
  });

  it("is false while the provider is frozen", () => {
    expect(isXiaomiAudioConfigured({ DISABLE_XIAOMI_MODELS: "true" })).toBe(
      false,
    );
  });
});

describe("synthesizeXiaomiSpeech", () => {
  beforeEach(() => {
    createMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends the spoken text as an assistant turn with an mp3 audio block", async () => {
    createMock.mockResolvedValueOnce(speechResponse("mp3bytes"));

    const speech = await synthesizeXiaomiSpeech({ text: "Hello there." });

    const body = lastRequestBody();
    expect(body.model).toBe("mimo-v2.5-tts");
    expect(body.messages).toEqual([
      { role: "assistant", content: "Hello there." },
    ]);
    expect(body.audio).toEqual({ format: "mp3", voice: "mimo_default" });
    expect(speech.buffer.toString()).toBe("mp3bytes");
    expect(speech.mimeType).toBe("audio/mpeg");
    expect(speech.filename).toMatch(/^xiaomi-mimo-v2\.5-tts-\d+\.mp3$/);
    expect(speech.provider).toBe("xiaomi");
    expect(speech.size).toBe(speech.buffer.length);
  });

  it("keeps a requested built-in voice", async () => {
    createMock.mockResolvedValueOnce(speechResponse("mp3bytes"));

    await synthesizeXiaomiSpeech({ text: "Hello.", voice: "Mia" });

    expect(lastRequestBody().audio).toEqual({ format: "mp3", voice: "Mia" });
  });

  it("puts the voice description in a user turn for the voicedesign model", async () => {
    createMock.mockResolvedValueOnce(speechResponse("wavbytes"));

    const speech = await synthesizeXiaomiSpeech({
      text: "本日のニュースです。",
      modelId: "mimo-v2.5-tts-voicedesign",
      instruction: "落ち着いた低音の男性の声",
      format: "wav",
    });

    const body = lastRequestBody();
    expect(body.model).toBe("mimo-v2.5-tts-voicedesign");
    expect(body.messages).toEqual([
      { role: "user", content: "落ち着いた低音の男性の声" },
      { role: "assistant", content: "本日のニュースです。" },
    ]);
    // voicedesign rejects a built-in voice, so none may be sent.
    expect(body.audio).toEqual({ format: "wav" });
    expect(speech.mimeType).toBe("audio/wav");
    expect(speech.filename).toMatch(/\.wav$/);
    expect(speech.voice).toBeUndefined();
  });

  it("supplies a default voice description when voicedesign gets none", async () => {
    createMock.mockResolvedValueOnce(speechResponse("mp3bytes"));

    await synthesizeXiaomiSpeech({
      text: "こんにちは。",
      modelId: "mimo-v2.5-tts-voicedesign",
    });

    expect(lastRequestBody().messages[0]).toEqual({
      role: "user",
      content: MIMO_DEFAULT_VOICE_DESIGN_INSTRUCTION,
    });
  });

  it("refuses a built-in voice on the voicedesign model", async () => {
    await expect(
      synthesizeXiaomiSpeech({
        text: "こんにちは。",
        modelId: "mimo-v2.5-tts-voicedesign",
        voice: "Mia",
      }),
    ).rejects.toMatchObject({
      name: "XiaomiAudioError",
      retryable: false,
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses a voice that is not in the MiMo catalog", async () => {
    await expect(
      synthesizeXiaomiSpeech({ text: "Hello.", voice: "longanlingxin" }),
    ).rejects.toThrow(XiaomiAudioError);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses a model that is not a MiMo TTS model", async () => {
    await expect(
      synthesizeXiaomiSpeech({
        text: "Hello.",
        modelId: "mimo-v2.5-asr" as never,
      }),
    ).rejects.toMatchObject({
      publicMessage: expect.stringContaining("対応していません"),
    });
  });

  it("refuses empty and over-long text without calling the API", async () => {
    await expect(synthesizeXiaomiSpeech({ text: "   " })).rejects.toThrow(
      XiaomiAudioError,
    );
    await expect(
      synthesizeXiaomiSpeech({ text: "x".repeat(10_001) }),
    ).rejects.toMatchObject({
      publicMessage: expect.stringContaining("1万文字"),
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("reports a missing audio payload as retryable", async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { audio: null } }],
    });

    await expect(
      synthesizeXiaomiSpeech({ text: "Hello." }),
    ).rejects.toMatchObject({ name: "XiaomiAudioError", retryable: true });
  });

  it("refuses to run while the provider is frozen", async () => {
    vi.stubEnv("DISABLE_XIAOMI_MODELS", "true");

    await expect(
      synthesizeXiaomiSpeech({ text: "Hello." }),
    ).rejects.toMatchObject({ retryable: false });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("transcribeXiaomiAudio", () => {
  beforeEach(() => {
    createMock.mockReset();
    probeDurationMock.mockReset().mockResolvedValue(undefined);
    ffmpegAvailableMock.mockReset().mockResolvedValue(false);
    transcodeMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends bare base64 plus the detected container", async () => {
    createMock.mockResolvedValueOnce(transcriptResponse("hello from audio"));

    const text = await transcribeXiaomiAudio({
      buffer: mp3Bytes,
      filename: "memo.mp3",
      mime: "audio/mpeg",
    });

    expect(text).toBe("hello from audio");
    const body = lastRequestBody();
    expect(body.model).toBe("mimo-v2.5-asr");
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: mp3Bytes.toString("base64"),
              format: "mp3",
            },
          },
        ],
      },
    ]);
  });

  it("transcodes a container the gateway rejects when ffmpeg is present", async () => {
    ffmpegAvailableMock.mockResolvedValue(true);
    transcodeMock.mockResolvedValue(Buffer.from("RIFFconvertedWAVE"));
    createMock.mockResolvedValueOnce(transcriptResponse("converted"));

    const text = await transcribeXiaomiAudio({
      buffer: webmBytes,
      filename: "clip.webm",
      mime: "audio/webm",
    });

    expect(text).toBe("converted");
    expect(transcodeMock).toHaveBeenCalledTimes(1);
    const body = lastRequestBody();
    expect(
      (body.messages[0].content as { input_audio: { format: string } }[])[0]
        .input_audio.format,
    ).toBe("wav");
  });

  it("refuses an unsupported container when ffmpeg is missing", async () => {
    await expect(
      transcribeXiaomiAudio({
        buffer: webmBytes,
        filename: "clip.webm",
        mime: "audio/webm",
      }),
    ).rejects.toMatchObject({
      name: "XiaomiAudioError",
      retryable: false,
      publicMessage: expect.stringContaining("MP3とWAV"),
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses audio longer than five minutes", async () => {
    probeDurationMock.mockResolvedValue(301);

    await expect(
      transcribeXiaomiAudio({
        buffer: mp3Bytes,
        filename: "long.mp3",
        mime: "audio/mpeg",
      }),
    ).rejects.toMatchObject({
      retryable: false,
      publicMessage: expect.stringContaining("5分以内"),
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("treats an empty transcript as a retryable failure", async () => {
    createMock.mockResolvedValueOnce(transcriptResponse("   "));

    await expect(
      transcribeXiaomiAudio({
        buffer: mp3Bytes,
        filename: "memo.mp3",
        mime: "audio/mpeg",
      }),
    ).rejects.toMatchObject({ name: "XiaomiAudioError", retryable: true });
  });

  it("refuses bytes that are not recognisable audio", async () => {
    await expect(
      transcribeXiaomiAudio({
        buffer: Buffer.from("plain text"),
        filename: "memo.txt",
        mime: "text/plain",
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(createMock).not.toHaveBeenCalled();
  });
});
