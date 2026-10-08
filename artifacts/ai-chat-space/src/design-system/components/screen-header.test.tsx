import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScreenHeader } from "./screen-header";

const render = (...args: Parameters<typeof renderToStaticMarkup>) =>
  renderToStaticMarkup(...args);

describe("ScreenHeader (Apple HIG §3.6 Simplicity)", () => {
  it("renders h1 title and optional description as header landmark", () => {
    const html = render(
      <ScreenHeader
        title="設定"
        description="モデル、監査、保存データを管理します。"
      />,
    );
    expect(html).toMatch(/<header[^>]*>/);
    expect(html).toContain("<h1");
    expect(html).toContain("設定");
    expect(html).toContain("モデル、監査、保存データを管理します。");
  });

  it("renders actions slot when provided", () => {
    const html = render(
      <ScreenHeader
        title="設定"
        actions={<button>保存</button>}
      />,
    );
    expect(html).toContain("<button");
    expect(html).toContain("保存");
  });

  it("works without description or actions", () => {
    const html = render(<ScreenHeader title="タイトル" />);
    expect(html).toContain("<h1");
    expect(html).toContain("タイトル");
  });
});
