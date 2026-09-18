import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageFeed } from "./message-feed";

const render = (...args: Parameters<typeof renderToStaticMarkup>) =>
  renderToStaticMarkup(...args);

// Stub user from @clerk/react; MessageFeed uses useUser().
import { vi } from "vitest";
vi.mock("@clerk/react", () => ({
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: { id: "u_test", firstName: "T", imageUrl: null },
  }),
}));

describe("MessageFeed empty state (Apple HIG §5.2)", () => {
  it("renders EmptyState with verb-first guidance when messages is empty", () => {
    const html = render(
      <MessageFeed
        messages={[]}
        isLoading={false}
      />,
    );
    expect(html).toContain("まだメッセージがありません");
    expect(html).toContain("質問、ファイル、画像の解釈");
    expect(html).toContain("下の入力欄から始めてください");
  });

  it("renders a meaningful icon for the empty surface", () => {
    const html = render(
      <MessageFeed messages={[]} isLoading={false} />,
    );
    // lucide-react renders MessageSquare as an SVG; ensure the icon is
    // mounted and marked aria-hidden so screen readers skip it.
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("renders the spinner when loading instead of the empty state", () => {
    const html = render(
      <MessageFeed messages={[]} isLoading={true} />,
    );
    expect(html).not.toContain("まだメッセージがありません");
    // The Loader2 svg is rendered with `animate-spin`.
    expect(html).toMatch(/animate-spin/);
  });
});
