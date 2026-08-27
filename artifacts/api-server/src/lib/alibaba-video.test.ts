import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlibabaVideoError,
  AlibabaVideoHttpTransport,
  HAPPYHORSE_VIDEO_POLL_INTERVAL_MS,
  buildHappyHorseSubmitPayload,
  downloadHappyHorseVideoResult,
  normalizeHappyHorseVideoRequest,
  pollHappyHorseVideoTask,
  runHappyHorseVideoJob,
  type HappyHorseVideoTask,
} from "./alibaba-video";

afterEach(() => {
  vi.restoreAllMocks();
});

const specialistEnv = {
  ALIBABA_SPECIALIST_API_KEY: "regular-model-studio-credential",
} as NodeJS.ProcessEnv;

const png = `data:image/png;base64,${Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64")}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("normalizeHappyHorseVideoRequest", () => {
  it("uses the cost-conscious 720P and 5 second defaults for T2V", () => {
    const request = normalizeHappyHorseVideoRequest({
      mode: "t2v",
      prompt: "a quiet train station at dusk",
    });
    expect(request).toMatchObject({
      modelId: "happyhorse-1.1-t2v",
      resolution: "720P",
      durationSeconds: 5,
      aspectRatio: "16:9",
      watermark: false,
      images: [],
    });
  });

  it("requires exactly one first image for I2V and preserves 1-9 R2V order", () => {
    const missingI2vImage = () => normalizeHappyHorseVideoRequest({
      mode: "i2v",
      prompt: "animate this",
    });
    expect(missingI2vImage).toThrow(/exactly one image/);
    expect(() => normalizeHappyHorseVideoRequest({
      mode: "i2v",
      prompt: "animate this",
      images: [png, png],
    })).toThrow(/exactly one image/);

    const refs = [png, "https://input.oss-cn-shenzhen.aliyuncs.com/second.png", png];
    const request = normalizeHappyHorseVideoRequest({
      mode: "r2v",
      prompt: "connect these shots",
      images: refs,
    });
    expect(request.images).toEqual(refs);
    expect(request.modelId).toBe("happyhorse-1.1-r2v");
  });

  it("rejects attachments for T2V and unsafe settings or input images", () => {
    expect(() => normalizeHappyHorseVideoRequest({
      mode: "t2v",
      prompt: "make a video",
      images: [png],
    })).toThrow(/does not accept/);
    expect(() => normalizeHappyHorseVideoRequest({
      mode: "r2v",
      prompt: "make a video",
      images: [],
    })).toThrow(/1-9/);
    expect(() => normalizeHappyHorseVideoRequest({
      mode: "r2v",
      prompt: "make a video",
      images: Array.from({ length: 10 }, () => png),
    })).toThrow(/1-9/);
    expect(() => normalizeHappyHorseVideoRequest({
      mode: "t2v",
      prompt: "make a video",
      durationSeconds: 16,
    })).toThrow(/3〜15/);
    expect(() => normalizeHappyHorseVideoRequest({
      mode: "t2v",
      prompt: "make a video",
      resolution: "4K" as never,
    })).toThrow(/720P/);
    expect(() => normalizeHappyHorseVideoRequest({
      mode: "t2v",
      prompt: "make a video",
      aspectRatio: "4:3" as never,
    })).toThrow(/縦横比/);
    expect(() => normalizeHappyHorseVideoRequest({
      mode: "t2v",
      prompt: "make a video",
      seed: 2_147_483_648,
    })).toThrow(/seed/);
    expect(() => normalizeHappyHorseVideoRequest({
      mode: "i2v",
      prompt: "animate this",
      images: ["data:image/png;base64,aGVsbG8="],
    })).toThrow(/magic bytes/);
    expect(() => normalizeHappyHorseVideoRequest({
      mode: "i2v",
      prompt: "animate this",
      images: ["https://example.com/input.png"],
    })).toThrow(/許可/);
  });

  it("builds mode-specific payloads without reordering reference images", () => {
    const payload = buildHappyHorseSubmitPayload({
      mode: "r2v",
      prompt: "make a flowing sequence",
      images: [png, png],
      resolution: "1080P",
      durationSeconds: 12,
      aspectRatio: "9:16",
      watermark: true,
      seed: 42,
    });
    expect(payload).toEqual({
      model: "happyhorse-1.1-r2v",
      input: { prompt: "make a flowing sequence", reference_images: [png, png] },
      parameters: {
        resolution: "1080P",
        duration: 12,
        aspect_ratio: "9:16",
        watermark: true,
        seed: 42,
      },
    });
  });
});

describe("AlibabaVideoHttpTransport", () => {
  it("submits once to the regular specialist endpoint with async transport headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      output: { task_id: "task-t2v-1" },
    }));
    const transport = new AlibabaVideoHttpTransport(specialistEnv, fetchMock);
    const result = await transport.submit({
      mode: "t2v",
      prompt: "a paper boat",
    });
    expect(result).toEqual({ taskId: "task-t2v-1", modelId: "happyhorse-1.1-t2v" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain(
      "dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer regular-model-studio-credential",
    );
    expect((init.headers as Record<string, string>)["X-DashScope-Async"]).toBe("enable");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "happyhorse-1.1-t2v",
      input: { prompt: "a paper boat" },
      parameters: { resolution: "720P", duration: 5 },
    });
  });

  it("polls and cancels using the remote task ID", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ output: { task_status: "RUNNING" } }))
      .mockResolvedValueOnce(jsonResponse({ output: { task_status: "CANCELED" } }));
    const transport = new AlibabaVideoHttpTransport(specialistEnv, fetchMock);
    expect(await transport.status("task-1")).toMatchObject({
      taskId: "task-1",
      status: "RUNNING",
    });
    expect(await transport.cancel("task-1")).toMatchObject({
      taskId: "task-1",
      status: "CANCELED",
    });
    expect((fetchMock.mock.calls[0][0] as URL).pathname).toContain("/tasks/task-1");
    expect((fetchMock.mock.calls[1][0] as URL).pathname).toContain("/tasks/task-1/cancel");
  });

  it("rejects Token Plan credentials before any HTTP request", async () => {
    const fetchMock = vi.fn();
    const transport = new AlibabaVideoHttpTransport({
      DASHSCOPE_API_KEY: "sk-sp-token-plan",
    } as NodeJS.ProcessEnv, fetchMock);
    await expect(transport.submit({ mode: "t2v", prompt: "blocked" }))
      .rejects.toThrow(/Regular Model Studio specialist credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HappyHorse task polling and result retrieval", () => {
  it("uses one submit and waits between non-terminal states", async () => {
    const statusResults: HappyHorseVideoTask[] = [
      { taskId: "task-1", status: "PENDING" },
      { taskId: "task-1", status: "RUNNING" },
      { taskId: "task-1", status: "SUCCEEDED", resultUrl: "https://result.oss-cn-shenzhen.aliyuncs.com/a.mp4" },
    ];
    const transport = {
      submit: vi.fn().mockResolvedValue({ taskId: "task-1", modelId: "happyhorse-1.1-t2v" }),
      status: vi.fn().mockImplementation(async () => statusResults.shift()),
      cancel: vi.fn(),
    };
    const task = await pollHappyHorseVideoTask(transport, "task-1", { pollIntervalMs: 0 });
    expect(task.status).toBe("SUCCEEDED");
    expect(transport.status).toHaveBeenCalledTimes(3);
    expect(transport.submit).not.toHaveBeenCalled();
    expect(HAPPYHORSE_VIDEO_POLL_INTERVAL_MS).toBe(15_000);
  });

  it("downloads a successful MP4 and never submits more than once", async () => {
    const video = Buffer.from("mock-mp4");
    const transport = {
      submit: vi.fn().mockResolvedValue({ taskId: "task-r2v-1", modelId: "happyhorse-1.1-r2v" }),
      status: vi.fn().mockResolvedValue({
        taskId: "task-r2v-1",
        status: "SUCCEEDED",
        resultUrl: "https://result.oss-cn-shenzhen.aliyuncs.com/video.mp4?expires=24h",
      }),
      cancel: vi.fn(),
    };
    const result = await runHappyHorseVideoJob(
      transport,
      { mode: "r2v", prompt: "animate references", images: [png] },
      {
        pollIntervalMs: 0,
        fetchImpl: vi.fn().mockResolvedValue(new Response(video, {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": String(video.length) },
        })),
      },
    );
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.status).toHaveBeenCalledTimes(1);
    expect(result.asset).toMatchObject({
      filename: "happyhorse-r2v-task-r2v-1.mp4",
      mimeType: "video/mp4",
      size: video.length,
    });
    expect(result.asset.buffer.equals(video)).toBe(true);
  });

  it.each(["FAILED", "CANCELED", "UNKNOWN"] as const)("does not download a %s task", async (status) => {
    const transport = {
      submit: vi.fn().mockResolvedValue({ taskId: "task-terminal", modelId: "happyhorse-1.1-t2v" }),
      status: vi.fn().mockResolvedValue({ taskId: "task-terminal", status }),
      cancel: vi.fn(),
    };
    await expect(runHappyHorseVideoJob(transport, { mode: "t2v", prompt: "terminal" }, {
      pollIntervalMs: 0,
      fetchImpl: vi.fn(),
    })).rejects.toThrow();
  });

  it("rejects untrusted, non-MP4, and oversized result responses", async () => {
    const neverFetch = vi.fn();
    await expect(downloadHappyHorseVideoResult("https://example.com/video.mp4", undefined, neverFetch))
      .rejects.toMatchObject({ publicMessage: "生成動画の取得先が許可されていません。" });
    expect(neverFetch).not.toHaveBeenCalled();
    await expect(downloadHappyHorseVideoResult(
      "https://result.oss-cn-shenzhen.aliyuncs.com/video.mp4",
      undefined,
      vi.fn().mockResolvedValue(new Response("not-video", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })),
    )).rejects.toThrow(/MP4/);
    await expect(downloadHappyHorseVideoResult(
      "https://result.oss-cn-shenzhen.aliyuncs.com/video.mp4",
      undefined,
      vi.fn().mockResolvedValue(new Response(null, {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": "67108865",
        },
      })),
    )).rejects.toMatchObject({ publicMessage: "生成動画が大きすぎます。" });
  });
});