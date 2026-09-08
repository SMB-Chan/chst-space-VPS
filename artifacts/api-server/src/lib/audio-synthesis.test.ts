import { beforeEach, describe, expect, it, vi } from "vitest";

const { alibabaTtsMock, xiaomiTtsMock } = vi.hoisted(() => ({
  alibabaTtsMock: vi.fn(),
  xiaomiTtsMock: vi.fn(),
}));

vi.mock("./ai-clients", () => ({
  dashscopeClient: { models: { list: vi.fn() } },
  xiaomiClient: { chat: { completions: { create: vi.fn() } } },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./alibaba-tts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./alibaba-tts")>();
  return { ...actual, synthesizeAlibabaSpeech: alibabaTtsMock };
});
vi.mock("./xiaomi-audio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./xiaomi-audio")>();
  return { ...actual, synthesizeXiaomiSpeech: xiaomiTtsMock };
});

import { AlibabaTtsError } from "./alibaba-tts";
import { SpeechSynthesisError, synthesizeSpeech } from "./audio-synthesis";
import { XiaomiAudioError } from "./xiaomi-audio";

const ALIBABA_READY = { ALIBABA_SPECIALIST_API_KEY: "regular-key" };
const XIAOMI_ONLY = { DISABLE_DASHSCOPE_MODELS: "true" };
const NOTHING = {
  DISABLE_DASHSCOPE_MODELS: "true",
  DISABLE_XIAOMI_MODELS: "true",
};

function alibabaAsset() {
  return {
    buffer: Buffer.from("alibaba-mp3"),
    filename: "alibaba-qwen-audio-3.0-tts-plus-1.mp3",
    mimeType: "audio/mpeg",
    size: 11,
    modelId: "qwen-audio-3.0-tts-plus",
    voice: "longanlingxin",
    requestId: "req-1",
  };
}

function xiaomiAsset(modelId = "mimo-v2.5-tts") {
  return {
    buffer: Buffer.from("mimo-mp3"),
    filename: `xiaomi-${modelId}-1.mp3`,
    mimeType: "audio/mpeg",
    size: 8,
    provider: "xiaomi" as const,
    modelId,
    voice: "Mia",
  };
}

describe("synthesizeSpeech", () => {
  beforeEach(() => {
    alibabaTtsMock.mockReset();
    xiaomiTtsMock.mockReset();
  });

  it("sends an Alibaba model to the Alibaba transport with prosody", async () => {
    alibabaTtsMock.mockResolvedValueOnce(alibabaAsset());

    const speech = await synthesizeSpeech(
      {
        text: "Welcome to Chat Space.",
        modelId: "qwen-audio-3.0-tts-plus",
        voice: "longanlingxin",
        languageHint: "en",
        rate: 1.1,
        pitch: 0.95,
        volume: 60,
      },
      ALIBABA_READY,
    );

    expect(alibabaTtsMock).toHaveBeenCalledTimes(1);
    expect(alibabaTtsMock.mock.calls[0][0]).toMatchObject({
      modelId: "qwen-audio-3.0-tts-plus",
      voice: "longanlingxin",
      languageHint: "en",
      rate: 1.1,
      pitch: 0.95,
      volume: 60,
    });
    expect(xiaomiTtsMock).not.toHaveBeenCalled();
    expect(speech).toMatchObject({
      provider: "alibaba",
      modelId: "qwen-audio-3.0-tts-plus",
      voice: "longanlingxin",
      requestId: "req-1",
      mimeType: "audio/mpeg",
    });
  });

  it("sends a MiMo model to the MiMo transport without Alibaba-only knobs", async () => {
    xiaomiTtsMock.mockResolvedValueOnce(xiaomiAsset());

    const speech = await synthesizeSpeech(
      {
        text: "Hello there.",
        modelId: "mimo-v2.5-tts",
        voice: "Mia",
        rate: 1.5,
      },
      XIAOMI_ONLY,
    );

    expect(xiaomiTtsMock).toHaveBeenCalledTimes(1);
    // rate has no meaning on this transport and must not be forwarded.
    expect(xiaomiTtsMock.mock.calls[0][0]).toEqual({
      text: "Hello there.",
      modelId: "mimo-v2.5-tts",
      voice: "Mia",
    });
    expect(alibabaTtsMock).not.toHaveBeenCalled();
    expect(speech.provider).toBe("xiaomi");
  });

  it("routes Japanese to MiMo even when Alibaba is configured", async () => {
    xiaomiTtsMock.mockResolvedValueOnce(
      xiaomiAsset("mimo-v2.5-tts-voicedesign"),
    );

    const speech = await synthesizeSpeech(
      { text: "こんにちは。", languageHint: "ja" },
      ALIBABA_READY,
    );

    expect(xiaomiTtsMock).toHaveBeenCalledTimes(1);
    expect(xiaomiTtsMock.mock.calls[0][0]).toMatchObject({
      modelId: "mimo-v2.5-tts-voicedesign",
    });
    // The MiMo transport has no language parameter; the model choice carries it.
    expect(xiaomiTtsMock.mock.calls[0][0]).not.toHaveProperty("languageHint");
    expect(alibabaTtsMock).not.toHaveBeenCalled();
    expect(speech.modelId).toBe("mimo-v2.5-tts-voicedesign");
  });

  it("drops a voice instruction a model cannot act on", async () => {
    xiaomiTtsMock.mockResolvedValueOnce(xiaomiAsset());

    await synthesizeSpeech(
      {
        text: "Hello.",
        modelId: "mimo-v2.5-tts",
        instruction: "a bright voice",
      },
      XIAOMI_ONLY,
    );

    expect(xiaomiTtsMock.mock.calls[0][0]).not.toHaveProperty("instruction");
  });

  it("refuses a model that implements no text-to-speech", async () => {
    await expect(
      synthesizeSpeech({ text: "Hello.", modelId: "mimo-v2.5" }, XIAOMI_ONLY),
    ).rejects.toMatchObject({
      name: "SpeechSynthesisError",
      retryable: false,
      publicMessage: expect.stringContaining("対応していません"),
    });
    expect(xiaomiTtsMock).not.toHaveBeenCalled();
    expect(alibabaTtsMock).not.toHaveBeenCalled();
  });

  it("refuses Japanese on a model that only speaks Chinese and English", async () => {
    const error = await synthesizeSpeech(
      {
        text: "こんにちは。",
        modelId: "qwen-audio-3.0-tts-plus",
        languageHint: "ja",
      },
      ALIBABA_READY,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SpeechSynthesisError);
    expect((error as SpeechSynthesisError).publicMessage).toContain("zh・en");
    expect(alibabaTtsMock).not.toHaveBeenCalled();
  });

  it("refuses a voice that belongs to a different vendor", async () => {
    await expect(
      synthesizeSpeech(
        {
          text: "Hello.",
          modelId: "qwen-audio-3.0-tts-plus",
          voice: "Mia",
        },
        ALIBABA_READY,
      ),
    ).rejects.toMatchObject({
      retryable: false,
      publicMessage: expect.stringContaining("利用できません"),
    });
    expect(alibabaTtsMock).not.toHaveBeenCalled();
  });

  it("names the vendor when no speech provider is reachable", async () => {
    await expect(
      synthesizeSpeech({ text: "Hello." }, NOTHING),
    ).rejects.toMatchObject({
      retryable: false,
      publicMessage: expect.stringContaining("プロバイダが設定されていません"),
    });
  });

  it("names the vendor when the requested one is frozen", async () => {
    await expect(
      synthesizeSpeech(
        { text: "Hello.", modelId: "mimo-v2.5-tts" },
        { DISABLE_XIAOMI_MODELS: "true" },
      ),
    ).rejects.toMatchObject({
      retryable: false,
      publicMessage: expect.stringContaining("Xiaomi MiMo"),
    });
    expect(xiaomiTtsMock).not.toHaveBeenCalled();
  });

  it("carries the vendor's vetted public message through", async () => {
    xiaomiTtsMock.mockRejectedValueOnce(
      new XiaomiAudioError(
        "MiMo TTS transport failed: boom",
        "音声合成がタイムアウトしました。",
      ),
    );

    await expect(
      synthesizeSpeech({ text: "Hello.", modelId: "mimo-v2.5-tts" }, {}),
    ).rejects.toMatchObject({
      name: "SpeechSynthesisError",
      publicMessage: "音声合成がタイムアウトしました。",
    });
  });

  it("carries the Alibaba refusal message through", async () => {
    alibabaTtsMock.mockRejectedValueOnce(
      new AlibabaTtsError(
        "Alibaba TTS task failed",
        "音声合成に失敗しました。もう一度お試しください。",
      ),
    );

    await expect(
      synthesizeSpeech(
        { text: "Welcome.", modelId: "qwen-audio-3.0-tts-plus" },
        ALIBABA_READY,
      ),
    ).rejects.toMatchObject({
      name: "SpeechSynthesisError",
      publicMessage: "音声合成に失敗しました。もう一度お試しください。",
    });
  });
});
