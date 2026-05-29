# Story: System Detection + Install Guidance UI (backlog item #12)

**Epic:** Hardening / lokyy-ideen backlog
**Origin:** 90_ideas/lokyy-ideen item 12 — "prüfung ob ein system angebunden bzw. installiert ist ... lokal oder über coolify nachinstallieren."
**Scope decision (confirmed by Oliver):** DETECT + GUIDANCE only. Show per-service status and the exact next step (local command and/or docker-compose hint), with a copy button. NO automatic execution / no Coolify API calls (Oliver: "nur docker-compose änderbar, nicht Coolify").

## Context

Settings.tsx has a System tab that pings `/api/settings/status` and shows ✓/✗ for Forgejo / Postgres / Ollama. What's missing: detecting whether the **embeddings model** is actually present, and giving the user an actionable remediation step per failing service.

## Acceptance Criteria

1. **Server** (settings status route only): extend the status endpoint so each service entry returns `{ ok: boolean, error?: string }` PLUS a stable `service` key, and add an **embeddings-model** check (e.g. query Ollama `/api/tags` for `nomic-embed-text`; ok=false if Ollama up but model missing). Keep the existing service checks working.
2. **PWA Settings.tsx (System tab) only**: for each service render a row: name, ✓ green / ✗ red, error text if any, and when `!ok` an actionable **next-step** line:
   - Ollama not reachable → `ollama serve` (local) or `docker compose up -d ollama` (server)
   - Embeddings model missing → `ollama pull nomic-embed-text` with a **Copy** button
   - Forgejo / Postgres not reachable → docker-compose service hint (`docker compose up -d <service>`) + a one-line note to check the connection settings
3. Each command line has a copy-to-clipboard button. NOTHING is executed by the app.
4. Layout: the System tab must not overflow; rows align; works at the existing Settings panel width. (Verify visually — do not just assume.)

## Constraints

- Own ONLY: `pwa/src/Settings.tsx` and the server settings status route file (e.g. `server/src/routes/settings.ts`). Do NOT touch api.ts, App.tsx, NoteHeader.tsx, gitService, package.json, or test files (other agents own those). If you need the status data and there's an existing fetch in Settings.tsx, reuse/extend it inline there — do NOT edit pwa/src/api.ts.
- pnpm workspace; update `.env.example` only if you add new env.

## Verification (report exact output)

- `pnpm --filter server tsc --noEmit` → 0
- `pnpm --filter pwa tsc --noEmit` → 0
- Do NOT run `pnpm -r build` (Orchestrator runs the authoritative full build + Interceptor screenshot). Paste both typecheck results.

## Definition of Done

Both typechecks green; System tab shows per-service status + actionable next step + copy buttons; no auto-execution. Report files changed + which service checks you wired.
