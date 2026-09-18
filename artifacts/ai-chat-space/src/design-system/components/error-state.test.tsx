import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorState } from "./error-state";

const render = (...args: Parameters<typeof renderToStaticMarkup>) =>
  renderToStaticMarkup(...args);

describe("ErrorState", () => {
  it("renders title as a heading and description as actionable copy", () => {
    const html = render(
      <ErrorState
        title="表示できませんでした"
        description="再読み込みで復旧する場合があります。"
        primaryAction={<button type="button">もう一度試す</button>}
      />,
    );
    expect(html).toContain("表示できませんでした");
    expect(html).toContain("再読み込みで復旧");
    expect(html).toContain("もう一度試す");
    expect(html).toContain("<h1");
    expect(html).toContain("<p");
  });

  it("uses role=alert so screen readers announce failures immediately", () => {
    const html = render(<ErrorState title="問題が発生" />);
    expect(html).toContain('role="alert"');
  });

  it("forbids copy that blames the user or uses cuteness tokens", () => {
    const html = render(<ErrorState title="アップロードできませんでした" />);
    expect(html).not.toMatch(/Oops/);
    expect(html).not.toMatch(/Uh-oh/);
    expect(html).not.toMatch(/あなたのミス/);
  });
});
