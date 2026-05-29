# Story: Diagnostics + Logs backend (per-service self-tests, no Coolify)

**Epic:** Observability / in-app diagnostics
**Origin:** Oliver — "wir brauchen in den Einstellungen eine umfangreiche Test-Suite die all das testet, getrennt nach Dienst, und einen Log der uns alles wiedergibt was wichtig ist — ohne in Coolify/auf den Server zu müssen." Also surfaces the live search bug (search returns empty → can't tell why remotely).

## Acceptance Criteria

1. **`GET /api/diagnostics`** runs a suite of per-service checks and returns a structured result:
   `{ checks: [{ service, name, ok: boolean, detail?: string, latencyMs?: number, severity?: "info"|"warn"|"error" }], ranAt }`.
   Group by `service`. REUSE existing checks where they exist (admin status for Forgejo/Postgres/Ollama, voice nomic-embed check, sleep-agent runs, MCP health, LLM provider test). ADD:
   - **Postgres**: connection ok + `pgvector` extension present + `pg_search`/BM25 availability (whatever Tier-1 BM25 depends on) present.
   - **Embeddings**: round-trip — embed a short test string via the configured Ollama model; ok = vector of expected dim (768) returned.
   - **Search Tier 1**: run a fixed probe query through the MemoryProvider Tier-1 path; report hit count (this is the one that exposes the live search bug — surface the actual count + any error).
   - **Search Tier 2 (semantic)**: same probe through Tier-2; report hit count + whether it degraded (`no_embedding`).
   - **Sleep-agent**: scheduler armed? last run timestamp + status (from the runs store).
   - **Git/vault**: gitService lock healthy + last commit reachable (cheap, no write).
   Each check must be defensive: a failing service yields `ok:false` + `detail` (the error), NEVER throws/500s the whole endpoint.
2. **`GET /api/logs?limit=N&level=&service=`** returns recent important events from an in-process **ring buffer** (bounded, e.g. last 500): `{ logs: [{ ts, level, service?, message }] }`. Capture into the buffer: server errors/warnings (patch console.warn/error to also push), git-save failures, Tier-2 sync failures, sleep-agent run summaries, search errors. Newest-first. No Coolify/SSH needed to read it.
3. **api.ts client**: `getDiagnostics()` and `getLogs(opts?)` typed methods + the result types.
4. Both endpoints mounted in `server/src/index.ts` under the existing auth/setup gate, consistent with other routes.
5. No regressions; provider-agnostic; do not block startup.

## Constraints

- Own: NEW `server/src/routes/diagnostics.ts`, NEW `server/src/routes/logs.ts` (or one `observability.ts`), NEW `server/src/lib/logBuffer.ts` (ring buffer), `server/src/index.ts` (mount + install the console capture early), `pwa/src/api.ts` (client methods + types). Do NOT touch Settings.tsx (the UI is a separate phase), App.tsx, VoiceReviewSheet, or core unless strictly needed (prefer reading existing core health helpers).
- Reuse existing health/status/sleep-agent/llm-test logic — do not duplicate service clients.
- pnpm workspace; no npm/bun.

## Verification (paste exact output)

- `pnpm --filter server exec tsc --noEmit` → 0 and `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; symlink main checkout node_modules if needed, then remove).
- Do NOT run `pnpm -r build` (Orchestrator runs authoritative build).

## Definition of Done

`GET /api/diagnostics` returns grouped per-service pass/fail incl. a Search Tier1/Tier2 probe with real hit counts; `GET /api/logs` returns a recent-events ring buffer; api.ts exposes both; mounted + typechecks green. (UI consumes these in the next phase.)
