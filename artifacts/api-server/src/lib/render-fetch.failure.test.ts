import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithBrowser,
  type BrowserFetchDependencies,
} from "./render-fetch";

function browserDependencies(args: {
  goto: ReturnType<typeof vi.fn>;
  close?: ReturnType<typeof vi.fn>;
}): BrowserFetchDependencies {
  const page = {
    goto: args.goto,
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({
      title: "Example",
      articleText: "A".repeat(240),
      bodyText: "",
    }),
  };
  const context = {
    route: vi.fn().mockResolvedValue(undefined),
    routeWebSocket: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    close: args.close ?? vi.fn().mockResolvedValue(undefined),
  };
  return {
    createContext: vi.fn().mockResolvedValue(context),
  };
}

async function expectProcessStaysAlive(
  operation: () => Promise<unknown>,
): Promise<void> {
  const uncaught: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  try {
    await operation();
    await new Promise((resolve) => setImmediate(resolve));
    expect(uncaught).toEqual([]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
  }
}

describe("browser fallback failure isolation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails open when navigation rejects and context cleanup also fails", async () => {
    const dependencies = browserDependencies({
      goto: vi.fn().mockRejectedValue(new Error("navigation reset")),
      close: vi.fn().mockRejectedValue(new Error("cleanup reset")),
    });

    await expectProcessStaysAlive(async () => {
      await expect(
        fetchWithBrowser(
          "https://example.com/article",
          100,
          undefined,
          dependencies,
        ),
      ).resolves.toBeNull();
    });
  });

  it("fails open when navigation reaches the browser deadline", async () => {
    const dependencies = browserDependencies({
      goto: vi.fn().mockImplementation(() => new Promise(() => undefined)),
    });

    await expectProcessStaysAlive(async () => {
      await expect(
        fetchWithBrowser(
          "https://example.com/article",
          20,
          undefined,
          dependencies,
        ),
      ).resolves.toBeNull();
    });
  });
});
