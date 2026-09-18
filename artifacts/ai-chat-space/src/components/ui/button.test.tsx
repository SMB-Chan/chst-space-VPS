import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, buttonVariants } from "./button";

const render = (...args: Parameters<typeof renderToStaticMarkup>) =>
  renderToStaticMarkup(...args);

describe("Button", () => {
  it("default size uses Apple-HIG 44pt tap target (h-11 = 44px)", () => {
    const html = render(<Button>送信</Button>);
    expect(html).toMatch(/\bh-11\b/);
  });

  it("icon variant keeps the 44×44 square tap target", () => {
    const html = render(
      <Button size="icon" aria-label="添付">
        +
      </Button>,
    );
    expect(html).toMatch(/\bh-11\b/);
    expect(html).toMatch(/\bw-11\b/);
  });

  it("verb-first labels are preserved", () => {
    const html = render(<Button>もう一度試す</Button>);
    expect(html).toContain("もう一度試す");
  });

  it("buttonVariants output includes the focus-ring class for keyboard users", () => {
    const classes = buttonVariants();
    expect(classes).toContain("m3-focus-ring");
  });
});
