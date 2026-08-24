import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("./ai-clients", () => ({
  openaiClient: { audio: { transcriptions: { create: createMock } } },
  dashscopeClient: null,
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { TranscriptionError, transcribeAudio } from "./audio-transcription";

const audioArgs = () => ({
  buffer: Buffer.from("ID3fakeaudio"),
  filename: "memo.mp3",
  mime: "audio/mpeg",
});

describe("transcribeAudio", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("returns transcript text from the OpenAI-compatible endpoint", async () => {
    createMock.mockResolvedValueOnce({ text: "hello from audio" });
    const text = await transcribeAudio(audioArgs());
    expect(text).toBe("hello from audio");
    const body = createMock.mock.calls[0][0] as { model: string };
    expect(body.model).toBe("gpt-4o-mini-transcribe");
  });

  it("falls back to whisper-1 when the preferred model is unavailable", async () => {
    const unavailable = Object.assign(new Error("The model does not exist"), { status: 404 });
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
    await expect(transcribeAudio(audioArgs())).rejects.toThrow(TranscriptionError);
    // A non-model error must not cascade across sibling models.
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
