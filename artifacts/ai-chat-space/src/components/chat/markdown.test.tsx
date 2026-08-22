import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("renders GFM tables, task-unrelated lists, and emphasis", () => {
    const html = renderToStaticMarkup(
      <Markdown
        content={[
          "# Title",
          "",
          "This is **bold** and `code`.",
          "",
          "| a | b |",
          "| --- | --- |",
          "| 1 | 2 |",
          "",
          "1. first",
          "2. second",
        ].join("\n")}
      />,
    );
    expect(html).toContain("<h2");
    expect(html).toContain("<strong");
    expect(html).toContain("<table");
    expect(html).toContain("<ol");
    expect(html).toContain("<code");
  });

  it("does not execute raw HTML", () => {
    const html = renderToStaticMarkup(
      <Markdown content={'<img src=x onerror="alert(1)"><script>alert(1)</script>hello'} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).toContain("hello");
  });

  it("renders remote Markdown images as opt-in links instead of img requests", () => {
    const html = renderToStaticMarkup(
      <Markdown content={'![tracking pixel](https://tracker.example/pixel.gif?x=1)'} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("tracking pixelを開く");
    expect(html).toContain("referrerPolicy=\"no-referrer\"");
  });

  it("does not make non-http links clickable", () => {
    const html = renderToStaticMarkup(<Markdown content={'[bad](javascript:alert(1))'} />);
    expect(html).not.toContain("javascript:");
  });
});
