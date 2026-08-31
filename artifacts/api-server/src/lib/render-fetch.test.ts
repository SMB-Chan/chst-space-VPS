import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getBrowserContextOptions,
  getBrowserNetworkArgs,
  isSafeBrowserRequestUrl,
  remainingBrowserDeadlineMs,
  resolveSystemChromiumExecutable,
} from "./render-fetch";

/**
 * SSRF regression tests for the headless-browser path. Request routing rejects
 * unsafe URLs early, while the loopback egress proxy enforces the same private
 * address policy on the actual HTTP(S) destination connect.
 */
describe("isSafeBrowserRequestUrl", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://localhost/",
    "http://foo.localhost/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.0.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://printer.local/",
    "http://db.internal/",
    "file:///etc/passwd",
    "chrome://settings/",
    "ws://127.0.0.1/socket",
    "wss://8.8.8.8/socket",
    "http://user:pass@8.8.8.8/",
    "not a url",
  ];

  const allowed = [
    "https://8.8.8.8/",
    "http://1.1.1.1/path?q=1",
    "about:blank",
    "data:text/html,<p>hi</p>",
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, async () => {
      expect(await isSafeBrowserRequestUrl(url)).toBe(false);
    });
  }

  for (const url of allowed) {
    it(`allows ${url}`, async () => {
      expect(await isSafeBrowserRequestUrl(url)).toBe(true);
    });
  }

  it("does not let a previous safe host verdict mask credentials", async () => {
    expect(await isSafeBrowserRequestUrl("https://8.8.8.8/public")).toBe(true);
    expect(
      await isSafeBrowserRequestUrl("https://user:pass@8.8.8.8/private"),
    ).toBe(false);
  });
});

describe("Chromium network containment", () => {
  it("forces loopback targets through the proxy and disables direct UDP paths", () => {
    const args = getBrowserNetworkArgs();
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--disable-quic");
    expect(args).toContain(
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    );
  });
});

describe("Chromium user-agent fidelity", () => {
  it("does not override the executable's native user agent", () => {
    expect(getBrowserContextOptions()).not.toHaveProperty("userAgent");
  });
});

describe("browser operation deadline", () => {
  it("returns only time remaining from the absolute deadline", () => {
    expect(remainingBrowserDeadlineMs(1_500, 1_000)).toBe(500);
    expect(remainingBrowserDeadlineMs(1_500, 1_600)).toBe(0);
  });

  it("caps optional settle work without extending the operation deadline", () => {
    expect(remainingBrowserDeadlineMs(5_000, 1_000, 2_000)).toBe(2_000);
    expect(remainingBrowserDeadlineMs(2_500, 1_000, 2_000)).toBe(1_500);
  });
});

describe("resolveSystemChromiumExecutable", () => {
  it("prefers an explicit executable path", () => {
    expect(
      resolveSystemChromiumExecutable({
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.execPath,
        PATH: "",
      }),
    ).toBe(process.execPath);
  });

  it("discovers chromium on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-space-chromium-"));
    const chromium = join(dir, "chromium");
    try {
      writeFileSync(chromium, "#!/bin/sh\nexit 0\n");
      chmodSync(chromium, 0o755);
      expect(resolveSystemChromiumExecutable({ PATH: dir })).toBe(chromium);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no executable is available", () => {
    expect(resolveSystemChromiumExecutable({ PATH: "" })).toBeNull();
  });
});
