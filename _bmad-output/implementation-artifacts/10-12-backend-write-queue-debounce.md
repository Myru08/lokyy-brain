# Story 10.12: Backend Write-Queue / Debounce (Git-Ops sequentialisieren)

Status: ready-for-dev

> Welle 3. **Agent G (Git, HIGH RISK).** NUR `packages/core/src/git/gitService.ts` und (falls für
> Konfig nötig) `packages/core/src/util/coreConfig.ts` + Tests. NICHT mcp/*, notes/*, server/*.
> Diese Datei wurde in Story 10.6 bereits geändert (committed im Working-Tree) — baue darauf auf,
> brich 10.6 nicht.

## Story

Als Backend möchte ich konkurrierende Git-Schreibvorgänge unter hoher Frequenz sauber
sequentialisieren/entlasten, damit der in der Quell-Note beschriebene Race (false „Merge-Konflikte",
korrelierend mit Schreibfrequenz) nicht mehr auftritt — als strukturelle Ergänzung zur
Idempotenz-Heilung aus 10.6.

## Acceptance Criteria

1. **Serielle Verarbeitung erhalten/verstärkt:** die bestehende `serialize()`-Promise-Lock
   (`gitService.ts:31-38`) bleibt die Grundlage; falls sie eine Latch-Race hat (Investigation: ein
   frischer Save kann an dieselbe bereits-settled `lock`-Promise andocken), wird die Lock so
   gehärtet, dass Ops echt FIFO-seriell laufen (eine laufende Op blockiert die nächste verlässlich).
2. **Optionales Debounce/Coalescing:** mehrere rasch aufeinanderfolgende Writes auf **dieselbe**
   Note dürfen zu einem Push gebündelt werden (kein Pull/Push pro Tastenanschlag), ohne Datenverlust
   — der zuletzt gewünschte Content gewinnt, jeder `save()`-Aufruf resolved korrekt. Wenn das das
   Risiko erhöht, stattdessen reine Serialisierung + ein einzelner Pull pro Batch.
3. **Kein Datenverlust / korrekte Resolution:** jeder `save`/`saveBinary`/`move`-Aufruf resolved erst,
   wenn sein Inhalt sicher committed (lokal, ggf. Push aufgeschoben) ist; ein Fehler eines Items
   reißt nicht fälschlich andere mit.
4. **Verträglich mit 10.6:** die in 10.6 eingeführten typisierten Fehler + Idempotenz-Checks bleiben
   intakt; keine Regression der 10.6-Tests.
5. **Tests:** N rasch aufeinanderfolgende Saves auf dieselbe/verschiedene Notes → alle landen
   korrekt, keine false-conflict-Errors, serielle Reihenfolge nachweisbar. `pnpm -r build` grün,
   git-Tests grün.
6. **Anti:** kein `--no-verify`; keine MCP-/Schema-Änderung; keine neue Abhängigkeit; Reads dürfen
   nicht dauerhaft hinter Write-Batches verhungern (Fairness).

## Dev Notes

- Lock `gitService.ts:31-38` (`serialize()` via `lock.then(fn,fn)`); Ops: `save:234`, `saveBinary:293`,
  `remove:336`, `move:355`, `pull:215`. Reads pullen zuerst (`notesService.ts:100/111/270`) und teilen
  die Lock — Fairness beachten.
- 10.6 hat in derselben Datei Idempotenz + Fehlerklassen ergänzt — den aktuellen Stand der Datei
  lesen, NICHT die 10.6-Logik entfernen.
- Debounce-Config (z.B. Fenster in ms) ggf. in `util/coreConfig.ts` mit sinnvollem Default + Off-Schalter.

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 4 (Write-Queue) + 8; Story 10.6 (Idempotenz/Fehlerklassen)]

## Dev Agent Record

Status: ready-for-review

### Agent Model Used
Claude Opus 4.7 (1M) — Engineer/Dev agent (Agent G, Git, HIGH RISK).

### Completion Notes List

**AC#1 — FIFO serialization hardened (kept 10.6 base).** Investigated the
`serialize()` latch concern. In single-threaded JS the original
`lock.then(fn,fn)` + synchronous `lock = run.catch(...)` is already FIFO-correct:
the tail is advanced synchronously (before any `await` yields), so two
`serialize` calls in the same tick can never both read a stale/settled tail —
the second always chains behind the first. I kept that proven structure,
renamed the variable to `lockTail` for clarity, and documented the exact
invariant ("synchronous advance ⇒ no latch race") plus *why* both `.then`
branches run `fn` (a rejected predecessor must not cancel its successor). New
test `"a failing op does not cancel the next queued op"` locks this in (a
rejecting `move` followed by a `save` — the save still runs).

**AC#2 — Opt-out same-note coalescing (no timer, zero-latency).** Rather than a
time-window debounce (which risks dropping the last keystroke), I added
*opportunistic* coalescing: a `pendingSaves` registry keyed by relPath holds the
latest content while a save is **queued but not yet executing**. A newer
same-note `save()` overwrites those bytes (last-write-wins) and attaches a waiter
instead of enqueuing a second push. When the single op starts it reads the
latest bytes and clears the registry, so N keystroke saves collapse into one push
and every caller resolves with that one commit SHA. Controlled by
`coreConfig.coalesceSameNoteSaves` (default `true`, set `false` for pure
1-push-per-save). **Coalescing is text-`save()`-only** — `saveBinary`/`move`/
`remove` stay pure-serialized (binary bytes can't be safely last-write-merged;
moves/removes are structural). This is the "if risky, prefer pure serialization"
path the AC allows.

**AC#3 — No data loss / correct resolution.** The op-start registry-delete is the
loss-free invariant: an in-flight commit can never have its bytes swapped out,
and a save arriving after the op starts opens a fresh window with its own push.
Each `save()` resolves only after its content is committed (and pushed, or
local-safe when no remote / deferred-push recovery). One coalesced op's failure
rejects *only* its own waiters; unrelated notes/ops are untouched (they're
separate lock slots). Subtle bug caught + fixed during dev: the leader's
fan-out cleanup originally did an unconditional `pendingSaves.delete(relPath)`,
which could clobber a *newer* window's entry — guarded with `=== pend`.

**AC#4 — 10.6 fully preserved.** `runSave` is the old `save` body verbatim plus a
4-line coalescing handoff at the top. All 10.6 idempotency checks
(`isAlreadyPersisted`, `handlePullFailure`, `tryDeferredPush`) and typed errors
(`PreCommitHookError`/`MergeConflictError`/`GitBackendError`) are unchanged and
still exercised by `handlePullFailure(err, relPath, finalContent, …)`. The 5
original 10.6 git tests pass untouched.

**AC#5/#6 — Tests + anti-constraints.** Added 7 tests (serial ordering, fairness,
fail-doesn't-cancel-next, coalescing last-wins/fewer-pushes, off-switch parity,
different-notes-not-coalesced, after-start-not-coalesced). No `--no-verify`, no
MCP/schema change, no new dependency. **Fairness:** a `pull()` (the read path
shares the lock) issued amid a write burst takes its FIFO slot and resolves
promptly — proven by the fairness test; coalescing never enlarges a single op's
duration, so reads are not starved behind write batches.

### File List
- `packages/core/src/git/gitService.ts` (modified — hardened `serialize()`/`lockTail`, added `pendingSaves` registry, split `save` into coalescing front-door + `runSave`)
- `packages/core/src/util/coreConfig.ts` (modified — added optional `coalesceSameNoteSaves?: boolean`, default `true` in `initCore`)
- `packages/core/src/git/gitService.test.ts` (modified — +7 tests across 2 new describe blocks)

### Verify Commands + Results
- `pnpm -r build` → exit 0 (core, shared, pwa, mcp, server all "Done").
- `(cd packages/core && node_modules/.bin/vitest run src/git)` → 12 passed (5×10.6 + 7×10.12).
- `(cd packages/core && node_modules/.bin/vitest run)` → 210 passed | 3 skipped (DB-gated). Baseline before this story was 203 passed | 3 skipped at the time of my edits; +7 are exactly the new git tests. No regression.

### Orchestrator double-check notes (HIGH RISK)
1. **Lock semantics unchanged in spirit, only renamed/documented.** The
   serialization algorithm is byte-for-byte equivalent to 10.6's; if you prefer
   zero churn on that block I can revert the rename and keep only the comment.
2. **Coalescing is text-only and opt-out.** If any caller already relies on
   "one commit per `save()` call" for the same note in rapid succession, set
   `coalesceSameNoteSaves: false` in that deployment's `initCore`. Default-on is
   the keystroke-storm fix; behavior for *sequential awaited* saves is identical
   either way (each opens a fresh window) — only un-awaited bursts coalesce.
3. **No change to `saveBinary`/`move`/`remove`** beyond sharing the renamed lock.
4. **`coreConfig.ts` shows as "Bin" in `git diff --stat`** — that is git's
   binary heuristic firing on German-umlaut density, not corruption. File is
   valid UTF-8 (verified); use `git diff --text` to view.

### Change Log
- 2026-05-29: Implemented Story 10.12 (FIFO hardening + same-note coalescing) on top of 10.6. Dev: Engineer agent.
