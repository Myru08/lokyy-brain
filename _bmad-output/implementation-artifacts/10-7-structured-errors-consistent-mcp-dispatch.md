# Story 10.7: Strukturierte Errors konsistent (MCP-Dispatch-Wrapper)

Status: ready-for-dev

> Welle 2. **Agent C (MCP)** — NUR `mcp/src/server.ts` (+ Tests).

## Story

Als aufrufender Agent möchte ich, dass **jeder** MCP-Tool-Fehler strukturiert und klassifiziert
zurückkommt — auch Infrastruktur-Fehler (Pool-Erschöpfung etc.) —, damit ich „transient → retry"
von „permanent → nicht retryen" unterscheiden kann, statt das nichtssagende
`{ error: "Error occurred during tool execution" }` zu sehen.

## Kontext / Root-Cause (Investigation)

Strukturierte Errors existieren **teilweise** (`not-found` `server.ts:220/229`, `scope_violation`
`:330`, `invalid-ulid-format` `:226`, `skill-*` `:291-308`). Der generische Text kommt vom MCP-SDK,
wenn eine Exception **außerhalb** des Handler-`try` fliegt (z.B. Pool-Erschöpfung beim
Connection-Acquire rund um den `switch`). Der Handler-Fallback `:332` würde zudem die rohe
Postgres-Message leaken.

## Acceptance Criteria

1. **Dispatch-Wrapper:** der gesamte CallTool-Dispatch (`server.ts:211-334`) wird so gekapselt, dass
   eine Exception **vor/um** den `switch` (Infra) in einen strukturierten Fehler gemappt wird:
   `{ error: "tool-execution-failed", error_class, message, tool, retry_after_ms?, request_id? }`
   statt der SDK-Generik.
2. **`error_class`-Taxonomie:** jeder zurückgegebene Fehler trägt `error_class ∈
   {transient, permanent, user-error, backend}`. Mapping: Scope/Validation → `user-error`;
   not-found → `user-error`; Pool-/DB-Infra → `backend` (transient wo erkennbar, mit
   `retry_after_ms`); unbekannt → `backend`.
3. **Kein Leak roher Backend-Messages:** die rohe Postgres-/Stacktrace-Message wird nicht
   ungefiltert an den Client gegeben (loggen ja, ausliefern nur klassifiziert + knappe Message).
   Der bestehende `:332`-Fallback wird entsprechend ersetzt.
4. **Bestehende strukturierte Fehler bleiben kompatibel:** `not-found`, `scope_violation`,
   `invalid-ulid-format`, `skill-*`, `invalid-type`/`type-folder-mismatch` (Story 10.2) behalten ihr
   Format, bekommen aber additiv `error_class`.
5. **Tests:** simulierter Tool-Throw → strukturierter `tool-execution-failed` mit `error_class`;
   bestehender `not-found` unverändert nutzbar + `error_class: user-error`. `pnpm -r build` grün;
   `@lokyy/mcp`-Tests grün.
6. **Anti:** keine Core-Änderung; keine Tool-Semantik ändern, nur Fehler-Hülle vereinheitlichen.

## Dev Notes

- Dispatch + bestehende Fehler: `server.ts:211-334`; `text()`-Helper `:355-364`; Fallback `:332`.
- Mit Story 10.8 (`get_health`) und 10.1 (Pool-Isolation) abgestimmt: Pool-Erschöpfung ist der
  Hauptauslöser des generischen Fehlers; nach 10.1 seltener, aber der Wrapper muss ihn dennoch sauber
  klassifizieren.

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 8.3/8.6; Investigation 2026-05-29 (Fehlerquellen-Mapping)]

## Dev Agent Record
### Agent Model Used
Claude Opus 4.7 (Engineer agent — MCP-wiring / Agent C).

### Completion Notes List
- **AC#1 DONE — dispatch wrapper.** The whole `CallTool` handler body is now wrapped in an OUTER
  `try { … } catch (outer) { return text(classifyToolError(outer, name)) }`. The inner per-tool
  `try/catch` is unchanged in spirit; an exception thrown AROUND the switch (pool acquire, etc.)
  now hits the outer catch → structured `{ error: "tool-execution-failed", error_class, message,
  tool, retry_after_ms? }` instead of the SDK generic.
- **AC#2 DONE — taxonomy.** `classifyToolError(err, tool)` maps to `error_class ∈
  {transient, permanent, user-error, backend}`: pool/connection/timeout/conn-reset → `transient`
  + `retry_after_ms: 1000`; git lock contention → `transient` + `retry_after_ms: 500`; unknown →
  `backend` (no retry hint). Scope/validation/not-found stay `user-error` (the `ScopeViolation`
  branch is tagged additively; not-found is returned in-handler).
- **AC#3 DONE — no leak.** The raw error (`name: message`) is logged to STDERR only (stdout is the
  stdio protocol channel) and NEVER returned; the client gets a short classified message
  (e.g. "Tool execution failed. See server logs for details."). The old raw-message fallback
  (`return text({ error: err.message })`) is REPLACED by `classifyToolError`.
- **AC#4 DONE — back-compat.** `not-found`, `scope_violation`, `invalid-ulid-format`, `skill-*`,
  `invalid-type`/`type-folder-mismatch` keep their exact shapes; `scope_violation` gains
  `error_class: "user-error"` additively. (The other in-handler structured errors are returned
  before reaching the catch, so they are unchanged; classifier only governs THROWN errors.)
- **AC#6 DONE — no core change, no tool-semantics change.** Only `mcp/src/server.ts` touched for
  the wrapper; the error hull is unified, tool behaviour is untouched.
- Tests: `classifyToolError` unit tests (pool→transient+retry, lock→transient, unknown→backend +
  raw-message-not-leaked) and an e2e test where a stubbed `trashEntry` throws "pool exhausted" and
  the tool returns `tool-execution-failed`/`transient` with the raw text scrubbed.

### File List
- `mcp/src/server.ts` (outer dispatch try/catch + `classifyToolError` + `ErrorClass`/
  `ToolExecutionError` types; replaced the raw-message fallback)
- `mcp/src/server.test.ts` (classifier unit tests + e2e structured-error test)

### Change Log
- Structured-error dispatch wrapper + classifier; existing structured errors gain `error_class`
  additively; raw-message fallback replaced. `pnpm -r build` exit 0; mcp tests 23 passed.
