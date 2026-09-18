import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/**
 * Apple HIG §4.4 Flexibility — viewport-aware UX. Returns `true` on
 * phones, `false` on tablets/desktop, and `undefined` until the first
 * measurement (so callers can render a neutral placeholder during SSR or
 * before the media query has reported).
 *
 * The hook is intentionally defensive: `window.matchMedia` does not exist
 * in jsdom or during server-side rendering, so we lazy-access it and
 * fall back to a sensible default (desktop) when unavailable. This keeps
 * Vitest + jsdom-based suites green without forcing them to mock media
 * queries globally.
 */
export function useIsMobile(): boolean | undefined {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(
    undefined,
  );

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      // SSR or test environment — assume desktop so the desktop layout is
      // the canonical render and tests don't crash.
      setIsMobile(false);
      return;
    }
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
