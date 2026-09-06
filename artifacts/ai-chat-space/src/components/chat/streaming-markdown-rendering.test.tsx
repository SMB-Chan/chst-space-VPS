import { act } from "react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reactMarkdownRender } = vi.hoisted(() => ({
  reactMarkdownRender: vi.fn(),
}));

vi.mock("react-markdown", () => ({
  default: (props: { children: React.ReactNode }) => {
    reactMarkdownRender();
    return React.createElement("div", null, props.children);
  },
}));

import { createRoot, type Root } from "react-dom/client";
import { StreamingMarkdown } from "./markdown";

describe("incremental Markdown rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    reactMarkdownRender.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("does not re-render a frozen block during append-only tail updates", () => {
    act(() => {
      root.render(
        <StreamingMarkdown
          content={"# Frozen heading\n\nMutable tail"}
          citationScope="incremental-render-test"
        />,
      );
    });
    expect(reactMarkdownRender).toHaveBeenCalledTimes(2);

    act(() => {
      root.render(
        <StreamingMarkdown
          content={"# Frozen heading\n\nMutable tail with more text"}
          citationScope="incremental-render-test"
        />,
      );
    });

    expect(reactMarkdownRender).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("Frozen heading");
    expect(container.textContent).toContain("Mutable tail with more text");
  });
});
