# Story 10.8: `get_health()` MCP-Tool

Status: ready-for-dev

> Welle 2. Core = **Agent B** (NEU `packages/core/src/health/` + Barrel-Re-Export in
> `packages/core/src/index.ts`); MCP-Tool = **Agent C** (`mcp/src/server.ts`). Konsumiert die in
> Story 10.1 gebaute Quarantäne-API.

## Story

Als Agent/Admin möchte ich `get_health()`, das mir Sync-Zustand, Index-Stand, Pool-Auslastung,
Vault-ID und quarantänisierte Notes liefert, damit ich (oder ein Monitoring) den Backend-Zustand
selbst diagnostizieren kann — statt erst bei Total-Ausfall zu merken, dass etwas klemmt.

## Acceptance Criteria

1. **Barrel-Re-Export (Agent B):** `getQuarantinedNotes`, `clearQuarantine`, `getBreakerStateSize`
   und `QuarantinedNote` (aus Story 10.1, derzeit nur in `memory/index.ts`) werden aus dem
   `@lokyy/core`-Barrel (`packages/core/src/index.ts`) re-exportiert. (Forge hatte das bewusst dem
   parallelen Agenten überlassen.)
2. **Core-Health-Modul (Agent B):** `getHealth()` →
   `{ sync_state, last_successful_index_at, pending_writes, db_pool_used, db_pool_max, vault_id,
   quarantined: QuarantinedNote[], breaker_entries }`. Werte, die nicht zuverlässig ermittelbar
   sind, klar als `null`/`unknown` ausweisen (nicht raten). Quarantäne aus `getQuarantinedNotes()`.
3. **MCP (Agent C):** `get_health()`-Tool gibt das Objekt zurück; `vault_id` aus dem aktiven
   Server-Kontext. Reichhaltige Description (Self-Diagnose für Agents).
4. **Multi-Vault-Sichtbarkeit:** wenn der MCP-Boot mehrere Vault-Rows erkannt hat (Story 10.13),
   soll `get_health()` das als Problem-Flag zeigen — falls 10.13 in dieser Welle nicht läuft,
   zumindest ein Feld `vault_warning?: string` vorsehen (additiv, kein Hard-Dependency).
5. **Tests:** `getHealth()` liefert die Felder; quarantänisierte Note taucht auf (mit Story-10.1-
   Quarantäne simuliert); Barrel-Export auflösbar. `pnpm -r build` grün; `@lokyy/mcp`-Tests grün.
6. **Anti:** `get_health()` darf selbst keine schweren DB-Queries fahren, die unter Last hängen
   (sonst diagnostiziert es sich tot) — Pool-Stats möglichst ohne Roundtrip; bei DB-Bedarf den
   isolierten/kurzen Pfad nutzen.

## Dev Notes

- Quarantäne-API aus Story 10.1: `getQuarantinedNotes()`, `clearQuarantine()`,
  `getBreakerStateSize()`, Typ `QuarantinedNote` — in `packages/core/src/memory/index.ts`.
- Pool: `packages/core/src/db/index.ts` (`database()` Haupt-Pool `max:10`, `indexDatabase()`
  isolierter Pool aus Story 10.1) — Auslastung/Max von dort.
- `vault_id`/Multi-Vault: `mcp/src/resolveVaultId.ts` (Story 10.13 behandelt die Erkennung).

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 8.6 (Health-Endpoint); Story 10.1 (Quarantäne-API)]

## Dev Agent Record
### Agent Model Used
Claude Opus 4.7 (Engineer agent — CORE part only; MCP tool wiring + vault_id-from-context is Agent C's job).

### Completion Notes List
- **Core-health module (AC#2) DONE.** NEW `packages/core/src/health/index.ts` exports
  `getHealth(opts?)` →
  `{ sync_state, last_successful_index_at, pending_writes, db_pool_used, db_pool_max,
  vault_id, quarantined, breaker_entries, vault_warning }` (types `HealthSnapshot`,
  `HealthContext`, `SyncState` exported).
- **Quarantine source (AC#2):** imports `getQuarantinedNotes()` / `getBreakerStateSize()` /
  `QuarantinedNote` from the DEEP path `../memory/index.js` (Story 10.1 API), NOT the barrel —
  per instructions, the barrel re-export (AC#1) is left for the parallel MCP-wiring agent.
- **No guessing (AC#2):** values core cannot read cheaply are `null`/`"unknown"` by default and
  only filled when the caller (server/MCP context) supplies them via `HealthContext`
  (`vaultId`, `syncState`, `lastSuccessfulIndexAt`, `pendingWrites`, `dbPoolUsed`).
- **AC#6 (no heavy DB queries):** `getHealth()` is synchronous and only reads in-process
  breaker state. `db_pool_max` is the compile-time constant `10` (mirrors `initDb`'s
  `postgres(url,{max:10})` — documented + flagged to keep in sync); `db_pool_used` is `null`
  because postgres.js exposes no cheap in-use counter and a roundtrip is forbidden.
- **AC#4 (multi-vault):** additive `vault_warning?: string | null` field, set only when the
  caller passes `opts.vaultWarning` (no hard dependency on Story 10.13).
- AC#1 barrel re-export and AC#3 MCP tool (vault_id from server context, rich description) are
  Agent C's scope.
- Tests: all documented fields present with defaults; caller-context override; a simulated
  Story-10.1 quarantined note (3 failing upserts past the breaker backoff, via the same
  `Tier1BM25.upsert` stub + `Date.now` advance technique as `circuitBreaker.test.ts`) shows up
  in `quarantined` with `breaker_entries === 1`.

### File List
- NEW `packages/core/src/health/index.ts`
- NEW `packages/core/src/health/health.test.ts`
- `packages/core/src/index.ts` (MCP-wiring agent: barrel re-export of `getHealth`/`HealthSnapshot`/
  `HealthContext`/`SyncState` AND the Story-10.1 quarantine API `getQuarantinedNotes`/
  `clearQuarantine`/`getBreakerStateSize`/`QuarantinedNote`)
- `mcp/src/server.ts` (MCP-wiring agent: `get_health` ListTools entry + CallTool case)
- `mcp/src/server.test.ts` (MCP-wiring agent: payload + e2e tests)

### Completion Notes List (MCP part — Agent C)
- **AC#1 DONE — barrel re-export.** Added `getQuarantinedNotes`, `clearQuarantine`,
  `getBreakerStateSize`, `QuarantinedNote` (Story 10.1) to the memory export block, and a new
  health export block (`getHealth`, `HealthSnapshot`, `HealthContext`, `SyncState`). Also wired the
  10.4/10.5 symbols (`getVaultConventions`, `getSkillSchema`) per the cross-story note.
- **AC#3 DONE — MCP tool.** `get_health()` tool returns `getHealth({ vaultId })` — `vault_id` flows
  from the server's `vaultId` context arg. Pool/sync/index values stay `null`/`"unknown"` (core
  guesses nothing; the MCP boot has no cheap pool/sync counter to pass). Rich self-diagnosis
  description.
- **AC#6 respected** — the tool only calls the synchronous `getHealth()` (in-process breaker state +
  compile-time pool max); no heavy DB query is issued from the MCP layer.
- Tests: `getHealth({vaultId})` returns all documented fields (via the barrel, proving AC#5 resolve)
  AND the e2e `get_health` tool returns the snapshot carrying the server's `vault_id` ("vault-test").

### Change Log
- New health module + tests; build green; health tests green.
- MCP-wiring agent: barrel re-exports (quarantine API + health + conventions + skill-schema) added;
  `get_health` tool wired with `vault_id` from server context. `pnpm -r build` exit 0; mcp tests 23
  passed; core tests 195 passed / 3 skipped (barrel change broke nothing).
- 2026-05-29 — Wave 3 (Agent M): AC#4 `vault_warning` now WIRED. `buildServer` calls
  `resolveVaultResolution(databaseUrl)` (Story 10.13 API) ONCE at boot, off the per-request path so
  `get_health` stays cheap (AC#6). When `ambiguous===true` a `vault_warning` string listing the
  competing vault id/slug candidates + the `LOKYY_VAULT_ID` pin hint is passed into
  `getHealth({vaultId,vaultWarning})`. The detection call is guarded — if it throws (DB down at
  boot) the warning degrades to `null` and the server still boots/serves. e2e test asserts the
  warning surfaces both candidates + `LOKYY_VAULT_ID` under an ambiguous resolution.
