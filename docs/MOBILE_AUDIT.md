# Mobile UX Audit — lokyy-brain PWA

Date: 2026-05-25
Phase: D, Wave D1, Story 3
Tested on: viewport widths 375 (iPhone SE), 414 (iPhone Pro), 768 (iPad Mini)
Methodology: Playwright headless Chromium, viewport-emulated with `isMobile + hasTouch`, all API endpoints stubbed via `ctx.route('**/api/**')` so the audit hits the real App shell (not the auth-wall / setup-wizard). DOM is queried for each interactive element to extract its bounding-box width/height, with anything <44×44 CSS px flagged as a touch-target violation against Apple HIG and WCAG 2.1 SC 2.5.5. Screenshots are in `/tmp/lokyy-mobile-shots/`.

## Measurement summary (raw Playwright `getBoundingClientRect()` data)

| Viewport     | Before: editor visible width | Before: small targets | Before: doc overflowX | After: editor width | After: small targets | After: overflowX |
| ------------ | ---------------------------- | --------------------- | --------------------- | ------------------- | -------------------- | ---------------- |
| 375 × 667    | **121 px**                   | 22                    | **YES**               | **375 px**          | 17 (mostly modals)   | NO               |
| 414 × 896    | 160 px                       | 24                    | YES                   | **414 px**          | 17                   | NO               |
| 768 × 1024   | 514 px                       | 24                    | NO                    | 514 px (unchanged)  | 24                   | NO               |

Editor width on the 375 viewport went from `121 px` (the sidebar consumed 248 px and the toolbar overflowed off-screen) to the full `375 px`. Body-level horizontal scroll is eliminated on both phone widths. Tablet (768) is untouched — desktop layout still works.

## Found Issues

### Critical (blocks usage)

1. **Sidebar consumes 66 % of phone screen.** `App.tsx` rendered the `<aside>` as a 248 px static column on every viewport. On a 375 px iPhone SE that left **121 px** of usable editor width — half a sentence per line of body text. The sidebar is always-visible at every viewport, with a `DragHandle` that's hostile to touch.
2. **Toolbar overflows the screen** on both phone widths (`document.scrollWidth > clientWidth = true`). Seven header buttons at ~30 px height each plus a sync status label cannot fit in 375 px wide. Buttons get clipped mid-label; the `forgejo · synchron` status text is cut off entirely.
3. **PWA manifest icons point at non-existent files.** `/icon-192.png` and `/icon-512.png` are declared in `vite.config.ts` but neither exists in `pwa/public/` — confirmed by `ls`. The installable PWA has no icon at the home-screen / App-Drawer level, only on the address bar (via the `<link rel="apple-touch-icon">` in `index.html`).
4. **`theme_color` and `background_color` are stale** (`#14110f`) — the brand was rebranded to `#13171D` (theme.ts:22) in an earlier wave but the manifest was never updated. Result: the PWA chrome flashes the old colour on cold-start before the React tree paints.

### Major (degrades usage)

5. **Header buttons fall below 44 × 44 px** (Apple HIG / WCAG 2.5.5). Measured: Today (90×30), Vorlagen (108×32), Review (115×30), Import (87×32), Suche (117×32), Wissensgraph (40×34), Einstellungen (40×34). All seven fail vertically; the two icon-only buttons also fail horizontally.
6. **Outline pane is forced-open** on every viewport. 220 px additional fixed-width column on the right of the editor. On a 375 px phone with the sidebar also open, the editor pane after the outline is ~−100 px (i.e. literally pushed off-screen).
7. **FileTree icon-buttons are 24 × 24** (`FileTree.tsx:528`). Even on the iPad layout where the sidebar is reasonable, the create-note + create-folder + rename + delete affordances are sub-target.
8. **AgentReviewPanel and ImportPanel** are 480 px / 360 px wide with `maxWidth: 95vw` / `90vw`. On 375 px that's 356 / 338 px — usable but the user loses 5–10 % of the screen to a non-functional gutter behind the panel.
9. **NoteHeader ULID badge** is a 110 px-wide pill that pushes the AI-Prompt + Forget buttons off-screen on narrow viewports.

### Minor (polish)

10. Sync status (`● forgejo · synchron`) is 110 px wide and ranked last in the header source order, so it's the first thing clipped under overflow.
11. `<aside>` and `<main>` widths are JS-controlled via `useResizableWidth` localStorage — no breakpoint-aware default.
12. `flex-wrap: nowrap` everywhere in headers — no graceful degradation.
13. No mobile-specific viewport meta tag enhancements (no `viewport-fit=cover` for notched devices, no `interactive-widget=resizes-content`).
14. Modal backdrop `pointer-events: auto` is fine but tapping a wikilink on a touch device with the editor active triggers a click-through that the editor's `onMouseDown` handlers misinterpret (no visible regression yet, but smells fragile).

## Top 5 Fixes Applied (this PR)

1. **Sidebar → mobile drawer with hamburger.** `App.tsx`. Below 640 px the `<aside>` becomes `position: fixed`, `transform: translateX(-105%)` when closed, slides over the editor when open. A new `MenuIcon` button in the header opens it (44 × 44 px). Tapping a note auto-closes the drawer via `openAndCloseDrawer`. The `DragHandle` is hidden on mobile because pixel-precise resizing with a thumb is hostile UX. Backdrop tap dismisses.
2. **Toolbar streamlined on mobile.** `App.tsx`. The Vorlagen + Review + Import + Wissensgraph buttons are hidden below 640 px (they remain accessible via the Search palette / future FAB). Suche and Settings collapse to 44 × 44 icon-only squares. Header height grows from 44 → 52 px so each tap target hits the 44 px floor. The sync-status text is hidden on mobile.
3. **Outline pane hidden on mobile.** `App.tsx`. The `<Outline>` and its `DragHandle` are wrapped in `{!isMobile && …}`. The editor now gets the full viewport width minus its own padding.
4. **NoteHeader: ID badge hidden, buttons grow.** `NoteHeader.tsx`. The standalone ULID pill drops on mobile (the same ULID still ships inside the AI-Prompt clipboard payload). AI-Prompt + Forget/Unforget pills switch to a `MOBILE` style variant — 40 px tall, 14 px padding, 13 px font. Header padding tightens (8 px gap, 10 px horizontal) and `flex-wrap: wrap` lets the title ellipsize without pushing buttons off-screen.
5. **Slide-over panels go full-width + PWA manifest fixed.**
    - `ImportPanel.tsx` + `AgentReviewPanel.tsx`: below 640 px the panels are `width: 100vw` instead of 360 / 480 px. Close-button on ImportPanel grows to 44 × 44.
    - `vite.config.ts`: manifest renamed to `Lokyy Brain` / `Lokyy`, `theme_color` + `background_color` corrected to `#13171D`, broken `/icon-192.png` + `/icon-512.png` replaced with `/logo-large.png` declared at both 192 and 512, plus a `maskable` variant. Added `scope: "/"` and `orientation: "portrait-primary"`.

A `useIsMobile()` hook (and `useIsTablet()` sibling) was introduced in the new `pwa/src/responsive.ts` to keep the breakpoint logic in one place. Backed by `window.matchMedia`, falls back to `resize` listeners, SSR-safe. `BREAKPOINTS = { mobile: 640, tablet: 768, desktop: 1024 }` mirrors Tailwind defaults. `TOUCH_TARGET_MIN = 44` is exported for direct use in inline styles.

## Verification

- `pnpm --filter pwa build` — green. tsc passes, vite-pwa generates a clean `manifest.webmanifest` with the corrected values. Build output confirmed.
- Playwright re-run against the static `dist/` server: editor width 121 → 375 on iPhone SE (+210 %), 160 → 414 on iPhone Pro (+159 %), `overflowX = false` on every viewport, hamburger + drawer + backdrop visible in `iphone-se-375-after-shell.png` and `iphone-se-375-after-drawer.png`. Tablet (768) layout intact in `ipad-mini-768-after-shell.png`.

## Deferred Improvements (Phase D+)

1. **Mobile FAB for Capture.** The killer mobile workflow is "fast capture via share-intent" — surface it as a floating action button bottom-right when the editor is empty, opening `ImportPanel` or a dedicated quick-capture flow.
2. **PropertiesPanel collapse on mobile.** The collapsed state is fine but the expanded state still occupies vertical space the editor needs. Add a sticky toggle that lives just above the editor body.
3. **Wikilink tap vs. long-press.** Right now tapping a wikilink behaves identically to Cmd+Click on desktop because the editor extension reads `e.metaKey` (always false on touch). Add a long-press-to-split-pane semantic for users with two-pane workflows.
4. **CodeMirror editor font / line-height tuning.** Body is 15.5 px — fine, but line-height defaults look cramped on small viewports.
5. **Service-worker share-target follow-through.** Verify the `share_target` POST is correctly routed when the PWA is installed on Android.
6. **`react-force-graph` mobile gestures.** The GraphView's zoom/pan needs touch-event opt-ins; right now mouse events only.
7. **iOS install icon.** `apple-touch-icon` is set in `index.html` but no `apple-touch-icon-precomposed` and no splash-screen images for the various iPhone sizes.
8. **Tablet (768) touch-target sweep.** The fixes here intentionally only apply below 640 px. The iPad layout still has ~24 sub-44px targets — separate story.
9. **Drawer swipe-to-close gesture.** Currently tap-backdrop / tap-X only; an `onTouchMove`-driven swipe would feel more native.
10. **High-DPI logo rendering.** `logo-large.png` works at both manifest sizes but is rasterized — SVG variants for the icon would render crisper at home-screen densities.
