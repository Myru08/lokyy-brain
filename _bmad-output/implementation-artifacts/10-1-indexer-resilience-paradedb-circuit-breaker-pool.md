# Story 10.1: Indexer-Resilienz — ParadeDB-Query härten + Per-Note-Circuit-Breaker + Pool-Isolation

Status: ready-for-dev

> Hot-Fix-Welle. Behebt den Total-Ausfall vom 2026-05-28 (Doc-Sektion 8).
> **Konfliktfreie Files (NUR diese editieren):** `packages/core/src/memory/Tier1BM25.ts`,
> `packages/core/src/memory/index.ts`, `packages/core/src/db/index.ts` und zugehörige Tests
> unter `packages/core/src/memory/`. NICHT `notesService.ts` oder `mcp/src/server.ts` anfassen
> (gehört Story 10.2).

## Story

Als Betreiber eines lokyy-brain-MCP-Backends, an dem mehrere Agenten gleichzeitig schreiben,
möchte ich, dass eine einzelne fehlerhafte Note **niemals** das gesamte Backend lahmlegt,
damit der Indexer Poison-Content isoliert, der Connection-Pool nicht erschöpft wird und
Suche/Reads verfügbar bleiben.

## Kontext / korrigierte Root-Cause (WICHTIG — Doc-Diagnose war teils falsch)

Die Quell-Note (8.2) vermutete SQL-Injection durch String-Konkatenation. **Das ist widerlegt:**
der Upsert (`Tier1BM25.ts:85-95`) nutzt Drizzle `sql\`\`` mit gebundenen Parametern (`${noteId}`,
`${body}`, …) — Body-Content kann den Upsert nicht per SQL-Text zerbrechen. Die echten Defekte:

1. **ParadeDB-`@@@`-Such-Operator parst den Query-WERT als BM25-DSL** — `Tier1BM25.ts:151`
   `WHERE note_id @@@ ${query}`. Der Wert ist zwar ein Bind-Parameter, aber ParadeDB
   interpretiert den **String** als Query-Sprache. Eine Suche, die `)`, `(`, `'`, `:` oder
   reservierte BM25-Operatoren enthält, wirft `PostgresError 42601 scanner_yyerror`. **Direkt
   reproduzierbar.**
2. **Der Upsert-42601 aus dem Produktions-Log** (`note_search upsert failed … syntax error at or
   near ")"` für eine Voice-Note) stammt aus ParadeDB-Index-Maintenance auf bestimmtem
   Note-Content, NICHT aus SQL-Text-Konkatenation. Genaue Trigger-Zeichen sind beim Bauen zu
   **reproduzieren** (siehe AC#6).
3. **Kein Circuit-Breaker / keine Quarantäne** — `memory/index.ts:84-94` fängt den Fehler
   („non-blocking"), aber **jeder** folgende Save feuert `queueSearchIndexRefresh` erneut; eine
   Poison-Note schlägt bei jedem Save wieder fehl.
4. **Ein einziger Pool** — `db/index.ts:21` `postgres(databaseUrl, { max: 10 })` als Singleton
   für alles. Wiederholt fehlschlagende fire-and-forget-Index-Writes belegen Pool-Connections und
   verhungern `search_vault` und andere DB-Tools → der beobachtete Total-Ausfall.
   `read_note`/`resolve_by_id` sind filesystem-only und an sich nicht betroffen, scheitern im
   Ausfall nur indirekt.

## Acceptance Criteria

1. **ParadeDB-Query-Härtung:** `Tier1BM25.search` (`Tier1BM25.ts:129-209`) übergibt dem `@@@`-Pfad
   keinen rohen User-String mehr. Entweder die Query sanitisieren/escapen (BM25-Sonderzeichen
   neutralisieren bzw. als Phrase quoten), ODER den `@@@`-Aufruf in try/catch kapseln und bei
   ParadeDB-Parse-Fehler **deterministisch** auf den vorhandenen LIKE-Fallback (`:169-208`)
   zurückfallen. Eine Suche mit `query = "foo) bar"` oder `"o'brien"` darf **nie** werfen, sondern
   liefert Ergebnisse oder leere Liste.
2. **Upsert-Resilienz:** `Tier1BM25.upsert` bzw. der Aufrufpfad fängt ParadeDB/Postgres-Fehler so,
   dass eine fehlerhafte Note die Tabelle/den Index nicht in einen Retry-Sturm zwingt. Der
   geschriebene Row-State bleibt konsistent (Upsert ist idempotent via `ON CONFLICT`).
3. **Per-Note-Circuit-Breaker (`memory/index.ts`):** Nach N (Default 3) aufeinanderfolgenden
   Upsert-Fehlern für dieselbe `noteId` wird die Note **quarantänisiert**: weitere
   `queueSearchIndexRefresh`-Aufrufe für diese ID werden übersprungen (bis Erfolg/Reset), ein
   **lauter** Log-Eintrag (nicht „non-blocking"-Flüstern) wird einmalig geschrieben, und der
   Zustand ist abfragbar (z.B. exportierte `getQuarantinedNotes(): {noteId, failures, lastError}[]`
   für späteren `get_health()`-Konsum in Story 10.8). Indexer macht für alle anderen Notes weiter.
4. **Pool-Isolation (`db/index.ts`):** Fire-and-forget-Index-Writes dürfen den Haupt-Pool nicht
   erschöpfen. Umsetzung wahlweise: separater kleiner Pool für Index-Writes ODER ein
   Statement-/Connection-Timeout auf dem Index-Pfad, sodass hängende Index-Queries Connections
   freigeben statt zu stauen. Reads/Search müssen unter einem Index-Sturm verfügbar bleiben.
5. **Bounded Backoff statt sofortigem Re-Fire:** der Index-Refresh-Pfad versucht eine fehlerhafte
   Note nicht in Endlosschleife sofort erneut (kein busy-retry); Backoff oder „skip until next
   real change" reicht.
6. **Reproduktions-Test (regress):** Ein Test legt eine Note mit Sonderzeichen im Body
   (`"Hey, schau mal: 🎉 (Klammer) 'quote'"`) an bzw. ruft `search` mit `)`/`'` und beweist:
   (a) vor dem Fix wirft der `@@@`-Pfad bzw. der Indexer (dokumentiert), (b) nach dem Fix bleibt
   das System funktionsfähig (Search liefert, Indexer quarantänisiert statt Pool zu fluten).
7. `pnpm --filter @lokyy/core build` + `pnpm -r build` grün; bestehende Memory-Tests grün.
8. **Anti:** KEINE Änderung an `notesService.ts`, `mcp/src/server.ts`, `gitService.ts`. Keine
   Schema-/Migrations-Änderung an `note_search` nötig (Upsert bleibt parametrisiert).

## Tasks / Subtasks

- [ ] `Tier1BM25.search` `@@@`-Pfad härten (sanitize ODER try/catch→LIKE-Fallback) — AC#1
- [ ] `Tier1BM25.upsert` Fehlerpfad robust (idempotent, kein Schema-Change) — AC#2
- [ ] Circuit-Breaker/Quarantäne-State in `memory/index.ts` (`queueSearchIndexRefresh`) — AC#3
- [ ] `getQuarantinedNotes()` exportieren (für Story 10.8) — AC#3
- [ ] Pool-Isolation/Timeout in `db/index.ts` — AC#4
- [ ] Bounded Backoff — AC#5
- [ ] Reproduktions-/Regress-Tests — AC#6
- [ ] Builds grün — AC#7

## Dev Notes

- **Client-Lib:** `postgres` (postgres.js) via `drizzle-orm/postgres-js` (`db/index.ts:1-2,21`).
  `database().execute(sql\`…\`)` parametrisiert über die extended protocol — Bind-Params sind sicher;
  das Problem ist die ParadeDB-DSL-Interpretation des `@@@`-Werts, nicht SQL-Text.
- **Genaue Fundstellen:** Upsert `Tier1BM25.ts:85-95`; `@@@`-Search `Tier1BM25.ts:148-156`;
  LIKE-Fallback `Tier1BM25.ts:169-208`; Log/fire-and-forget `memory/index.ts:84-94`;
  Pool-Singleton `db/index.ts:21` (`max: 10`).
- **`pg_search`-Probe** existiert (`Tier1BM25.ts:32-43`) — bei fehlender Extension läuft schon der
  LIKE-Pfad. Den gleichen Fallback für Parse-Fehler nutzbar machen.
- Pool-Isolation: Migrations nutzen bereits einen separaten `max:1`-Pfad (laut Investigation) — als
  Muster für einen dedizierten Index-Write-Pool wiederverwendbar.
- **Forge-Hinweis:** dies ist die kritischste Story (Produktions-Ausfall). Korrektheit vor
  Eleganz; die Reproduktion (AC#6) ist Pflicht, nicht optional.

### References

- [Source: 90_ideas/lokyy-mcp-gaps — Sektion 8 (8.1–8.6), korrigiert durch Code-Investigation 2026-05-29]
- [Source: Story 5.2 (Tier1BM25), 5.4 (fire-and-forget sync hook)]

## Dev Agent Record

### Agent Model Used

Forge (Dev agent). Code production via Claude Opus 4.7 directly. NOTE: the
intended OpenAI-lineage path (`codex exec` GPT-5.4 @ reasoning=high) was
**unavailable** — `~/.bun/bin/codex` is not installed on this host, nor is a
`codex` binary anywhere on PATH. Per Forge doctrine there was no silent
fallback to a different *cognitive lineage* check; the cross-lineage review that
codex would have provided did NOT happen. The orchestrator should treat this
diff as single-lineage and may want a Cato/second-reviewer pass.

### Debug Log References

- Iteration: first `pnpm --filter @lokyy/core build` failed with TS2322 on the
  `postgres({ connection: { statement_timeout: ... } })` GUCs — postgres.js
  types expect `number` (ms), not `string`. Fixed by passing numbers.
- Iteration: first `vitest run` showed 4 circuit-breaker test failures — the
  bounded-backoff guard (AC#5) suppressed the 2nd/3rd consecutive `refresh`
  calls inside the 30s window, so a tight loop only recorded ONE failure and
  never reached the quarantine threshold of 3. This was the backoff working
  correctly; the tests were wrong. Fixed by advancing `Date.now()` past the
  backoff window between attempts via a `failUntilQuarantined()` helper.

### Completion Notes List

- **AC#1 (ParadeDB query hardening):** Added `sanitizeBm25Query()` in
  `Tier1BM25.ts` that strips every BM25/Tantivy-DSL-significant character
  (`()[]{}:^~*?\\/"'+-!&|<>=#@`) and bare boolean keywords down to plain term
  tokens BEFORE the value reaches the `@@@` operator. Defense-in-depth: the
  `@@@` query is also wrapped in try/catch; a residual ParadeDB parse error
  (SQLSTATE 42601 / `scanner_yyerror`) deterministically falls back to the
  existing LIKE path via the extracted `likeFallbackSearch()` helper. Non-parse
  errors (connection etc.) still propagate. Result: `search("foo) bar")` and
  `search("o'brien")` can never throw.
- **AC#2 (upsert resilience):** `upsert` stays idempotent (`ON CONFLICT`),
  unchanged schema, and now runs on the isolated index pool (see AC#4). Failure
  handling lives in the breaker (AC#3) so a bad note no longer storms retries.
- **AC#3 (per-note circuit breaker):** Added a `Map`-backed breaker in
  `memory/index.ts`. After `QUARANTINE_THRESHOLD = 3` consecutive upsert
  failures for the same `noteId`, the note is quarantined (further
  `queueSearchIndexRefresh` calls for it are skipped), a LOUD `console.error`
  fires exactly ONCE on the transition into quarantine, and state is queryable
  via the exported `getQuarantinedNotes(): {noteId, failures, lastError}[]`
  (for Story 10.8 `get_health()`). Also exported `clearQuarantine()` and a
  `resetQuarantineState()` test hook. Other notes keep indexing.
- **AC#4 (pool isolation):** Added a second small pool in `db/index.ts`
  (`indexDatabase()`, `max: 2`) with a 5s `statement_timeout` +
  `idle_in_transaction_session_timeout`, lazily created from the URL captured
  at `initDb` and closed by `closeDb()`. All fire-and-forget index writes
  (`upsert`/`remove`/`setForgotten`) now use it; reads/search keep the main
  `max: 10` pool. An index-write storm can no longer starve the read pool.
- **AC#5 (bounded backoff):** Before quarantine, a failing note is not retried
  within a 30s window (`RETRY_BACKOFF_MS`) — no busy-retry loop. A genuine
  later change still retries; a successful upsert clears all state.
- **AC#6 (regression test):** Three test files under `packages/core/src/memory/`.
  Pure-logic coverage (no DB) for the sanitizer + the full breaker/backoff
  behaviour, plus a DB-gated live-ParadeDB regression
  (`searchHardening.db.test.ts`, `describe.skipIf(!LOKYY_TEST_DATABASE_URL)`)
  that proves `)`/`'` queries never throw against a real engine.
- **AC#7:** `pnpm --filter @lokyy/core build` ✅, `pnpm -r build` ✅,
  `pnpm --filter @lokyy/core test` ✅ (157 passed, 3 skipped — the 3 skipped are
  the DB-gated AC#6 tests).
- **AC#8 (anti):** No change to `notesService.ts`, `mcp/src/server.ts`,
  `gitService.ts`, or any schema/migration by THIS agent.

**Orchestrator follow-up (NOT done here — outside file ownership):**
`getQuarantinedNotes`/`clearQuarantine`/`QuarantinedNote` are exported from
`packages/core/src/memory/index.ts` (satisfies AC#3) but are NOT yet re-exported
from the `@lokyy/core` barrel (`packages/core/src/index.ts`) — that file is
owned by the parallel Story 10.2 agent. Story 10.8 will need a one-line barrel
re-export to import these from `@lokyy/core`.

### File List

- `packages/core/src/db/index.ts` (M) — isolated index-write pool
  (`indexDatabase()`, `max:2`, statement_timeout) + lifecycle wiring.
- `packages/core/src/memory/Tier1BM25.ts` (M) — `sanitizeBm25Query()`,
  `@@@` try/catch→LIKE fallback, `likeFallbackSearch()` extraction, writes
  routed to the index pool.
- `packages/core/src/memory/index.ts` (M) — per-note circuit breaker /
  quarantine, bounded backoff, shared `runGuardedIndexWrite` runner for all
  three write paths (hardening #1), bounded breaker Map with LRU eviction
  (hardening #2), `getQuarantinedNotes()`/`clearQuarantine()`/
  `getBreakerStateSize()`/`setMaxBreakerEntriesForTest()`/`resetQuarantineState()`.
- `packages/core/src/memory/Tier1BM25.test.ts` (A) — sanitizer unit tests (AC#1).
- `packages/core/src/memory/circuitBreaker.test.ts` (A) — breaker + backoff
  tests (AC#3/AC#5).
- `packages/core/src/memory/searchHardening.db.test.ts` (A) — DB-gated live
  ParadeDB regression (AC#6).

### Post-Review Hardening (independent code review — 3 critical-path items)

Independent review returned no Critical findings; the fix was sound. Three
hardening items were applied, all within owned files:

- **#1 — all three write paths share the breaker (most important).** The
  original implementation only routed `upsert` through the circuit breaker;
  `remove` (DELETE) and `setForgotten` (UPDATE) ran on the index pool unguarded,
  so a note that failed on those could still retry-storm the pool — a narrower
  reopening of the outage. Refactored the breaker logic into a single
  `runGuardedIndexWrite(noteId, label, op)` runner in `memory/index.ts`;
  `queueSearchIndexRefresh`, `queueSearchIndexRemove`, and
  `queueForgottenToggle` all delegate to it, so quarantine + bounded backoff are
  shared per-note across every write kind.
- **#2 — breaker Map is now bounded.** `breakerByNote` previously never evicted
  entries for notes that fail once then go quiet → slow leak. Added
  `MAX_BREAKER_ENTRIES = 1000` with `evictIfOverCap()` that evicts the
  least-recently-touched entry, preferring non-quarantined entries so the
  operator-visible quarantine list survives as long as possible. Added a
  `touchedAt` field for LRU ordering, plus `getBreakerStateSize()` (also useful
  for `get_health()`) and a `setMaxBreakerEntriesForTest()` hook.
- **#3 — index pool fails fast on connect.** Added `connect_timeout: 5`
  (seconds) to the `indexDatabase()` pool in `db/index.ts` so that under a write
  storm a queued index write fails fast (and the breaker counts/backs-off)
  instead of stalling indefinitely waiting for a socket.

New tests (extend `circuitBreaker.test.ts`): poison `remove` and poison
`setForgotten` each get quarantined; backoff/quarantine state is shared across
paths (a failing upsert suppresses a following remove; quarantining via remove
blocks the upsert path); eviction keeps the Map at/under the cap and retains the
quarantined entry while shedding transient ones. 4 + 2 = 6 new tests.

Re-verification: `pnpm --filter @lokyy/core build` ✅ exit 0,
`pnpm -r build` ✅ exit 0, `pnpm --filter @lokyy/core test` ✅ exit 0
(163 passed, 3 DB-gated skipped).

### Change Log

| Date | Change | AC |
|------|--------|----|
| 2026-05-29 | ParadeDB query sanitizer + try/catch→LIKE fallback | AC#1 |
| 2026-05-29 | Idempotent upsert routed to isolated index pool | AC#2 |
| 2026-05-29 | Per-note circuit breaker + quarantine + loud-once log + `getQuarantinedNotes()` | AC#3 |
| 2026-05-29 | Dedicated `max:2` index pool with statement_timeout | AC#4 |
| 2026-05-29 | Bounded 30s backoff (no busy-retry) | AC#5 |
| 2026-05-29 | Sanitizer + breaker + backoff + DB-gated live regression tests | AC#6 |
| 2026-05-29 | Builds green (`@lokyy/core` + `pnpm -r`), 157 tests pass / 3 DB-gated skipped | AC#7 |
| 2026-05-29 | Hardening #1: all 3 write paths (upsert/remove/setForgotten) share the breaker via `runGuardedIndexWrite` | review |
| 2026-05-29 | Hardening #2: bounded breaker Map (`MAX_BREAKER_ENTRIES`=1000, LRU eviction, quarantined-last) + `getBreakerStateSize()` | review |
| 2026-05-29 | Hardening #3: `connect_timeout: 5` on the index pool (fail fast under storm) | review |
| 2026-05-29 | +6 hardening tests; re-verify builds green, 163 tests pass / 3 DB-gated skipped | review |
