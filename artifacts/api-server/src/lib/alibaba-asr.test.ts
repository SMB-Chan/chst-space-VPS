import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeQwenAudio } from "./alibaba-asr";

const fetchMock = vi.fn();

function wavFixture(): Buffer {
  const buffer = Buffer.alloc(44 + 4);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(4, 40);
  return buffer;
}

const env = {
  ALIBABA_SPECIALIST_API_KEY: "regular-model-studio-key",
  ALIBABA_SPECIALIST_WORKSPACE_ID: "workspace-123",
};

describe("Qwen Audio ASR transport", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a Singapore workspace request with a WAV data URL and parses the documented response", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            output: { sentence: { text: "  recognized words  " } },
            text: "recognized words",
          },
          request_id: "request-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      transcribeQwenAudio(
        {
          buffer: wavFixture(),
          filename: "memo.wav",
          mime: "audio/wav",
          languageHints: ["en", "ja"],
          durationSeconds: 1,
        },
        env,
      ),
    ).resolves.toBe("recognized words");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect((init.headers as Record<string, string>)["X-DashScope-SSE"]).toBe(
      "disable",
    );
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("qwen-audio-3.0-asr-flash");
    expect(body.input.messages[0].content[0].input_audio.data).toMatch(
      /^data:audio\/wav;base64,/,
    );
    expect(body.parameters).toEqual({
      format: "wav",
      sample_rate: "16000",
      language_hints: ["en", "ja"],
    });
  });

  it("uses output.text when the nested sentence field is absent", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ output: { text: "fallback transcript" } }),
        { status: 200 },
      ),
    );
    await expect(
      transcribeQwenAudio(
        {
          buffer: Buffer.from("ID3not-real-but-format-is-mime"),
          filename: "memo.mp3",
          mime: "audio/mpeg",
          durationSeconds: 1,
        },
        env,
      ),
    ).resolves.toBe("fallback transcript");
  });

  it("rejects unrelated 0xE0-prefixed bytes before external fetch", async () => {
    await expect(
      transcribeQwenAudio(
        {
          buffer: Buffer.from([0xe0, 0xfb, 0x90, 0x00]),
          filename: "random.bin",
          mime: "application/octet-stream",
          durationSeconds: 1,
        },
        env,
      ),
    ).rejects.toMatchObject({
      publicMessage:
        "対応していない音声形式です。MP3、WAV、M4A、OGG、FLAC、WebMなどを使用してください。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a valid MP3 frame header with a non-reserved version and layer", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: { text: "mp3 transcript" } }), {
        status: 200,
      }),
    );
    await expect(
      transcribeQwenAudio(
        {
          buffer: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
          filename: "frame.bin",
          mime: "application/octet-stream",
          durationSeconds: 1,
        },
        env,
      ),
    ).resolves.toBe("mp3 transcript");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body.parameters.format).toBe("mp3");
  });

  it("continues treating an AAC ADTS frame as AAC", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: { text: "aac transcript" } }), {
        status: 200,
      }),
    );
    await expect(
      transcribeQwenAudio(
        {
          buffer: Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]),
          filename: "frame.bin",
          mime: "application/octet-stream",
          durationSeconds: 1,
        },
        env,
      ),
    ).resolves.toBe("aac transcript");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body.parameters.format).toBe("aac");
  });

  it("rejects clips over five minutes and more than four language hints before network access", async () => {
    await expect(
      transcribeQwenAudio(
        {
          buffer: wavFixture(),
          filename: "long.wav",
          mime: "audio/wav",
          durationSeconds: 301,
        },
        env,
      ),
    ).rejects.toMatchObject({ publicMessage: "音声は5分以内にしてください。" });
    await expect(
      transcribeQwenAudio(
        {
          buffer: wavFixture(),
          filename: "many.wav",
          mime: "audio/wav",
          languageHints: ["en", "ja", "zh", "ko", "fr"],
          durationSeconds: 1,
        },
        env,
      ),
    ).rejects.toMatchObject({
      publicMessage: "音声認識の言語ヒントは4件まで指定できます。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a detected format that conflicts with the declared MIME type", async () => {
    await expect(
      transcribeQwenAudio(
        {
          buffer: wavFixture(),
          filename: "memo.mp3",
          mime: "audio/mpeg",
          durationSeconds: 1,
        },
        env,
      ),
    ).rejects.toMatchObject({
      publicMessage: "音声ファイルの実形式とMIMEタイプが一致しません。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Base64 payloads over the provider's ten megabyte input limit", async () => {
    await expect(
      transcribeQwenAudio(
        {
          buffer: Buffer.alloc(8 * 1024 * 1024),
          filename: "large.mp3",
          mime: "audio/mpeg",
          durationSeconds: 1,
        },
        env,
      ),
    ).rejects.toMatchObject({
      publicMessage:
        "音声データが大きすぎます。Base64変換後10MB以内にしてください。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
