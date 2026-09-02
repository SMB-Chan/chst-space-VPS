import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("renders GFM tables, task-unrelated lists, and emphasis", () => {
    const html = renderToStaticMarkup(
      <Markdown
        citationScope="message-test"
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
      <Markdown
        citationScope="message-test"
        content={'<img src=x onerror="alert(1)"><script>alert(1)</script>hello'}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).toContain("hello");
  });

  it("renders remote Markdown images as opt-in links instead of img requests", () => {
    const html = renderToStaticMarkup(
      <Markdown
        content={"![tracking pixel](https://tracker.example/pixel.gif?x=1)"}
        citationScope="message-test"
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("tracking pixelを開く");
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("does not make non-http links clickable", () => {
    const html = renderToStaticMarkup(
      <Markdown
        content={"[bad](javascript:alert(1))"}
        citationScope="message-test"
      />,
    );
    expect(html).not.toContain("javascript:");
  });

  it("transforms [N] citations in prose but not inside code blocks", () => {
    const html = renderToStaticMarkup(
      <Markdown
        citationScope="message-test"
        content={[
          "The answer is known [1].",
          "",
          "```js",
          "const arr = [1]",
          "```",
          "",
          "Inline `x = [2]` stays literal.",
        ].join("\n")}
      />,
    );
    // Prose citation becomes a scroll button (rendered as <button> by citeSourceLinks)
    expect(html).toContain("<button");
    // Code block [1] and inline code [2] must NOT become citation buttons
    expect(html).toContain("const arr = [1]");
    expect(html).toContain("x = [2]");
    // Count buttons: only the prose [1] should produce one, not code [1] or inline [2]
    const buttonCount = (html.match(/<button/g) ?? []).length;
    expect(buttonCount).toBe(1);
    expect(html).toContain('data-source-target="source-message-test-1"');
  });
});
