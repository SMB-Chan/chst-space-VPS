import { describe, expect, it } from "vitest";
import type { WebSocket } from "undici";
import { AlibabaTtsError, synthesizeAlibabaSpeech } from "./alibaba-tts";

class FakeSocket extends EventTarget {
  binaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState = 1;
  url = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference";
  sent: Record<string, unknown>[] = [];

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== "string") return;
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    const header = message.header as Record<string, unknown>;
    const taskId = String(header.task_id ?? "");
    if (header.action === "run-task") {
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              header: { event: "task-started", task_id: taskId },
              payload: {},
            }),
          }),
        ),
      );
    } else if (header.action === "continue-task") {
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: new Uint8Array([0x49, 0x44, 0x33]).buffer,
          }),
        ),
      );
    } else if (header.action === "finish-task") {
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              header: {
                event: "task-finished",
                task_id: taskId,
                attributes: { request_uuid: "req-tts-1" },
              },
              payload: { usage: { characters: 5 } },
            }),
          }),
        ),
      );
    }
  }

  close(): void {
    this.readyState = 3;
  }
}

const env = {
  ALIBABA_SPECIALIST_API_KEY: "test-credential",
} as NodeJS.ProcessEnv;

describe("synthesizeAlibabaSpeech", () => {
  it("runs the Qwen Audio TTS task and returns bounded MP3 bytes", async () => {
    const socket = new FakeSocket();
    const factory = () => {
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket as unknown as WebSocket;
    };
    const result = await synthesizeAlibabaSpeech(
      {
        text: "hello",
        voice: "longanlingxin",
        instruction: "Speak calmly.",
        languageHint: "en",
      },
      env,
      factory,
    );

    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.buffer.equals(Buffer.from([0x49, 0x44, 0x33]))).toBe(true);
    expect(result.requestId).toBe("req-tts-1");
    expect(
      socket.sent.map(
        (item) => (item.header as Record<string, unknown>).action,
      ),
    ).toEqual(["run-task", "continue-task", "finish-task"]);
    expect(socket.sent[0]).toMatchObject({
      payload: {
        task_group: "audio",
        task: "tts",
        function: "SpeechSynthesizer",
        model: "qwen-audio-3.0-tts-plus",
        parameters: {
          voice: "longanlingxin",
          format: "mp3",
          sample_rate: 22050,
          enable_ssml: false,
          enable_aigc_tag: true,
          language_hints: ["en"],
          instruction: "Speak calmly.",
        },
      },
    });
  });

  it("rejects overlong text before opening a socket", async () => {
    let opened = false;
    await expect(
      synthesizeAlibabaSpeech({ text: "x".repeat(10_001) }, env, () => {
        opened = true;
        return new FakeSocket() as unknown as WebSocket;
      }),
    ).rejects.toBeInstanceOf(AlibabaTtsError);
    expect(opened).toBe(false);
  });

  it("rejects Token Plan credentials for custom backend synthesis", async () => {
    await expect(
      synthesizeAlibabaSpeech(
        { text: "hello" },
        {
          DASHSCOPE_API_KEY: ["sk", "sp", "test"].join("-"),
        } as NodeJS.ProcessEnv,
        () => new FakeSocket() as unknown as WebSocket,
      ),
    ).rejects.toThrow(/Regular Model Studio specialist credentials/);
  });
});
