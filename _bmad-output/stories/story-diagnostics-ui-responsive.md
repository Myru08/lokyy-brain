# Story: Settings — Diagnose tab + Logs tab + mobile-responsive redesign

**Epic:** Observability / in-app diagnostics + Mobile UX
**Origin:** Oliver — wants a per-service test suite + a log view inside Settings (no Coolify), AND "die Settings mobil sehen scheiße aus … nicht responsive und gut durchdacht."
**Depends on:** the backend shipped in commit 88149ee — `api.getDiagnostics()` and `api.getLogs(opts?)` already exist in pwa/src/api.ts (read their types).

## Acceptance Criteria

### A. Diagnose tab
1. New tab "Diagnose" in the Settings tab bar. On open (and via a prominent "Tests ausführen" button) it calls `api.getDiagnostics()` and renders the checks **grouped by service** (forgejo, postgres, ollama, embeddings, search, sleep-agent, mcp, git).
2. Each check row: name, ✓ green / ✗ red / ⚠ amber (by `severity`/`ok`), the `detail` text, and `latencyMs` if present. Group header shows an aggregate (e.g. "3/3 ok"). A spinner while running; show `ranAt`.
3. The **search** group must clearly surface the Tier1/Tier2/Combined hit counts + degraded flag — this is how we diagnose the live empty-search.

### B. Logs tab
4. New tab "Logs". Calls `api.getLogs({ limit })`, renders newest-first rows: timestamp, level badge (info/warn/error), optional service tag, message (monospace, wraps). A level filter (all/info/warn/error) and a service filter, plus a Refresh button. Reasonable default limit (e.g. 100/200).

### C. Mobile-responsive redesign (the whole Settings page)
5. Using the existing `useIsMobile`/breakpoints from `responsive.ts`, make ALL of Settings usable on a ~390px viewport: the tab bar scrolls horizontally or wraps cleanly (no clipped/overflowing tabs); content area is full-width with sane padding; NO fixed pixel widths that overflow; rows/labels/inputs stack vertically on mobile instead of side-by-side where they currently overflow; touch targets ≥40px; long values wrap/break (no horizontal scroll of the page). Audit every tab (System, Vault, AI, MCP, Skills, Voice, Wartung, + new Diagnose/Logs) for mobile overflow and fix.
6. Desktop layout must remain effectively unchanged (mobile styles gated on `isMobile`).

## Constraints

- Own ONLY: `pwa/src/Settings.tsx`. If a shared toggle/row helper is genuinely needed you MAY add a small new component file under pwa/src, but prefer inline. Do NOT touch api.ts (methods already exist), App.tsx, server, or other files.
- Reuse the existing patterns in Settings.tsx (tab state, the `ServiceStatusRow`/`CommandLine` components from the System tab, the voice-settings save pattern). Match theme.ts.
- pnpm workspace; no npm/bun.

## Verification (paste exact output)

- `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; symlink main checkout node_modules if needed, then remove).
- `pnpm --filter pwa test` → existing tests green.
- Do NOT run `pnpm -r build` (Orchestrator runs authoritative build + visual check).

## Definition of Done

Settings has a Diagnose tab (per-service pass/fail incl. the search probe) and a Logs tab (filterable ring-buffer view), and the entire Settings page is responsive on mobile with no overflow; desktop unchanged; typecheck + tests green.
