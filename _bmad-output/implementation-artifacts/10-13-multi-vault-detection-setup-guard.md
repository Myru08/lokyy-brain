# Story 10.13: Multi-Vault-Erkennung (Setup-Guard + lauter Boot-Warn)

Status: ready-for-dev

> Welle 3. **Agent V.** NUR `mcp/src/resolveVaultId.ts` + `mcp/src/setup.ts` (+ Tests). NICHT
> `mcp/src/server.ts` (Agent M), nicht core/*.

## Story

Als Betreiber möchte ich, dass beim Setup **nicht** zwei Vault-Rows entstehen und dass — falls doch —
der MCP-Boot **laut** warnt (nicht nur Info) und die Mehrdeutigkeit sichtbar wird, damit nicht
stillschweigend der „ältere" Vault gewählt wird (Risiko stiller Datenverlust).

## Acceptance Criteria

1. **Lauter Boot-Warn (Agent V):** erkennt `resolveVaultId` mehrere Vault-Rows, wird das als
   prominente Warnung (stderr, klar als PROBLEM markiert) ausgegeben — inkl. aller Vault-IDs +
   Hinweis auf `LOKYY_VAULT_ID`. Die `LOKYY_VAULT_ID`-Override-Logik bleibt (`resolveVaultId.ts:25-29`).
2. **Detektions-API für get_health:** `resolveVaultId` (oder ein Helfer daneben) exponiert ein
   Ergebnis, das die Mehrdeutigkeit maschinenlesbar trägt (z.B. `{ vaultId, ambiguous: boolean,
   candidates: string[] }`), damit `get_health()` (Story 10.8, von Agent M verdrahtet) ein
   `vault_warning` setzen kann. (Agent M konsumiert das; Agent V liefert es nur.)
3. **Setup-Guard:** `mcp/src/setup.ts` bzw. der Vault-Provisioning-Pfad verhindert das versehentliche
   Anlegen eines zweiten Vault-Rows (Idempotenz: existiert ein Vault mit gleichem Identifier, wird er
   wiederverwendet statt dupliziert). Wo das Anlegen nicht in setup.ts liegt, dokumentiere die
   Fundstelle und implementiere den Guard am nächstgelegenen kontrollierbaren Punkt in deinen Files.
4. **Tests:** mehrere Rows → `ambiguous:true` + Kandidatenliste + Warn; Env-Override greift weiter;
   Single-Row → `ambiguous:false`. `pnpm -r build` grün; mcp-Tests grün.
5. **Anti:** keine DB-Migration; bestehendes „pick oldest"-Verhalten darf als Fallback bleiben, aber
   NICHT mehr stillschweigend (Warn ist Pflicht).

## Dev Notes

- `resolveVaultId.ts:33-54` (Query aller Rows, Sort by createdAt asc `:45`, pick `rows[0]`, Info-Warn
   `:47-50`), Env-Override `:25-29`. Heute nur `console.error`-Info — auf PROBLEM-Level heben +
   strukturiertes Ergebnis.
- `setup.ts`: Vault-Provisioning/Patch-Flow; prüfen wo Vault-Rows entstehen (ggf. server-seitiges
   Setup — dann hier nur Erkennung+Warn, Guard-Fundstelle dokumentieren).

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 8.5; Story 10.8 (get_health vault_warning)]

## Dev Agent Record
### Agent Model Used
Claude (Opus 4.7, 1M context) — Dev agent "Agent V" (Welle 3).

### Completion Notes List
- **AC#1 (loud boot-warn):** `resolveVaultId.ts` no longer logs a quiet `console.warn` info line on multi-row. `pickVaultResolution()` now emits a boxed, clearly-marked `⚠️ PROBLEM` block to **stderr** (`console.error`) listing EVERY vault id+slug (oldest tagged `[picked: oldest]`) and printing the exact `LOKYY_VAULT_ID=<oldest-id>` fix hint. The env-override path (`LOKYY_VAULT_ID`) is preserved and short-circuits the DB query entirely (never ambiguous).
- **AC#2 (detection API for get_health):** added exported `VaultResolution = { vaultId, ambiguous, candidates, source }` and `VaultCandidate = { id, slug }`, plus a new async `resolveVaultResolution(databaseUrl)` that returns the full object. This is what the `get_health` wiring (Agent M, Story 10.8) must consume to set `vault_warning`. The plain-string `resolveVaultId(databaseUrl): Promise<string>` is kept as a backward-compatible accessor (delegates to `resolveVaultResolution` and returns `.vaultId`), so the unchanged callers `bin.ts:32` and `binHttp.ts:31` keep working with zero edits.
- **AC#3 (setup-guard):** `mcp/src/setup.ts` is a **client-config patcher only — it never creates vault rows.** Vault rows are actually inserted in two SERVER-owned files (outside this agent's ownership): `server/src/routes/auth.ts:106` (`autoProvisionPersonalVault`, slug `personal-…`) and `server/src/routes/setup.ts:242` (POST `/api/setup/vault`, guarded by `isSetupComplete()`). The `vaults.slug` column is already `UNIQUE` at the DB level (schema `vaults.ts:7`), so duplicate *slugs* are already rejected. The residual hazard is two rows with different slugs pointing at the SAME git remote. Per the story's "implement the guard at the nearest controllable point in YOUR files" instruction, I added a pure, DB-free, exported idempotency helper `guardVaultProvision(existing, desired) → {action:"create"} | {action:"reuse", vaultId, reason}` plus `normalizeGitRemote()` to `setup.ts`. The provisioning routes SHOULD call this before their `insert(vaults)`. **Guard status: PARTIAL** — the helper + its tests are complete and live in my owned files; wiring it into the two server insert sites is a follow-up for the server agent (documented above so the orchestrator can close it).
- Made `setup.ts` import-safe: the top-level `await main()` now only runs when the module is the process entry point (`isEntryPoint()` check), so importing the exported guard helpers from `setup.test.ts` no longer launches the interactive wizard.
- **AC#4/#5 (tests):** `resolveVaultId.test.ts` (6 tests, DB-free — feeds plain rows to `pickVaultResolution`): multi-row → `ambiguous:true` + full candidates + oldest picked; loud PROBLEM stderr warn asserted (lists all ids + `LOKYY_VAULT_ID=` hint); oldest picked regardless of input order; single-row → `ambiguous:false`, no warn; env-override wins over a multi-row DB and is never ambiguous (incl. zero-rows). `setup.test.ts` (7 tests): `guardVaultProvision` reuse-by-slug, reuse-by-git-remote (cosmetic-diff tolerant), create-when-no-match, no-collapse on empty git-remote, create against empty DB; `normalizeGitRemote` cosmetic-equivalence. No DB migration, no `drizzle-orm` direct dep added; "pick oldest" remains as the documented (non-silent) fallback.

### Detection result shape for the get_health wiring agent (Agent M)
Call `resolveVaultResolution(databaseUrl)` (exported from `mcp/src/resolveVaultId.js`). It returns:
```ts
interface VaultResolution {
  vaultId: string;                  // the id to attach to (env override, else oldest row)
  ambiguous: boolean;               // true ONLY when >1 DB row AND no env override
  candidates: { id: string; slug: string }[]; // [] when source==="env"; all rows when source==="db"
  source: "env" | "db";
}
```
For `get_health`, set `vault_warning` when `ambiguous === true`, surfacing `candidates` (the competing vault ids/slugs) so the operator can pin `LOKYY_VAULT_ID`. `resolveVaultId(databaseUrl): Promise<string>` still exists for the plain-id callers.

### File List
- `mcp/src/resolveVaultId.ts` (modified) — `VaultResolution`/`VaultCandidate` types, pure `pickVaultResolution`, async `resolveVaultResolution`, backward-compat `resolveVaultId`, loud stderr PROBLEM warn.
- `mcp/src/setup.ts` (modified) — `guardVaultProvision`/`normalizeGitRemote`/`ExistingVault`/`VaultProvisionDecision` idempotency guard + provisioning-location doc comment; entry-point guard around `main()`.
- `mcp/src/resolveVaultId.test.ts` (new) — 6 tests (AC#1/#2/#5).
- `mcp/src/setup.test.ts` (new) — 7 tests (AC#3).

### Verify commands + results
- `pnpm -r build` → **exit 0** (mcp + server + pwa all green).
- `(cd mcp && ../packages/core/node_modules/.bin/vitest run)` → **3 files passed, 36 tests passed** (resolveVaultId 6, setup 7, server 23 unchanged). exit 0.
- Did NOT run `pnpm install`.

### Change Log
- 2026-05-29 — Story 10.13 implemented (Agent V): multi-vault detection + loud boot-warn + machine-readable resolution API + setup idempotency guard. Files: `mcp/src/resolveVaultId.ts`, `mcp/src/setup.ts` (+ tests). Build + mcp tests green.
