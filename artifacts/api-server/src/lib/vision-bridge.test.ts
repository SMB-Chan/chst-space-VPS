import { afterEach, describe, expect, it } from "vitest";
import { isVisionBridgeAvailable } from "./vision-bridge";

describe("vision bridge availability", () => {
  afterEach(() => {
    delete process.env.VISION_BRIDGE_MODEL;
  });

  it("is available by default (falls back to a vision-capable model)", () => {
    expect(isVisionBridgeAvailable()).toBe(true);
  });

  it("rejects a non-vision override model", () => {
    process.env.VISION_BRIDGE_MODEL = "deepseek-v4-pro";
    expect(isVisionBridgeAvailable()).toBe(false);
  });

  it("accepts a vision-capable override model", () => {
    process.env.VISION_BRIDGE_MODEL = "qwen3.8-max";
    expect(isVisionBridgeAvailable()).toBe(true);
  });

  it("rejects an unknown override model", () => {
    process.env.VISION_BRIDGE_MODEL = "no-such-model";
    expect(isVisionBridgeAvailable()).toBe(false);
  });
});
