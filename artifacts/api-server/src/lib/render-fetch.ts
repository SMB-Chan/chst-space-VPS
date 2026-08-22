import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Route,
} from "playwright";
import {
  closeBrowserEgressProxy,
  getBrowserEgressProxy,
} from "./browser-egress-proxy";
import { logger } from "./logger";
import { assertSafeUrl } from "./ssrf-guard";

/**
 * Last-resort page fetching with a real headless browser (Playwright).
 *
 * Reached only when plain HTTP extraction and embedded-JSON extraction both
 * failed (JS-rendered shells, bot-protection interstitials). The browser is a
 * lazily-launched singleton; if Playwright, Chromium, or the safe egress proxy
 * is unavailable, this degrades to `null` instead of breaking the API.
 *
 * Security is enforced in two layers:
 * 1. context routing preflights every HTTP(S) request against the shared SSRF
 *    policy and blocks unnecessary resource/WebSocket/Service Worker paths;
 * 2. Chromium is forced through a loopback-only egress proxy whose actual
 *    destination connect uses createSafeDnsLookup(). This makes the IP that is
 *    connected to subject to the private-address policy after DNS resolution,
 *    closing the browser DNS-rebinding gap left by route preflight alone.
 *
 * Disable with WEB_FETCH_PLAYWRIGHT_FALLBACK=0.
 */

/** Extra settle time for client-side hydration after DOMContentLoaded. */
const RENDER_SETTLE_MS = 2_000;

/** Resource types the extractor never needs. */
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

const BROWSER_NETWORK_ARGS = [
  // Chromium normally bypasses proxies for localhost/link-local targets even
  // when a manual proxy is configured. Subtract that implicit bypass so every
  // HTTP(S) destination is forced through our connection-layer policy.
  "--proxy-bypass-list=<-loopback>",
  // Article extraction does not need QUIC/WebTransport UDP. Keep HTTP(S) on
  // the proxyable TCP paths where the egress policy is enforced.
  "--disable-quic",
  // Prevent WebRTC from creating a non-proxied UDP egress path.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
] as const;

export interface BrowserFetchMetrics {
  attempts: number;
  successes: number;
  failures: number;
  unavailable: number;
  crashes: number;
  totalLatencyMs: number;
}

const browserMetrics: BrowserFetchMetrics = {
  attempts: 0,
  successes: 0,
  failures: 0,
  unavailable: 0,
  crashes: 0,
  totalLatencyMs: 0,
};

export function getBrowserFetchMetrics(): BrowserFetchMetrics {
  return { ...browserMetrics };
}

export function getBrowserNetworkArgs(): readonly string[] {
  return BROWSER_NETWORK_ARGS;
}

/**
 * Keep context settings independent from browser-version identity. In
 * particular, do not override `userAgent`: Chromium should advertise the UA
 * corresponding to the actual executable launched on the host.
 */
export function getBrowserContextOptions(): BrowserContextOptions {
  return {
    locale: "ja-JP",
    viewport: { width: 1280, height: 800 },
    // Playwright documents that context.route() cannot reliably account for
    // page requests handled by a Service Worker. Block registration so every
    // network request stays on the routed path below.
    serviceWorkers: "block",
  };
}

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
// Browser-level network guard
// ---------------------------------------------------------------------------

/**
 * Validate a browser-generated request URL against the SSRF policy.
 *
 * Deliberately do not cache successful hostname/DNS verdicts here. The egress
 * proxy provides the authoritative connection-layer check, while this route
 * guard remains an earlier defense that blocks unsafe requests before they
 * reach the proxy at all.
 */
export async function isSafeBrowserRequestUrl(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // Internal, non-network document URLs do not open a socket themselves.
  if (url.protocol === "about:" || url.protocol === "data:" || url.protocol === "blob:") {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  // Check credentials before DNS work. This must never be hidden behind a
  // hostname-only cache because credentials are properties of the full URL.
  if (url.username || url.password) return false;

  try {
    await assertSafeUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

/** Attach interception before any page is created. */
async function installRequestGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
      await route.abort("blockedbyclient");
      return;
    }
    if (await isSafeBrowserRequestUrl(request.url())) {
      await route.continue();
      return;
    }
    logger.warn({ url: request.url() }, "Blocked browser request (SSRF guard)");
    await route.abort("blockedbyclient");
  });

  // Page extraction never needs a persistent socket. Blocking all WebSockets
  // prevents ws:// / wss:// from becoming a second, unvalidated network path.
  await context.routeWebSocket("**/*", async (socket) => {
    logger.debug({ url: socket.url() }, "Blocked browser WebSocket");
    await socket.close({ code: 1008, reason: "Network policy" });
  });
}

// ---------------------------------------------------------------------------
// Shared browser lifecycle
// ---------------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;
const plannedBrowserClosures = new WeakSet<Browser>();

/**
 * Prefer an operator-supplied Chromium path, then discover a system Chromium
 * from PATH. This lets Replit use its reproducible Nix Chromium without
 * downloading a separate Playwright browser bundle. Other hosts continue to
 * fall back to Playwright's managed executable when no system browser exists.
 */
export function resolveSystemChromiumExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (explicit) {
    try {
      accessSync(explicit, fsConstants.X_OK);
      return explicit;
    } catch {
      logger.warn({ executablePath: explicit }, "Configured Chromium executable is unavailable");
    }
  }

  const pathEntries = (env.PATH ?? "").split(":").filter(Boolean);
  const names = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];
  for (const directory of pathEntries) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

async function launchBrowser(): Promise<Browser> {
  const [{ chromium }, egressProxy] = await Promise.all([
    import("playwright"),
    getBrowserEgressProxy(),
  ]);
  const executablePath = resolveSystemChromiumExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    proxy: { server: egressProxy.server },
    args: [...BROWSER_NETWORK_ARGS],
  });
  logger.info(
    {
      browserSource: executablePath ? "system" : "playwright",
      executablePath: executablePath ?? undefined,
      egressPolicy: "loopback-safe-proxy",
    },
    "Headless Chromium launched",
  );
  browser.on("disconnected", () => {
    if (!plannedBrowserClosures.delete(browser)) {
      browserMetrics.crashes += 1;
    }
    // Do not let a delayed disconnect from an old/reset browser clear a newer
    // singleton browser that may already have launched.
    const observedPromise = browserPromise;
    if (observedPromise) {
      void observedPromise
        .then((currentBrowser) => {
          if (currentBrowser === browser && browserPromise === observedPromise) {
            browserPromise = null;
          }
        })
        .catch(() => undefined);
    }
  });
  return browser;
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

function discardBrowser(): void {
  const pending = browserPromise;
  browserPromise = null;
  pending
    ?.then((browser) => {
      plannedBrowserClosures.add(browser);
      return browser.close();
    })
    .catch(() => undefined);
}

async function createContext(): Promise<BrowserContext> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const browser = await getBrowser();
      return await browser.newContext(getBrowserContextOptions());
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

export async function fetchWithBrowser(
  url: string,
  timeoutMs: number,
): Promise<{ title: string; text: string } | null> {
  const startedAt = Date.now();
  browserMetrics.attempts += 1;
  await acquireBrowserSlot();
  try {
    let context: BrowserContext;
    try {
      context = await createContext();
    } catch (err) {
      browserMetrics.unavailable += 1;
      logger.warn(
        { err },
        "Playwright browser unavailable; skipping browser fallback",
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
        browserMetrics.failures += 1;
        logger.warn({ url, status: response?.status() }, "Browser fetch rejected");
        return null;
      }
      await page
        .waitForLoadState("networkidle", { timeout: RENDER_SETTLE_MS })
        .catch(() => undefined);

      const { title, articleText, bodyText } = await page.evaluate(() => {
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
      if (text.length === 0) {
        browserMetrics.failures += 1;
        return null;
      }
      browserMetrics.successes += 1;
      return { title: title || url, text };
    } catch (err) {
      browserMetrics.failures += 1;
      logger.warn({ err, url }, "Browser fetch failed");
      return null;
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    browserMetrics.totalLatencyMs += Math.max(0, Date.now() - startedAt);
    releaseBrowserSlot();
  }
}

/** Close the shared browser and its connection-layer egress proxy. */
export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (pending) {
    await pending
      .then((browser) => {
        plannedBrowserClosures.add(browser);
        return browser.close();
      })
      .catch(() => undefined);
  }
  await closeBrowserEgressProxy();
}
