import type { Browser, BrowserContext, Route } from "playwright";
import { logger } from "./logger";
import { assertSafeUrl } from "./ssrf-guard";

/**
 * Last-resort page fetching with a real headless browser (Playwright).
 *
 * Reached only when plain HTTP extraction and embedded-JSON extraction both
 * failed (JS-rendered shells, bot-protection interstitials).  The browser is
 * a lazily-launched singleton; if Playwright or its Chromium is not
 * installed, this degrades to `null` with a warning instead of breaking the
 * API.
 *
 * Security: the browser path enforces the SAME network policy as the plain
 * HTTP path.  Every request the page generates (navigation, redirects,
 * subresources, XHR/fetch, iframes) passes through an SSRF guard that
 * re-validates protocol, hostname and resolved IPs before it is allowed.
 *
 * Disable with WEB_FETCH_PLAYWRIGHT_FALLBACK=0.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Extra settle time for client-side hydration after DOMContentLoaded. */
const RENDER_SETTLE_MS = 2_000;

/** Resource types the extractor never needs; blocking them shrinks the
 * attack surface and saves memory/CPU/bandwidth on small hosts. */
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

// ---------------------------------------------------------------------------
// Concurrency limiter (Chromium contexts are expensive on small hosts)
// ---------------------------------------------------------------------------

/** Max simultaneous browser page loads. Default 1; raise after load testing. */
const MAX_BROWSER_CONCURRENCY = (() => {
  const n = Number(process.env.PLAYWRIGHT_MAX_CONCURRENCY ?? "1");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
})();

let activeBrowserJobs = 0;
const browserJobQueue: Array<() => void> = [];

async function acquireBrowserSlot(): Promise<void> {
  if (activeBrowserJobs >= MAX_BROWSER_CONCURRENCY) {
    await new Promise<void>((resolve) => browserJobQueue.push(resolve));
  }
  activeBrowserJobs++;
}

function releaseBrowserSlot(): void {
  activeBrowserJobs--;
  const next = browserJobQueue.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// Browser-level SSRF guard
// ---------------------------------------------------------------------------

/**
 * Validate a browser-generated request URL against the SSRF policy.
 * `dnsCache` is scoped to a single page load so repeated subresource hosts
 * only pay one DNS lookup, while a fresh load always re-resolves (limiting
 * DNS-rebinding exposure to one page lifetime).
 */
export async function isSafeBrowserRequestUrl(
  rawUrl: string,
  dnsCache: Map<string, Promise<boolean>> = new Map(),
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  // Non-network schemes used internally by pages are harmless; everything
  // else that is not http(s) (file:, chrome:, ...) is rejected.
  if (url.protocol === "about:" || url.protocol === "data:" || url.protocol === "blob:") {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname;
  let check = dnsCache.get(host);
  if (!check) {
    check = assertSafeUrl(rawUrl).then(
      () => true,
      () => false,
    );
    dnsCache.set(host, check);
  }
  return check;
}

/** Attach request interception enforcing the SSRF policy on a context. */
async function installRequestGuard(context: BrowserContext): Promise<void> {
  const dnsCache = new Map<string, Promise<boolean>>();
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
      return route.abort("blockedbyclient");
    }
    if (await isSafeBrowserRequestUrl(request.url(), dnsCache)) {
      return route.continue();
    }
    logger.warn({ url: request.url() }, "Blocked browser request (SSRF guard)");
    return route.abort("blockedbyclient");
  });
}

// ---------------------------------------------------------------------------
// Shared browser lifecycle
// ---------------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;

async function launchBrowser(): Promise<Browser> {
  // Dynamic import: the API must keep working when playwright (or its
  // browser binaries) is absent.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  // A crashed/killed Chromium must not be served to future callers.
  browser.on("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser();
    // A failed launch (missing binary, missing system libs) must not poison
    // future attempts — reset so the next caller retries.
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

/** Drop the cached browser (after a crash) and close it best-effort. */
function discardBrowser(): void {
  const pending = browserPromise;
  browserPromise = null;
  pending?.then((b) => b.close()).catch(() => undefined);
}

/**
 * Create an isolated context.  If the cached browser died between launch and
 * use (Chromium crash), discard it and retry once with a fresh instance.
 */
async function createContext(): Promise<BrowserContext> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const browser = await getBrowser();
      return await browser.newContext({
        userAgent: BROWSER_UA,
        locale: "ja-JP",
        viewport: { width: 1280, height: 800 },
      });
    } catch (err) {
      lastErr = err;
      logger.warn({ err, attempt }, "Browser context creation failed; resetting browser");
      discardBrowser();
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render `url` in headless Chromium and return its title and visible text.
 * Returns null when the browser is unavailable, the page fails to load, or
 * the rendered content is still too thin.
 */
export async function fetchWithBrowser(
  url: string,
  timeoutMs: number,
): Promise<{ title: string; text: string } | null> {
  await acquireBrowserSlot();
  try {
    let context: BrowserContext;
    try {
      context = await createContext();
    } catch (err) {
      logger.warn(
        { err },
        "Playwright browser unavailable; skipping browser fallback " +
          "(run `pnpm --filter @workspace/api-server exec playwright install chromium`)",
      );
      return null;
    }
    try {
      await installRequestGuard(context);
      const page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      if (!response || !response.ok()) {
        logger.warn({ url, status: response?.status() }, "Browser fetch rejected");
        return null;
      }
      // Give client-side rendering a chance to hydrate, but never exceed the
      // caller's deadline for the whole operation.
      await page
        .waitForLoadState("networkidle", { timeout: RENDER_SETTLE_MS })
        .catch(() => undefined);

      const { title, articleText, bodyText } = await page.evaluate(() => {
        // Runs inside the browser; the server's tsconfig has no DOM lib, so
        // declare the minimal shape we rely on.
        const doc = (globalThis as Record<string, unknown>).document as {
          title: string;
          querySelector(selector: string): { innerText?: string } | null;
          body?: { innerText?: string } | null;
        };
        const semantic = doc.querySelector("article") ?? doc.querySelector("main");
        return {
          title: doc.title,
          articleText: semantic?.innerText?.trim() ?? "",
          bodyText: doc.body?.innerText?.trim() ?? "",
        };
      });
      const text = articleText.length >= 200 ? articleText : bodyText;
      if (text.length === 0) return null;
      return { title: title || url, text };
    } catch (err) {
      logger.warn({ err, url }, "Browser fetch failed");
      return null;
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    releaseBrowserSlot();
  }
}

/** Close the shared browser. Exported for tests and graceful shutdown. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  await pending.then((b) => b.close()).catch(() => undefined);
}
