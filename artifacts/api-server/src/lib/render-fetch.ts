import type { Browser } from "playwright";
import { logger } from "./logger";

/**
 * Last-resort page fetching with a real headless browser (Playwright).
 *
 * Reached only when plain HTTP extraction and embedded-JSON extraction both
 * failed (JS-rendered shells, bot-protection interstitials).  The browser is
 * a lazily-launched singleton; if Playwright or its Chromium is not
 * installed, this degrades to `null` with a warning instead of breaking the
 * API.
 *
 * Disable with WEB_FETCH_PLAYWRIGHT_FALLBACK=0.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Extra settle time for client-side hydration after DOMContentLoaded. */
const RENDER_SETTLE_MS = 2_000;

let browserPromise: Promise<Browser> | null = null;

async function launchBrowser(): Promise<Browser> {
  // Dynamic import: the API must keep working when playwright (or its
  // browser binaries) is absent.
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
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

/**
 * Render `url` in headless Chromium and return its title and visible text.
 * Returns null when the browser is unavailable, the page fails to load, or
 * the rendered content is still too thin.
 */
export async function fetchWithBrowser(
  url: string,
  timeoutMs: number,
): Promise<{ title: string; text: string } | null> {
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    logger.warn(
      { err },
      "Playwright browser unavailable; skipping browser fallback " +
        "(run `pnpm --filter @workspace/api-server exec playwright install chromium`)",
    );
    return null;
  }

  // A fresh context per fetch isolates cookies/storage between target sites.
  const context = await browser.newContext({
    userAgent: BROWSER_UA,
    locale: "ja-JP",
    viewport: { width: 1280, height: 800 },
  });
  try {
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
}

/** Close the shared browser. Exported for tests and graceful shutdown. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  await pending.then((b) => b.close()).catch(() => undefined);
}
