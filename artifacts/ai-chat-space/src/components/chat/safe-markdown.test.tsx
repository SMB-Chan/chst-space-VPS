import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeMarkdown } from "./safe-markdown";

describe("SafeMarkdown streaming renderer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("coalesces append-only stream updates into one render window", () => {
    act(() => {
      root.render(
        <SafeMarkdown content="A" citationScope="message-stream-test" />,
      );
    });
    expect(container.textContent).toContain("A");

    act(() => {
      root.render(
        <SafeMarkdown content="AB" citationScope="message-stream-test" />,
      );
      root.render(
        <SafeMarkdown content="ABC" citationScope="message-stream-test" />,
      );
    });

    expect(container.textContent).not.toContain("ABC");

    act(() => {
      vi.advanceTimersByTime(40);
    });

    expect(container.textContent).toContain("ABC");
  });

  it("applies non-append replacements immediately", () => {
    act(() => {
      root.render(
        <SafeMarkdown
          content="original text"
          citationScope="message-replace-test"
        />,
      );
    });

    act(() => {
      root.render(
        <SafeMarkdown
          content="replacement"
          citationScope="message-replace-test"
        />,
      );
    });

    expect(container.textContent).toContain("replacement");
    expect(container.textContent).not.toContain("original text");
  });
});
