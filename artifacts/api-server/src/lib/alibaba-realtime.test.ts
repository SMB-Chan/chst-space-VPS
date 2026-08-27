import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ALIBABA_REALTIME_LIMITS,
  AlibabaRealtimeError,
  createAlibabaRealtimeSession,
  normalizeAlibabaRealtimeEvent,
} from "./alibaba-realtime";

const env = {
  ALIBABA_SPECIALIST_API_KEY: "sk-regular",
  ALIBABA_SPECIALIST_WORKSPACE_ID: "ws-test",
} as NodeJS.ProcessEnv;

describe("Alibaba Qwen Audio realtime session broker", () => {
  it("creates a short-lived ticket without returning provider credentials", () => {
    const session = createAlibabaRealtimeSession({
      userId: `realtime-test-${randomUUID()}`,
      conversationId: 42,
      modelId: "o4-mini",
    }, env);

    expect(session.modelId).toBe("qwen-audio-3.0-realtime-plus");
    expect(session.websocketPath).toBe("/api/openai/realtime");
    expect(session.maxSessionSeconds).toBe(300);
    expect(session.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(session)).not.toContain("sk-regular");
    expect(ALIBABA_REALTIME_LIMITS.maxAudioChunkBytes).toBe(96 * 1024);
  });

  it("rejects specialist credentials that are Token Plan keys", () => {
    expect(() => createAlibabaRealtimeSession({
      userId: "token-plan-user",
      modelId: "gpt-4o-mini",
    }, {
      DASHSCOPE_API_KEY: "sk-sp-token-plan",
    } as NodeJS.ProcessEnv)).toThrow(AlibabaRealtimeError);
  });

  it("rejects specialist models as the route model", () => {
    try {
      createAlibabaRealtimeSession({
      userId: "specialist-model-user",
      modelId: "qwen-audio-3.0-realtime-plus",
      }, env);
      throw new Error("expected session creation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AlibabaRealtimeError);
      expect((error as AlibabaRealtimeError).publicMessage).toContain("選択中のチャットモデルには対応していません");
    }
  });

  it("rejects invalid conversation IDs", () => {
    try {
      createAlibabaRealtimeSession({
        userId: "invalid-conversation-user",
        conversationId: 0,
        modelId: "o4-mini",
      }, env);
      throw new Error("expected session creation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AlibabaRealtimeError);
      expect((error as AlibabaRealtimeError).publicMessage).toContain("会話IDが不正です");
    }
  });

  it("normalizes provider audio and transcript events without leaking provider metadata", () => {
    const state = { inputTranscript: "", responseTranscript: "" };
    expect(normalizeAlibabaRealtimeEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "  こんにちは  ",
      item_id: "provider-secret-id",
    }, state)).toEqual({
      type: "input.transcript.final",
      transcript: "こんにちは",
    });
    expect(normalizeAlibabaRealtimeEvent({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "さようなら",
    }, state)).toBeNull();
    expect(state.inputTranscript).toBe("こんにちはさようなら");
    expect(normalizeAlibabaRealtimeEvent({
      type: "response.audio.delta",
      delta: "AQI=",
      event_id: "provider-event-id",
    }, state)).toEqual({
      type: "response.audio.delta",
      audio: "AQI=",
    });
    expect(normalizeAlibabaRealtimeEvent({
      type: "response.done",
      response_id: "provider-response-id",
    }, state)).toEqual({
      type: "response.done",
      transcript: "こんにちはさようなら",
      responseTranscript: "",
    });
  });
});