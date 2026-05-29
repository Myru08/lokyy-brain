# Story: App ErrorBoundary + defensive settings save (kill black-screens)

**Epic:** Resilience / Mobile UX
**Origin:** Oliver — saving AI settings (after assigning the embedding role) → BLACK PAGE, only a reload recovers (the save itself succeeded). Root cause: there is NO top-level React error boundary, so any render-time throw blanks the whole app (same class as the earlier voice black-screen).

## Acceptance Criteria

1. NEW `pwa/src/ErrorBoundary.tsx` — a class component (`getDerivedStateFromError` + `componentDidCatch`) that, on a render error, shows a centered fallback (themed, theme.ts): a short "Etwas ist abgestürzt" message, the error text (collapsible/small), and a **"Neu laden"** button (`location.reload()`). `componentDidCatch` logs the error to console (so it lands in the server log buffer only if forwarded — console is fine for now).
2. Wrap the app root in `pwa/src/main.tsx` with `<ErrorBoundary>` so NO uncaught render error can ever produce a blank black screen again — the fallback shows instead.
3. Harden `pwa/src/AiProviderSettings.tsx` `save()` (~line 392): make the post-save path defensive — only `setRouting(updated.routing)` if `updated?.routing` is present; wrap the whole save in try/catch that sets `saveState="fail"` + `saveError` inline (it largely does — ensure NO post-save state update can throw on a malformed/partial response). The save must surface failure inline, never blank the page.

## Constraints

- Own ONLY: NEW `pwa/src/ErrorBoundary.tsx`, `pwa/src/main.tsx`, `pwa/src/AiProviderSettings.tsx`. Do NOT touch App.tsx, Settings.tsx, api.ts, server, core (other agents own those in parallel now).
- pnpm workspace; no npm/bun. Match theme.ts.

## Verification (paste exact output)

- `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; symlink main checkout node_modules if needed, then remove).
- `pnpm --filter pwa test` → existing tests green.

## Definition of Done

A top-level ErrorBoundary renders a recoverable fallback (with reload) instead of a black screen on any render crash; the AI-settings save can't blank the page; typecheck + tests green.
