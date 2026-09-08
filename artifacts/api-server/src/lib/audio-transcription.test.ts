import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, mimoCreateMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  mimoCreateMock: vi.fn(),
}));

vi.mock("./ai-clients", () => ({
  openaiClient: { audio: { transcriptions: { create: createMock } } },
  dashscopeClient: null,
  xiaomiClient: { chat: { completions: { create: mimoCreateMock } } },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  safeFailureFields: vi.fn(() => ({})),
}));

import {
  TranscriptionError,
  transcribeAudio,
  transcribeAudioWithModel,
} from "./audio-transcription";

const audioArgs = () => ({
  buffer: Buffer.from("ID3fakeaudio"),
  filename: "memo.mp3",
  mime: "audio/mpeg",
});

/** MiMo answers ASR through chat completions, not a transcriptions endpoint. */
function mimoTranscript(text: string) {
  return { choices: [{ message: { content: text } }] };
}

describe("transcribeAudio", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    createMock.mockReset();
    mimoCreateMock.mockReset();
  });

  it("does not send audio to any frozen provider", async () => {
    vi.stubEnv("DISABLE_OPENAI_MODELS", "true");
    vi.stubEnv("DISABLE_DASHSCOPE_MODELS", "true");
    vi.stubEnv("DISABLE_XIAOMI_MODELS", "true");
    await expect(transcribeAudio(audioArgs())).rejects.toThrow(
      TranscriptionError,
    );
    expect(createMock).not.toHaveBeenCalled();
    expect(mimoCreateMock).not.toHaveBeenCalled();
  });

  it("returns transcript text from the OpenAI-compatible endpoint", async () => {
    createMock.mockResolvedValueOnce({ text: "hello from audio" });
    const text = await transcribeAudio(audioArgs());
    expect(text).toBe("hello from audio");
    const body = createMock.mock.calls[0][0] as { model: string };
    expect(body.model).toBe("gpt-4o-mini-transcribe");
    expect(mimoCreateMock).not.toHaveBeenCalled();
  });

  it("falls back to whisper-1 when the preferred model is unavailable", async () => {
    const unavailable = Object.assign(new Error("The model does not exist"), {
      status: 404,
    });
    createMock.mockRejectedValueOnce(unavailable);
    createMock.mockResolvedValueOnce("second model ok");
    const text = await transcribeAudio(audioArgs());
    expect(text).toBe("second model ok");
    expect(createMock).toHaveBeenCalledTimes(2);
    const secondBody = createMock.mock.calls[1][0] as { model: string };
    expect(secondBody.model).toBe("whisper-1");
  });

  it("raises a user-facing error when every provider fails", async () => {
    const outage = Object.assign(new Error("quota exceeded"), { status: 429 });
    createMock.mockRejectedValue(outage);
    mimoCreateMock.mockRejectedValue(new Error("upstream unreachable"));
    await expect(transcribeAudio(audioArgs())).rejects.toThrow(
      TranscriptionError,
    );
    // A non-model error must not cascade across sibling models.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to MiMo ASR when OpenAI and Alibaba are frozen", async () => {
    vi.stubEnv("DISABLE_OPENAI_MODELS", "true");
    vi.stubEnv("DISABLE_DASHSCOPE_MODELS", "true");
    mimoCreateMock.mockResolvedValueOnce(mimoTranscript("こんにちは"));

    const text = await transcribeAudio(audioArgs());

    expect(text).toBe("こんにちは");
    expect(createMock).not.toHaveBeenCalled();
    const body = mimoCreateMock.mock.calls[0][0] as {
      model: string;
      messages: {
        content: {
          type: string;
          input_audio: { data: string; format: string };
        }[];
      }[];
    };
    expect(body.model).toBe("mimo-v2.5-asr");
    const part = body.messages[0].content[0];
    expect(part.type).toBe("input_audio");
    // The gateway only accepts wav and mp3, so the container must be declared.
    expect(part.input_audio.format).toBe("mp3");
    expect(part.input_audio.data).toBe(audioArgs().buffer.toString("base64"));
  });
});

describe("transcribeAudioWithModel", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    createMock.mockReset();
    mimoCreateMock.mockReset();
  });

  it("sends an explicitly chosen MiMo model straight to that transport", async () => {
    vi.stubEnv("DISABLE_OPENAI_MODELS", "true");
    mimoCreateMock.mockResolvedValueOnce(mimoTranscript("direct"));

    const text = await transcribeAudioWithModel(audioArgs(), "mimo-v2.5-asr");

    expect(text).toBe("direct");
    expect(createMock).not.toHaveBeenCalled();
    expect(mimoCreateMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a frozen provider even when its model is named", async () => {
    vi.stubEnv("DISABLE_XIAOMI_MODELS", "true");

    await expect(
      transcribeAudioWithModel(audioArgs(), "mimo-v2.5-asr"),
    ).rejects.toThrow(TranscriptionError);
    expect(mimoCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a model that implements no speech-to-text capability", async () => {
    await expect(
      transcribeAudioWithModel(audioArgs(), "mimo-v2.5-tts"),
    ).rejects.toThrow(TranscriptionError);
    expect(mimoCreateMock).not.toHaveBeenCalled();
  });

  it("falls back to the provider chain when no model is named", async () => {
    createMock.mockResolvedValueOnce({ text: "chained" });

    const text = await transcribeAudioWithModel(audioArgs());

    expect(text).toBe("chained");
    expect(mimoCreateMock).not.toHaveBeenCalled();
  });
});
