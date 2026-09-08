import { describe, expect, it, vi } from "vitest";

vi.mock("./ai-clients", () => ({
  dashscopeClient: { models: { list: vi.fn() } },
  xiaomiClient: { chat: { completions: { create: vi.fn() } } },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ASR_MODELS,
  TTS_MODELS,
  availableAsrModels,
  availableTtsLanguages,
  availableTtsModels,
  describeAvailableTtsModels,
  getTtsModel,
  isAsrModelId,
  isSpeechLanguage,
  isSpeechProviderAvailable,
  isTtsModelId,
  isTtsVoice,
  modelIdForVoice,
  selectDefaultTtsModel,
  ttsVoicesFor,
} from "./speech-capabilities";

const ALIBABA_READY = { ALIBABA_SPECIALIST_API_KEY: "regular-key" };
const ALIBABA_FROZEN = {
  ALIBABA_SPECIALIST_API_KEY: "regular-key",
  DISABLE_DASHSCOPE_MODELS: "true",
};
const XIAOMI_FROZEN = { DISABLE_XIAOMI_MODELS: "true" };
/** Alibaba reachable, MiMo frozen — the shape this installation had before MiMo audio. */
const ALIBABA_ONLY = {
  ALIBABA_SPECIALIST_API_KEY: "regular-key",
  DISABLE_XIAOMI_MODELS: "true",
};
const NOTHING_CONFIGURED = { ...ALIBABA_ONLY, ...ALIBABA_FROZEN };

describe("speech catalog", () => {
  it("knows every speech model and rejects look-alikes", () => {
    expect(isTtsModelId("qwen-audio-3.0-tts-plus")).toBe(true);
    expect(isTtsModelId("mimo-v2.5-tts")).toBe(true);
    expect(isTtsModelId("mimo-v2.5-tts-voicedesign")).toBe(true);
    expect(isTtsModelId("mimo-v2.5-asr")).toBe(false);
    expect(isTtsModelId("mimo-v2.5")).toBe(false);
    expect(isTtsModelId(undefined)).toBe(false);

    expect(isAsrModelId("mimo-v2.5-asr")).toBe(true);
    expect(isAsrModelId("qwen-audio-3.0-asr-flash")).toBe(true);
    expect(isAsrModelId("paraformer-v2")).toBe(true);
    expect(isAsrModelId("mimo-v2.5-tts")).toBe(false);
  });

  it("keeps each model's voice list separate", () => {
    expect(ttsVoicesFor("mimo-v2.5-tts")).toContain("Mia");
    expect(ttsVoicesFor("qwen-audio-3.0-tts-plus")).toContain("longanlingxin");
    expect(ttsVoicesFor("mimo-v2.5-tts-voicedesign")).toEqual([]);
    expect(ttsVoicesFor("not-a-model")).toEqual([]);
    expect(isTtsVoice("mimo-v2.5-tts", "Mia")).toBe(true);
    expect(isTtsVoice("mimo-v2.5-tts", "longanlingxin")).toBe(false);
  });

  it("resolves a lone voice back to the model that owns it", () => {
    expect(modelIdForVoice("Mia")).toBe("mimo-v2.5-tts");
    expect(modelIdForVoice("冰糖")).toBe("mimo-v2.5-tts");
    expect(modelIdForVoice("longanlufeng")).toBe("qwen-audio-3.0-tts-plus");
    expect(modelIdForVoice("not-a-voice")).toBeUndefined();
  });

  it("records which models take prosody and voice instructions", () => {
    expect(getTtsModel("qwen-audio-3.0-tts-plus")).toMatchObject({
      provider: "alibaba",
      supportsProsody: true,
      supportsInstruction: true,
    });
    expect(getTtsModel("mimo-v2.5-tts")).toMatchObject({
      provider: "xiaomi",
      supportsProsody: false,
      supportsInstruction: false,
    });
    expect(getTtsModel("mimo-v2.5-tts-voicedesign")).toMatchObject({
      provider: "xiaomi",
      supportsProsody: false,
      supportsInstruction: true,
    });
  });

  it("accepts exactly the three spoken languages", () => {
    expect(isSpeechLanguage("ja")).toBe(true);
    expect(isSpeechLanguage("zh")).toBe(true);
    expect(isSpeechLanguage("en")).toBe(true);
    expect(isSpeechLanguage("fr")).toBe(false);
    expect(isSpeechLanguage(42)).toBe(false);
  });
});

describe("provider availability", () => {
  it("follows credentials and the freeze flags independently", () => {
    expect(isSpeechProviderAvailable("alibaba", ALIBABA_READY)).toBe(true);
    expect(isSpeechProviderAvailable("alibaba", ALIBABA_FROZEN)).toBe(false);
    expect(isSpeechProviderAvailable("alibaba", {})).toBe(false);
    expect(isSpeechProviderAvailable("xiaomi", {})).toBe(true);
    expect(isSpeechProviderAvailable("xiaomi", XIAOMI_FROZEN)).toBe(false);
  });

  it("rejects a Token Plan key for Alibaba specialist audio", () => {
    expect(
      isSpeechProviderAvailable("alibaba", {
        ALIBABA_SPECIALIST_API_KEY: "sk-sp-team-key",
      }),
    ).toBe(false);
  });

  it("lists only the reachable models", () => {
    expect(availableTtsModels(ALIBABA_READY).map((model) => model.id)).toEqual([
      "qwen-audio-3.0-tts-plus",
      "mimo-v2.5-tts",
      "mimo-v2.5-tts-voicedesign",
    ]);
    expect(availableTtsModels(ALIBABA_ONLY).map((model) => model.id)).toEqual([
      "qwen-audio-3.0-tts-plus",
    ]);
    expect(availableTtsModels(NOTHING_CONFIGURED)).toEqual([]);
  });

  it("keeps Paraformer on a plain DashScope key without specialist credentials", () => {
    const ids = availableAsrModels({
      DASHSCOPE_API_KEY: "regular-key",
      DISABLE_XIAOMI_MODELS: "true",
    }).map((model) => model.id);
    expect(ids).toEqual(["qwen-audio-3.0-asr-flash", "paraformer-v2"]);

    const tokenPlanIds = availableAsrModels({
      DASHSCOPE_API_KEY: "sk-sp-team-key",
      DISABLE_XIAOMI_MODELS: "true",
    }).map((model) => model.id);
    expect(tokenPlanIds).not.toContain("paraformer-v2");
  });

  it("offers MiMo ASR when nothing else is configured", () => {
    expect(availableAsrModels({}).map((model) => model.id)).toEqual([
      "mimo-v2.5-asr",
    ]);
    expect(ASR_MODELS).toHaveLength(3);
    expect(TTS_MODELS).toHaveLength(3);
  });

  it("adds Japanese to the covered languages only with MiMo reachable", () => {
    expect(availableTtsLanguages(ALIBABA_READY)).toEqual(["zh", "en", "ja"]);
    expect(availableTtsLanguages(ALIBABA_ONLY)).toEqual(["zh", "en"]);
  });
});

describe("selectDefaultTtsModel", () => {
  it("prefers Alibaba when both vendors are reachable", () => {
    expect(selectDefaultTtsModel({}, ALIBABA_READY)?.id).toBe(
      "qwen-audio-3.0-tts-plus",
    );
  });

  it("falls back to MiMo when Alibaba is missing or frozen", () => {
    expect(selectDefaultTtsModel({}, {})?.id).toBe("mimo-v2.5-tts");
    expect(selectDefaultTtsModel({}, ALIBABA_FROZEN)?.id).toBe("mimo-v2.5-tts");
  });

  it("routes Japanese to the MiMo voice design model", () => {
    expect(
      selectDefaultTtsModel({ languageHint: "ja" }, ALIBABA_READY)?.id,
    ).toBe("mimo-v2.5-tts-voicedesign");
    expect(selectDefaultTtsModel({ languageHint: "ja" }, {})?.id).toBe(
      "mimo-v2.5-tts-voicedesign",
    );
  });

  it("refuses Japanese when only Alibaba is reachable", () => {
    expect(
      selectDefaultTtsModel({ languageHint: "ja" }, ALIBABA_ONLY),
    ).toBeUndefined();
    expect(
      selectDefaultTtsModel({ languageHint: "ja" }, NOTHING_CONFIGURED),
    ).toBeUndefined();
  });

  it("routes a voice instruction to a model that accepts one", () => {
    expect(
      selectDefaultTtsModel({ instruction: "明るい声" }, ALIBABA_READY)?.id,
    ).toBe("qwen-audio-3.0-tts-plus");
    expect(selectDefaultTtsModel({ instruction: "明るい声" }, {})?.id).toBe(
      "mimo-v2.5-tts-voicedesign",
    );
  });

  it("returns nothing when no speech provider is configured", () => {
    expect(selectDefaultTtsModel({}, NOTHING_CONFIGURED)).toBeUndefined();
  });
});

describe("describeAvailableTtsModels", () => {
  it("tells the router what each reachable model can do", () => {
    const described = describeAvailableTtsModels(ALIBABA_READY);
    expect(described).toContain("qwen-audio-3.0-tts-plus [alibaba]");
    expect(described).toContain("languages=zh+en");
    expect(described).toContain("mimo-v2.5-tts-voicedesign [xiaomi]");
    expect(described).toContain("languages=zh+en+ja");
    expect(described).toContain("rate/pitch/volume=yes");
    expect(described).toContain("rate/pitch/volume=no");
    expect(described).toContain(
      "voices=none (design the voice with instruction)",
    );
  });

  it("says so plainly when nothing is configured", () => {
    expect(describeAvailableTtsModels(NOTHING_CONFIGURED)).toBe(
      "(none configured)",
    );
  });
});
