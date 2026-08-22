import { describe, expect, it } from "vitest";
import { isSafeBrowserRequestUrl } from "./render-fetch";

/**
 * SSRF regression tests for the headless-browser path.  Every request the
 * page generates (navigation, redirects, subresources, XHR, iframes) is
 * validated by isSafeBrowserRequestUrl before Playwright lets it through.
 */
describe("isSafeBrowserRequestUrl", () => {
  const blocked = [
    // loopback / unspecified
    "http://127.0.0.1/",
    "http://localhost/",
    "http://foo.localhost/",
    "http://0.0.0.0/",
    // RFC1918 private
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.0.1/",
    // link-local / cloud metadata endpoint
    "http://169.254.169.254/",
    // IPv6 loopback / ULA
    "http://[::1]/",
    "http://[fc00::1]/",
    // internal-ish hostnames
    "http://printer.local/",
    "http://db.internal/",
    // non-network schemes
    "file:///etc/passwd",
    "chrome://settings/",
    // credentials in URL
    "http://user:pass@8.8.8.8/",
    // garbage
    "not a url",
  ];

  const allowed = [
    "https://8.8.8.8/", // literal public IP, no DNS needed
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

  it("caches DNS verdicts per host within one page load", async () => {
    const cache = new Map<string, Promise<boolean>>();
    await isSafeBrowserRequestUrl("http://127.0.0.1/a", cache);
    await isSafeBrowserRequestUrl("http://127.0.0.1/b", cache);
    expect(cache.size).toBe(1);
    expect(await isSafeBrowserRequestUrl("http://127.0.0.1/c", cache)).toBe(false);
  });
});
