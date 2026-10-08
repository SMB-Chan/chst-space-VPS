import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState } from "./empty-state";

const render = (...args: Parameters<typeof renderToStaticMarkup>) =>
  renderToStaticMarkup(...args);

describe("EmptyState", () => {
  it("renders title and description as accessible heading + paragraph", () => {
    const html = render(
      <EmptyState
        title="プロジェクトがまだありません"
        description="名前を付けるだけでワークスペースのフォルダが作成されます。"
      />,
    );
    // Apple HIG §5.2: "What to do next". Empty state names the next step.
    expect(html).toContain("プロジェクトがまだありません");
    expect(html).toContain("ワークスペースのフォルダが作成されます");
    expect(html).toContain("<h2");
    expect(html).toContain("<p");
  });

  it("has role=status so VoiceOver announces empty surfaces", () => {
    const html = render(<EmptyState title="空です" />);
    expect(html).toContain('role="status"');
  });

  it("renders the primary action with verb-first label", () => {
    const html = render(
      <EmptyState
        title="空です"
        primaryAction={<button type="button">最初のプロジェクトを作成</button>}
      />,
    );
    expect(html).toContain("最初のプロジェクトを作成");
  });

  it("decorates the icon as aria-hidden so it is not read aloud", () => {
    const html = render(
      <EmptyState title="空です" icon={<svg data-testid="icon" />} />,
    );
    expect(html).toMatch(/aria-hidden="true"/);
  });

  it("renders secondary action alongside primary when both provided", () => {
    const html = render(
      <EmptyState
        title="空です"
        primaryAction={<button>再試行</button>}
        secondaryAction={<a href="/help">ヘルプを見る</a>}
      />,
    );
    expect(html).toContain("再試行");
    expect(html).toContain("ヘルプを見る");
  });
});
