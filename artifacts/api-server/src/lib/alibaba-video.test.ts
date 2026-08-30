import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlibabaVideoError,
  cancelAlibabaVideoTask,
  downloadAlibabaVideoResult,
  getAlibabaVideoTask,
  submitAlibabaVideoTask,
} from "./alibaba-video";

afterEach(() => {
  vi.unstubAllGlobals();
});

const specialistEnv = { ALIBABA_SPECIALIST_API_KEY: "test-credential" } as NodeJS.ProcessEnv;
const pendingResponse = {
  output: { task_id: "0385dc79-5ff8-4d82-bcb6-123456789abc", task_status: "PENDING" },
  request_id: "req-1",
};

describe("Alibaba HappyHorse video transport", () => {
  it("submits a safe low-cost T2V task through the asynchronous endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(pendingResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const task = await submitAlibabaVideoTask({ mode: "t2v", prompt: "A paper train at night" }, specialistEnv);

    expect(task).toMatchObject({ status: "PENDING", modelId: "happyhorse-1.1-t2v", requestId: "req-1" });
    const [endpoint, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(endpoint.toString()).toContain("dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-credential",
      "X-DashScope-Async": "enable",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "happyhorse-1.1-t2v",
      input: { prompt: "A paper train at night" },
      parameters: { resolution: "720P", ratio: "16:9", duration: 5, watermark: false },
    });
  });

  it("submits exactly one first frame for I2V without a ratio", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(pendingResponse)));
    vi.stubGlobal("fetch", fetchMock);

    await submitAlibabaVideoTask({
      mode: "i2v",
      prompt: "The cat starts running",
      referenceImages: ["data:image/png;base64,aGVsbG8="],
      resolution: "1080P",
      duration: 7,
    }, specialistEnv);

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({
      model: "happyhorse-1.1-i2v",
      input: {
        prompt: "The cat starts running",
        media: [{ type: "first_frame", url: "data:image/png;base64,aGVsbG8=" }],
      },
      parameters: { resolution: "1080P", duration: 7, watermark: false },
    });
  });

  it("preserves ordered reference images for R2V", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(pendingResponse)));
    vi.stubGlobal("fetch", fetchMock);

    await submitAlibabaVideoTask({
      mode: "r2v",
      prompt: "[Image 1] opens [Image 2]",
      referenceImages: ["https://assets.example.com/person.webp", "https://assets.example.com/fan.png"],
      ratio: "9:16",
      seed: 42,
    }, specialistEnv);

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.model).toBe("happyhorse-1.1-r2v");
    expect(body.input.media).toEqual([
      { type: "reference_image", url: "https://assets.example.com/person.webp" },
      { type: "reference_image", url: "https://assets.example.com/fan.png" },
    ]);
    expect(body.parameters).toMatchObject({ ratio: "9:16", seed: 42 });
  });

  it("rejects mode, model, media, duration, and URL mismatches before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitAlibabaVideoTask({ mode: "i2v", prompt: "move", referenceImages: [] }, specialistEnv))
      .rejects.toThrow(/exactly one/);
    await expect(submitAlibabaVideoTask({
      mode: "i2v",
      prompt: "move",
      referenceImages: ["https://assets.example.com/frame.png"],
      ratio: "16:9",
    }, specialistEnv)).rejects.toThrow(/does not accept a ratio/);
    await expect(submitAlibabaVideoTask({
      mode: "r2v",
      prompt: "move",
      referenceImages: ["http://assets.example.com/frame.png"],
    }, specialistEnv)).rejects.toThrow(/public HTTPS hostname/);
    await expect(submitAlibabaVideoTask({
      mode: "t2v",
      prompt: "move",
      modelId: "happyhorse-1.1-i2v",
    }, specialistEnv)).rejects.toThrow(/does not support/);
    await expect(submitAlibabaVideoTask({ mode: "t2v", prompt: "move", duration: 16 }, specialistEnv))
      .rejects.toThrow(/duration/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Token Plan credentials for specialist video calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitAlibabaVideoTask(
      { mode: "t2v", prompt: "move" },
      { DASHSCOPE_API_KEY: ["sk", "sp", "test"].join("-") } as NodeJS.ProcessEnv,
    )).rejects.toThrow(/Regular Model Studio specialist credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries and cancels only validated task IDs", async () => {
    const running = {
      output: { task_id: pendingResponse.output.task_id, task_status: "RUNNING" },
      request_id: "req-2",
    };
    const canceled = {
      output: { task_id: pendingResponse.output.task_id, task_status: "CANCELED" },
      request_id: "req-3",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(running)))
      .mockResolvedValueOnce(new Response(JSON.stringify(canceled)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAlibabaVideoTask("../secrets", {}, specialistEnv)).rejects.toThrow(/task ID/);
    expect((await getAlibabaVideoTask(pendingResponse.output.task_id, {}, specialistEnv)).status).toBe("RUNNING");
    expect((await cancelAlibabaVideoTask(pendingResponse.output.task_id, {}, specialistEnv)).status).toBe("CANCELED");
    expect((fetchMock.mock.calls[0][0] as URL).pathname.endsWith(`/tasks/${pendingResponse.output.task_id}`)).toBe(true);
    expect((fetchMock.mock.calls[1][0] as URL).pathname.endsWith(`/tasks/${pendingResponse.output.task_id}/cancel`)).toBe(true);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("POST");
  });

  it("downloads a trusted successful MP4 without following redirects", async () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from("payload")]);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(mp4, {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": String(mp4.length) },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const generated = await downloadAlibabaVideoResult({
      taskId: pendingResponse.output.task_id,
      status: "SUCCEEDED",
      requestId: "req-4",
      videoUrl: "https://dashscope-result.oss-cn-beijing.aliyuncs.com/result.mp4?Expires=1",
    }, "happyhorse-1.1-t2v");

    expect(generated.buffer.equals(mp4)).toBe(true);
    expect(generated).toMatchObject({ mimeType: "video/mp4", taskId: pendingResponse.output.task_id });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  it("rejects untrusted result URLs before downloading", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadAlibabaVideoResult({
      taskId: pendingResponse.output.task_id,
      status: "SUCCEEDED",
      videoUrl: "https://example.com/result.mp4",
    }, "happyhorse-1.1-t2v")).rejects.toThrow(AlibabaVideoError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});