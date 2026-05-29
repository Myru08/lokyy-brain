# Story 10.15: Type-Enum erweitern (`tool`/`resource`/`reference`)

Status: ready-for-review

> Welle 4. Core = **Agent T** (`frontmatter/types.ts`, `frontmatter/schemas/`, `notes/folderMap.ts`).
> MCP zieht das Enum automatisch aus `DOC_TYPES` (Story 10.2) — keine separate MCP-Änderung nötig
> außer ggf. Doku.

## Story

Als Nutzer/Agent möchte ich Notes als `tool`/`resource`/`reference` typisieren können (heute musste
ich auf `note` ausweichen), damit die Typisierung der Realität entspricht und Listing/Filter sauber
greifen.

## Acceptance Criteria

1. **DOC_TYPES erweitern (Agent T):** `tool`, `resource`, `reference` werden zu `DOC_TYPES`
   (`frontmatter/types.ts`) hinzugefügt; je ein JSON-Schema in `frontmatter/schemas/` (am Muster der
   bestehenden Typ-Schemas; Pflichtfelder = base + ggf. typ-spezifisch). `validateFrontmatter`
   akzeptiert sie.
2. **folderMap erweitern:** kanonische Ordner für die neuen Typen in `notes/folderMap.ts`
   (z.B. `tool → 35_tools`, `resource → 30_captures` oder eigener Ordner, `reference → 20_notes`
   oder eigener) — **mit den realen Vault-Ordnern abstimmen** (35_tools existiert bereits real).
3. **Auto-Propagation:** da `create_note`-Enum (Story 10.2) und `get_vault_conventions` (Story 10.4)
   aus `DOC_TYPES`/`folderMap` abgeleitet sind, erscheinen die neuen Typen automatisch — verifizieren,
   dass das ohne weitere Änderung greift (sonst minimal nachziehen, aber NICHT MCP-Files in dieser
   Story editieren — nur prüfen/dokumentieren).
4. **Entscheidung Custom-Types:** statt beliebiger Custom-Types die feste Erweiterung (klarer,
   validierbar). Falls ein unbekannter Typ kommt, bleibt das Verhalten aus Story 10.2 (struktur.
   `invalid-type`-Reject, KEIN stilles Umschreiben).
5. **Tests:** neue Typen validieren; folderMap-Ableitung korrekt; conventions enthält sie.
   `pnpm -r build` grün; core-Tests grün.
6. **Anti:** kein stilles Umschreiben; keine Migration bestehender Notes.

## Dev Notes
- `DOC_TYPES` `frontmatter/types.ts:10-31`; Schemas `frontmatter/schemas/*.json` (base.json +
  per-type); `folderMap.ts` (Story 10.2); `validateFrontmatter`/`frontmatter/index.ts`.
- 35_tools ist realer Ordner. Ordnerwahl für resource/reference mit `get_vault_conventions`-Liste
  konsistent halten.

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 2.3]

## Dev Agent Record
### Agent Model Used
Engineer agent (Claude Opus 4.8, 1M context) — orchestrator-delegated Dev.

### Completion Notes List
- Added `tool`, `resource`, `reference` to `DOC_TYPES` (AC#1). Type `DocType` auto-widens.
- Created three per-type JSON schemas mirroring `note.json` (id/type/title/created/updated required,
  optional `tags`, `privacy`) PLUS an optional `url` field (a tool/resource/reference commonly
  carries a link). `type` is a `const` per type. `additionalProperties: true` like the others.
- Registered all three in the `validators` map in `frontmatter/index.ts` (import `with { type: "json" }`
  + `ajv.compile`). `validateFrontmatter` now accepts them (AC#1).
- `folderMap.ts` (AC#2): `tool → 35_tools` (real vault root, already asserted in conventions tests),
  `resource → 30_captures`, `reference → 20_notes`. All three are STATIC (NOT added to `DATED_TYPES`),
  so `derivePathForType` yields plain `{folder}/{slug}`.
- Origin/half-life scores added to BOTH exhaustive `Record<DocType>` maps in `scoring/importance.ts`:
  ORIGIN_SCORES tool 0.6 / resource 0.5 / reference 0.6; HALF_LIFE_DAYS tool 365 / resource 180 /
  reference 365. Values chosen to match existing peers (workflow/content/note ranges).
- AC#3 auto-propagation: `get_vault_conventions` (conventions/index.ts) and `create_note` enum
  (Story 10.2) derive from `DOC_TYPES`/`folderMap`. VERIFIED the three new types appear automatically
  in the conventions output and that existing conventions/folderMap tests (which iterate DOC_TYPES
  exhaustively) cover them with no edits to those tests. NO MCP files were touched.
- **Required out-of-scope edit (flagged):** `conventions/index.ts` holds `TYPE_MEANING:
  Record<DocType, string>` — an EXHAUSTIVE literal. It is impossible for an exhaustive `Record` to
  "auto-propagate"; without 3 new keys, `pnpm -r build` fails (TS2739, confirmed empirically before
  the fix). Per AC#3's "sonst minimal nachziehen" this was a minimal, data-only addition of three
  meaning strings. conventions/index.ts is NOT an MCP file, so it stays within AC#3's guardrail, but
  it falls outside the orchestrator's stricter file-ownership list — calling it out for QA ratification.
- Repo-wide audit for exhaustive `Record<DocType>` / switch-on-type found exactly FOUR maps:
  TYPE_FOLDER, ORIGIN_SCORES, HALF_LIFE_DAYS (owned, fixed) and TYPE_MEANING (out-of-scope, fixed).
  No `switch` statements over DocType anywhere. No other breakage.
- Tests added: frontmatter.test.ts +15 (5 per new type: valid / url round-trip / type-const mismatch /
  missing-id / bad-ULID); folderMap.test.ts +4 (placement / non-dated / derive / guard). conventions
  and scoring suites auto-cover via DOC_TYPES iteration.

### Verification
- `pnpm -r build` → exit 0 (core, mcp, server, pwa all built; downstream consumers of core compile,
  proving no further exhaustive-map breakage).
- `(cd packages/core && node_modules/.bin/vitest run)` → 19 files passed / 1 skipped; 242 tests
  passed / 3 skipped. (The "DB not initialized — non-blocking" stderr in notesService tests is
  pre-existing and unrelated to this story.)
- Targeted re-run of frontmatter/folderMap/conventions/scoring → 67 tests passed.

### File List
- packages/core/src/frontmatter/types.ts (M — DOC_TYPES + doc comment)
- packages/core/src/frontmatter/schemas/tool.json (NEW)
- packages/core/src/frontmatter/schemas/resource.json (NEW)
- packages/core/src/frontmatter/schemas/reference.json (NEW)
- packages/core/src/frontmatter/index.ts (M — 3 schema imports + validators map entries)
- packages/core/src/notes/folderMap.ts (M — TYPE_FOLDER entries, static placement)
- packages/core/src/scoring/importance.ts (M — ORIGIN_SCORES + HALF_LIFE_DAYS entries)
- packages/core/src/conventions/index.ts (M — TYPE_MEANING entries; OUT-OF-SCOPE, build-blocking, minimal)
- packages/core/src/frontmatter/frontmatter.test.ts (M — +15 tests)
- packages/core/src/notes/folderMap.test.ts (M — +4 tests)

### Change Log
- 2026-05-29 — Implemented extended type enum tool/resource/reference end-to-end; build + core tests green.
