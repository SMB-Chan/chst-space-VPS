import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";
import { SourceCards } from "./source-cards";

describe("message-scoped citations", () => {
  it("keeps identical citation numbers scoped to their own source sheets", () => {
    const html = renderToStaticMarkup(
      <>
        <Markdown content="前の回答 [1]" citationScope="message-101" />
        <SourceCards
          citationScope="message-101"
          sources={[{ title: "前の資料", url: "https://previous.example/" }]}
        />
        <Markdown content="今回の回答 [1]" citationScope="message-202" />
        <SourceCards
          citationScope="message-202"
          sources={[{ title: "今回の資料", url: "https://current.example/" }]}
        />
      </>,
    );

    expect(html).toContain('data-source-target="source-message-101-1"');
    expect(html).toContain('data-source-target="source-message-202-1"');
    expect(html.match(/aria-label="出典を開く（1件）"/g)).toHaveLength(2);
    expect(html).not.toContain('data-source-target="source-1"');
  });
});
