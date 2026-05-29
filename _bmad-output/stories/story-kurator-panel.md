# Story: Kurator panel — sleep-agent status, run history, manual trigger, found connections

**Epic:** Observability / Consolidation Agent ("Kurator")
**Origin:** Oliver — wants to see whether the background consolidation agent runs / last ran, run it on demand, AND see the connections ("Bezüge") it found.

## Background (read these)

- Routes: `POST /api/sleep-agent/trigger { phase? }`, `GET /api/sleep-agent/runs?limit=N`, `GET /api/sleep-agent/runs/:id` (server/src/routes/sleep-agent.ts). `SleepRun` = { id, phase, status, notesProcessed, error?, started/finished timestamps, passes[] } (packages/core/src/sleep-agent/types.ts).
- The connection-finding pass is **topic-synthesis**, which runs in the **`rem`** phase (packages/core/src/sleep-agent/passes/topicSynthesis.ts) and writes auto topic-notes to `70_pai/topics/auto-{slug}.md` (`type: intervention, origin: agent`). The existing NREM trigger does ulid-backfill, NOT topic synthesis.
- Those auto topic-notes ARE the "Bezüge". They surface via `GET /api/agent-review/queue` and the existing `pwa/src/AgentReviewPanel.tsx` (accept/reject UI already exists).

## Acceptance Criteria

1. New **"Kurator"** tab in Settings.tsx (add to TabKey + TABS). On open it loads `api.getSleepRuns({limit: ~20})`.
2. **Status** header: scheduler armed/idle + the last run (time, phase, status, notesProcessed) — derive from the most recent run (and/or reuse the diagnostics sleep-agent data). Plain-language ("Läuft scharf · zuletzt 29.05. 14:41 · 91 Notizen verarbeitet").
3. **Run history** list: each run = timestamp, phase, status badge, duration, notesProcessed. Newest first.
4. **"Jetzt laufen lassen"** button that triggers a run which ACTUALLY produces connections — i.e. the **rem** phase (topic-synthesis), not just nrem. Provide a clear label; if a "full" run (nrem+rem) is easy via the trigger API, prefer that and label it "Vollständiger Lauf (inkl. Bezüge)". Show running spinner; on completion refresh the run list + the connections count. Handle the 409 "already running" gracefully (inline notice).
5. **Gefundene Bezüge:** fetch the agent-review queue (reuse the api method AgentReviewPanel uses; if none, add `getAgentReviewQueue()` hitting `/api/agent-review/queue`). Show the COUNT of auto topic-notes (the connections the Kurator created) + a button "Bezüge ansehen" that opens the existing AgentReviewPanel (reuse it — do NOT rebuild the review UI). If wiring the existing panel open-state into Settings is heavy, at minimum show the count + a link/route to where the panel lives.
6. Mobile-responsive (use isMobile patterns already in Settings); desktop unchanged elsewhere.

## Constraints

- Own: `pwa/src/Settings.tsx`, `pwa/src/api.ts`. You MAY read/import `pwa/src/AgentReviewPanel.tsx` to reuse it (don't rewrite it; if you must add a prop to open it, that's allowed — but prefer reusing as-is). Do NOT touch server, core, App.tsx, main.tsx, VoiceReviewSheet.
- Reuse existing api patterns. pnpm workspace; no npm/bun. Match theme.ts.

## Verification (paste exact output)

- `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; symlink node_modules if needed, then remove).
- `pnpm --filter pwa test` → existing tests green.

## Definition of Done

A Kurator tab shows scheduler status + run history, a "Jetzt laufen lassen" that triggers the connection-producing (rem/full) run, and a count + access to the found connections (auto topic-notes via the existing review queue/panel). Typecheck + tests green; mobile-friendly.
