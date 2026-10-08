import { describe, expect, it, vi } from "vitest";
import { requestUserContext } from "../middlewares/requireAuth";
import {
  checkProviderBaseUrl,
  guardUserProviderFetch,
  UnsafeProviderUrlError,
} from "./provider-base-url";

const PRIVATE_TARGETS = [
  "http://127.0.0.1:5000/v1",
  "http://localhost:8080",
  "http://169.254.169.254/latest/meta-data",
  "http://10.0.0.5/v1",
  "http://192.168.1.10/v1",
  "http://100.100.1.2/v1", // Tailscale CGNAT
  "http://[::1]/v1",
  "http://db.internal/v1",
];

describe("checkProviderBaseUrl", () => {
  it.each(PRIVATE_TARGETS)("rejects %s for general users", async (url) => {
    await expect(
      checkProviderBaseUrl(url, { allowPrivate: false }),
    ).rejects.toBeInstanceOf(UnsafeProviderUrlError);
  });

  it("rejects non-http schemes and embedded credentials for everyone", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://x/",
      "https://u:p@example.com/v1",
      "not a url",
    ]) {
      await expect(
        checkProviderBaseUrl(url, { allowPrivate: true }),
      ).rejects.toBeInstanceOf(UnsafeProviderUrlError);
    }
  });

  it("allows public addresses and normalizes the trailing slash", async () => {
    await expect(
      checkProviderBaseUrl("https://8.8.8.8/v1/", { allowPrivate: false }),
    ).resolves.toBe("https://8.8.8.8/v1");
  });

  it("lets admins use private endpoints", async () => {
    await expect(
      checkProviderBaseUrl("http://127.0.0.1:11434/v1", { allowPrivate: true }),
    ).resolves.toBe("http://127.0.0.1:11434/v1");
  });
});

describe("guardUserProviderFetch", () => {
  it("blocks private targets inside a general user's request", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const guarded = guardUserProviderFetch(inner);
    await expect(
      requestUserContext.run({ userId: "u", userRole: "user" }, () =>
        guarded("http://127.0.0.1:5432/chat/completions"),
      ),
    ).rejects.toBeInstanceOf(UnsafeProviderUrlError);
    expect(inner).not.toHaveBeenCalled();
  });

  it("passes admin requests through unchanged", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const guarded = guardUserProviderFetch(inner);
    const res = await requestUserContext.run(
      { userId: "a", userRole: "admin" },
      () => guarded("http://127.0.0.1:11434/v1/chat/completions"),
    );
    expect(await res.text()).toBe("ok");
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
