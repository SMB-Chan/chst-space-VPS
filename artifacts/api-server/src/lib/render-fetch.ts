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
import { logger, safeFailureFields } from "./logger";
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
/** Cleanup may exceed the external deadline only by this small tolerance. */
const BROWSER_CLEANUP_TOLERANCE_MS = 250;

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

export function remainingBrowserDeadlineMs(
  deadlineAtMs: number,
  nowMs = Date.now(),
  capMs = Number.POSITIVE_INFINITY,
): number {
  const remaining = Math.max(0, Math.floor(deadlineAtMs - nowMs));
  if (!Number.isFinite(capMs)) return remaining;
  return Math.min(remaining, Math.max(0, Math.floor(capMs)));
}

class BrowserDeadlineExceededError extends Error {
  constructor(stage: string) {
    super(`Browser fetch deadline exceeded during ${stage}`);
    this.name = "BrowserDeadlineExceededError";
  }
}

async function withBrowserDeadline<T>(
  operation: Promise<T>,
  deadlineAtMs: number,
  stage: string,
): Promise<T> {
  const remaining = remainingBrowserDeadlineMs(deadlineAtMs);
  if (remaining <= 0) throw new BrowserDeadlineExceededError(stage);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new BrowserDeadlineExceededError(stage)),
          remaining,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter (Chromium contexts are expensive on small hosts)
// ---------------------------------------------------------------------------

/** Max simultaneous browser page loads. Default 2; raise after load testing. */
const MAX_BROWSER_CONCURRENCY = (() => {
  const n = Number(process.env.PLAYWRIGHT_MAX_CONCURRENCY ?? "2");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
})();

let activeBrowserJobs = 0;
interface BrowserJobWaiter {
  grant(): void;
}
const browserJobQueue: BrowserJobWaiter[] = [];

async function acquireBrowserSlot(deadlineAtMs: number): Promise<boolean> {
  if (activeBrowserJobs < MAX_BROWSER_CONCURRENCY) {
    activeBrowserJobs++;
    return true;
  }

  const remaining = remainingBrowserDeadlineMs(deadlineAtMs);
  if (remaining <= 0) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter: BrowserJobWaiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        activeBrowserJobs++;
        resolve(true);
      },
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const index = browserJobQueue.indexOf(waiter);
      if (index >= 0) browserJobQueue.splice(index, 1);
      resolve(false);
    }, remaining);
    timer.unref?.();
    browserJobQueue.push(waiter);
  });
}

function releaseBrowserSlot(): void {
  activeBrowserJobs = Math.max(0, activeBrowserJobs - 1);
  const next = browserJobQueue.shift();
  if (next) next.grant();
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
export async function isSafeBrowserRequestUrl(
  rawUrl: string,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // Internal, non-network document URLs do not open a socket themselves.
  if (
    url.protocol === "about:" ||
    url.protocol === "data:" ||
    url.protocol === "blob:"
  ) {
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
    logger.warn(
      { component: "render-fetch", errorCode: "BROWSER_REQUEST_BLOCKED" },
      "Blocked browser request (SSRF guard)",
    );
    await route.abort("blockedbyclient");
  });

  // Page extraction never needs a persistent socket. Blocking all WebSockets
  // prevents ws:// / wss:// from becoming a second, unvalidated network path.
  await context.routeWebSocket("**/*", async (socket) => {
    logger.debug(
      { component: "render-fetch", eventCode: "BROWSER_WEBSOCKET_BLOCKED" },
      "Blocked browser WebSocket",
    );
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
      logger.warn(
        { executablePath: explicit },
        "Configured Chromium executable is unavailable",
      );
    }
  }

  const pathEntries = (env.PATH ?? "").split(":").filter(Boolean);
  const names = [
    "chromium",
    "chromium-browser",
    "google-chrome-stable",
    "google-chrome",
  ];
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
          if (
            currentBrowser === browser &&
            browserPromise === observedPromise
          ) {
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

async function createContext(deadlineAtMs: number): Promise<BrowserContext> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const browser = await withBrowserDeadline(
        getBrowser(),
        deadlineAtMs,
        "browser launch",
      );
      return await withBrowserDeadline(
        browser.newContext(getBrowserContextOptions()),
        deadlineAtMs,
        "browser context creation",
      );
    } catch (err) {
      lastErr = err;
      logger.warn(
        safeFailureFields(err, "render-fetch", "BROWSER_CONTEXT_CREATE_FAILED"),
        "Browser context creation failed; resetting browser",
      );
      discardBrowser();
      if (err instanceof BrowserDeadlineExceededError) throw err;
    }
  }
  throw lastErr;
}

async function closeContextBounded(context: BrowserContext): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    context.close().then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), BROWSER_CLEANUP_TOLERANCE_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!closed) {
    logger.warn(
      "Browser context cleanup exceeded tolerance; resetting browser",
    );
    discardBrowser();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchWithBrowser(
  url: string,
  timeoutMs: number,
): Promise<{ title: string; text: string } | null> {
  const startedAt = Date.now();
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 1;
  const deadlineAtMs = startedAt + normalizedTimeoutMs;
  browserMetrics.attempts += 1;

  let slotAcquired = false;
  let context: BrowserContext | undefined;
  try {
    slotAcquired = await acquireBrowserSlot(deadlineAtMs);
    if (!slotAcquired) {
      browserMetrics.failures += 1;
      logger.warn(
        {
          component: "render-fetch",
          errorCode: "BROWSER_SLOT_DEADLINE_EXCEEDED",
        },
        "Browser fetch deadline exceeded while waiting for a slot",
      );
      return null;
    }

    try {
      context = await createContext(deadlineAtMs);
    } catch (err) {
      if (err instanceof BrowserDeadlineExceededError) {
        browserMetrics.failures += 1;
        logger.warn(
          safeFailureFields(
            err,
            "render-fetch",
            "BROWSER_NAVIGATION_DEADLINE_EXCEEDED",
          ),
          "Browser fetch deadline exceeded before navigation",
        );
      } else {
        browserMetrics.unavailable += 1;
        logger.warn(
          safeFailureFields(err, "render-fetch", "BROWSER_UNAVAILABLE"),
          "Playwright browser unavailable; skipping browser fallback",
        );
      }
      return null;
    }

    try {
      await withBrowserDeadline(
        installRequestGuard(context),
        deadlineAtMs,
        "request guard setup",
      );
      const page = await withBrowserDeadline(
        context.newPage(),
        deadlineAtMs,
        "page creation",
      );
      const navigationTimeoutMs = remainingBrowserDeadlineMs(deadlineAtMs);
      if (navigationTimeoutMs <= 0) {
        throw new BrowserDeadlineExceededError("navigation");
      }
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs,
      });
      if (!response || !response.ok()) {
        browserMetrics.failures += 1;
        logger.warn(
          safeFailureFields(
            undefined,
            "render-fetch",
            "BROWSER_FETCH_REJECTED",
            response?.status() ?? 502,
          ),
          "Browser fetch rejected",
        );
        return null;
      }

      const settleTimeoutMs = remainingBrowserDeadlineMs(
        deadlineAtMs,
        Date.now(),
        RENDER_SETTLE_MS,
      );
      if (settleTimeoutMs > 0) {
        await page
          .waitForLoadState("networkidle", { timeout: settleTimeoutMs })
          .catch(() => undefined);
      }

      const { title, articleText, bodyText } = await withBrowserDeadline(
        page.evaluate(() => {
          const doc = (globalThis as Record<string, unknown>).document as {
            title: string;
            querySelector(selector: string): { innerText?: string } | null;
            body?: { innerText?: string } | null;
          };
          const semantic =
            doc.querySelector("article") ?? doc.querySelector("main");
          return {
            title: doc.title,
            articleText: semantic?.innerText?.trim() ?? "",
            bodyText: doc.body?.innerText?.trim() ?? "",
          };
        }),
        deadlineAtMs,
        "page evaluation",
      );
      const text = articleText.length >= 200 ? articleText : bodyText;
      if (text.length === 0) {
        browserMetrics.failures += 1;
        return null;
      }
      browserMetrics.successes += 1;
      return { title: title || url, text };
    } catch (err) {
      browserMetrics.failures += 1;
      if (err instanceof BrowserDeadlineExceededError) {
        logger.warn(
          safeFailureFields(
            err,
            "render-fetch",
            "BROWSER_FETCH_DEADLINE_EXCEEDED",
          ),
          "Browser fetch deadline exceeded",
        );
      } else {
        logger.warn(
          safeFailureFields(err, "render-fetch", "BROWSER_FETCH_FAILED"),
          "Browser fetch failed",
        );
      }
      return null;
    }
  } finally {
    if (context) await closeContextBounded(context);
    if (slotAcquired) releaseBrowserSlot();
    browserMetrics.totalLatencyMs += Math.max(0, Date.now() - startedAt);
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
