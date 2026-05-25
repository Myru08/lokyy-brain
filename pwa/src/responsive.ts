import { useEffect, useState } from "react";

/**
 * Responsive breakpoints + hook for the lokyy-brain PWA.
 *
 * Why a JS hook and not pure CSS media queries: the App.tsx shell carries
 * a lot of conditional layout (sidebar drawer vs. always-visible, side-pane
 * outline render-or-skip, modal width). React-state-driven layout is far
 * simpler than 1) duplicating that logic across CSS media queries and 2)
 * cross-syncing JS-measured widths (`useResizableWidth`) with breakpoints.
 *
 * The hook stays cheap: a single window-level resize listener that compares
 * against the threshold and only re-renders when the boolean flips.
 *
 * SSR-safe: `window` is guarded so the hook can run inside non-browser test
 * environments (Vitest jsdom is fine; happy-path Node SSR returns `false`).
 *
 * The breakpoint tokens mirror Tailwind's defaults — familiar territory and
 * intentional: 640px = "mobile boundary" (most phones in portrait sit at or
 * below this), 768px = "tablet" (iPad mini portrait), 1024px = "desktop".
 */

export const BREAKPOINTS = {
  /** Phones in portrait. Below this, the sidebar becomes a drawer. */
  mobile: 640,
  /** iPad Mini portrait / large phone landscape. */
  tablet: 768,
  /** Comfortable desktop layout (sidebar + editor + outline). */
  desktop: 1024,
} as const;

export type BreakpointKey = keyof typeof BREAKPOINTS;

function readMatch(maxWidth: number): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < maxWidth;
}

/**
 * Subscribe to a `max-width` media-query-style threshold. Returns `true`
 * when the viewport is *narrower* than `maxWidth`.
 *
 * Implementation note: we use `window.matchMedia` when available so the
 * listener fires only on threshold crossings (cheaper than a raw `resize`
 * listener that fires on every pixel). Older browsers fall back to a raw
 * `resize` listener.
 */
function useMaxWidth(maxWidth: number): boolean {
  const [matches, setMatches] = useState<boolean>(() => readMatch(maxWidth));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = `(max-width: ${maxWidth - 1}px)`;
    if (typeof window.matchMedia === "function") {
      const mql = window.matchMedia(query);
      const handler = (e: MediaQueryListEvent | MediaQueryList) => {
        setMatches(e.matches);
      };
      // Some browsers still expose `addListener` only.
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", handler as (e: MediaQueryListEvent) => void);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        mql.addListener(handler as (e: MediaQueryListEvent) => void);
      }
      // Sync once on mount in case state drifted between init + effect.
      setMatches(mql.matches);
      return () => {
        if (typeof mql.removeEventListener === "function") {
          mql.removeEventListener(
            "change",
            handler as (e: MediaQueryListEvent) => void,
          );
        } else {
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          mql.removeListener(handler as (e: MediaQueryListEvent) => void);
        }
      };
    }
    const onResize = () => setMatches(readMatch(maxWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [maxWidth]);

  return matches;
}

/** True when viewport < 640px (phone portrait). */
export function useIsMobile(): boolean {
  return useMaxWidth(BREAKPOINTS.mobile);
}

/** True when viewport < 768px (covers phones + small tablets). */
export function useIsTablet(): boolean {
  return useMaxWidth(BREAKPOINTS.tablet);
}

/**
 * Recommended minimum tap target size per Apple HIG (44pt) and the
 * WCAG 2.1 Target Size (Enhanced) success criterion (44×44 CSS px).
 * Used as the lower bound when sizing buttons + icon-buttons in mobile
 * layouts.
 */
export const TOUCH_TARGET_MIN = 44;
