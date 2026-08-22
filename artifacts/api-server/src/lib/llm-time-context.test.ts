import { describe, expect, it, vi } from "vitest";
import {
  buildLlmTimeContext,
  createLlmTimeContextFetch,
  formatJstDateTime,
  injectLlmTimeContextIntoBody,
  LLM_TIME_ZONE,
} from "./llm-time-context";

describe("LLM JST time context", () => {
  const fixedNow = new Date("2026-08-22T22:01:02Z");

  it("formats UTC instants in Asia/Tokyo with a fixed +09:00 offset", () => {
    expect(formatJstDateTime(fixedNow)).toBe(
      "2026-08-23T07:01:02+09:00",
    );
    expect(formatJstDateTime(new Date("2026-12-31T15:00:00Z"))).toBe(
      "2027-01-01T00:00:00+09:00",
    );
  });

  it("includes the IANA zone and relative-date instruction", () => {
    const prompt = buildLlmTimeContext(fixedNow);
    expect(prompt).toContain("2026-08-23T07:01:02+09:00");
    expect(prompt).toContain(LLM_TIME_ZONE);
    expect(prompt).toContain("JST");
    expect(prompt).toContain("今日");
  });

  it("prepends JST context and removes the legacy UTC-only date prefix", () => {
    const transformed = injectLlmTimeContextIntoBody(
      JSON.stringify({
        model: "test-model",
        messages: [
          {
            role: "system",
            content: "今日の日付: 2026-08-22。あなたは検索判定アシスタントです。",
          },
          { role: "user", content: "今日の出来事は？" },
        ],
      }),
      fixedNow,
    );
    const parsed = JSON.parse(transformed) as {
      messages: { role: string; content: string }[];
    };

    expect(parsed.messages[0]).toEqual({
      role: "system",
      content: buildLlmTimeContext(fixedNow),
    });
    expect(parsed.messages[1].content).toBe("あなたは検索判定アシスタントです。");
    expect(JSON.stringify(parsed.messages)).not.toContain("今日の日付: 2026-08-22");
  });

  it("does not duplicate a previously injected JST context", () => {
    const once = injectLlmTimeContextIntoBody(
      JSON.stringify({
        messages: [{ role: "user", content: "test" }],
      }),
      fixedNow,
    );
    const twice = injectLlmTimeContextIntoBody(once, fixedNow);
    const parsed = JSON.parse(twice) as {
      messages: { role: string; content: string }[];
    };

    expect(parsed.messages.filter((message) => message.content.startsWith("現在日時:"))).toHaveLength(1);
  });

  it("wraps only chat-completions fetch requests", async () => {
    const baseFetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const wrapped = createLlmTimeContextFetch(baseFetch, () => fixedNow);

    await wrapped("https://api.example.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await wrapped("https://api.example.com/v1/audio/transcriptions", {
      method: "POST",
      body: "not-json-chat-body",
    });

    expect(baseFetch).toHaveBeenCalledTimes(2);
    const firstInit = (baseFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const firstBody = JSON.parse(String(firstInit.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(firstBody.messages[0].content).toBe(buildLlmTimeContext(fixedNow));

    const secondInit = (baseFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as RequestInit;
    expect(secondInit.body).toBe("not-json-chat-body");
  });
});
