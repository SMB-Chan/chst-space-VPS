import { describe, expect, it } from "vitest";
import { extractPublishedAtFromHtml } from "./web-search";

describe("extractPublishedAtFromHtml", () => {
  it("reads publication metadata regardless of attribute order", () => {
    expect(
      extractPublishedAtFromHtml(
        '<meta content="2026-08-23T09:30:00+09:00" property="article:published_time">',
      ),
    ).toBe("2026-08-23T00:30:00.000Z");
    expect(
      extractPublishedAtFromHtml(
        '<meta name="datePublished" content="2026-08-22">',
      ),
    ).toBe("2026-08-22T00:00:00.000Z");
  });

  it("reads JSON-LD and marked time elements", () => {
    expect(
      extractPublishedAtFromHtml(
        '<script type="application/ld+json">{"datePublished":"2025-09-08T12:00:00Z"}</script>',
      ),
    ).toBe("2025-09-08T12:00:00.000Z");
    expect(
      extractPublishedAtFromHtml(
        '<time class="entry-date published" datetime="2024-01-04T10:00:00Z">',
      ),
    ).toBe("2024-01-04T10:00:00.000Z");
  });

  it("rejects invalid, implausibly old, and future dates", () => {
    expect(
      extractPublishedAtFromHtml(
        '<meta property="article:published_time" content="not-a-date">',
      ),
    ).toBeNull();
    expect(
      extractPublishedAtFromHtml(
        '<meta property="article:published_time" content="1800-01-01">',
      ),
    ).toBeNull();
    expect(
      extractPublishedAtFromHtml(
        '<meta property="article:published_time" content="2999-01-01">',
      ),
    ).toBeNull();
  });
});
