import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

/**
 * Apple HIG §4.4 — "Use at least a 44×44 pt tap target for touch controls."
 *
 * This regression test pins the heights exposed by the Button variants so a
 * future tweak (e.g. someone shortening `default` to `h-10`) immediately
 * breaks CI rather than silently regressing touch ergonomics.
 */
const HEIGHT_PX: Record<string, number> = {
  "h-7": 28,
  "h-8": 32,
  "h-9": 36,
  "h-10": 40,
  "h-11": 44,
  "h-12": 48,
};

function minimumHeightPxFromClassName(className: string): number {
  const matches = Object.keys(HEIGHT_PX).filter((token) =>
    new RegExp(`(^|\\s)${token}(\\s|$)`).test(className),
  );
  if (matches.length === 0) return Number.POSITIVE_INFINITY;
  return Math.max(...matches.map((token) => HEIGHT_PX[token]));
}

const MIN_TARGET_PX = 44;

describe("Button tap targets (Apple HIG §4.4)", () => {
  it("default size is h-11 (44px)", () => {
    const classes = buttonVariants();
    expect(classes).toContain("h-11");
  });

  it("icon size is at least 44×44 px", () => {
    const classes = buttonVariants({ size: "icon" });
    expect(classes).toContain("h-11");
    expect(classes).toContain("w-11");
  });

  it("sm size is permitted to be smaller (uses inline secondary actions inside dense layouts)", () => {
    const classes = buttonVariants({ size: "sm" });
    // Apple HIG allows smaller secondary controls when paired with a
    // primary 44pt control nearby; sm is 32px (h-8).
    expect(classes).toContain("h-8");
  });

  it("no Button default or icon variant shrinks below 44px", () => {
    const defaultClasses = buttonVariants();
    expect(minimumHeightPxFromClassName(defaultClasses)).toBeGreaterThanOrEqual(
      MIN_TARGET_PX,
    );
    const iconClasses = buttonVariants({ size: "icon" });
    expect(minimumHeightPxFromClassName(iconClasses)).toBeGreaterThanOrEqual(
      MIN_TARGET_PX,
    );
  });
});
