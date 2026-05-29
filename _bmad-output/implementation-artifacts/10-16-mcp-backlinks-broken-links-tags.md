# Story 10.16: `get_backlinks` + `find_broken_links` + `get_tags` über MCP

Status: ready-for-dev

> Welle 4. Core = **Agent GB** (`packages/core/src/graph/graphService.ts` — neue Broken-Links-Logik;
> `backlinks`/`listTags` existieren). MCP-Tools = **Agent W** (`mcp/src/server.ts`).

## Story

Als KI-Agent möchte ich Backlinks, kaputte Wikilinks und die Tag-Liste über MCP abfragen können,
damit ich den Wissensgraphen pflegen kann (heute nur über die Web-API erreichbar, nicht über MCP).

## Acceptance Criteria

1. **Core (Agent GB):** `findBrokenLinks()` in `graphService` — Vault-weiter Scan: alle Wikilinks,
   deren Ziel (nach Titel/Pfad/ID-Auflösung) nicht existiert, mit Quell-Note + Link-Text.
   `backlinks(id)` (`graphService.ts:279`) und `listTags()` (`:244`) existieren — wiederverwenden.
2. **MCP (Agent W):** `get_backlinks({ path })` (wer linkt hierhin, mit Kontext-Snippet),
   `find_broken_links()` (Gesundheits-Check), `get_tags()` (alle Tags + Count). Read-Scope-Filter
   wie bei den anderen Read-Tools.
3. **Wikilink-Auflösungsregel dokumentieren:** in der Tool-Description klarstellen, wonach `[[ziel]]`
   matcht (Titel/Pfad/ID) — die Realität aus `graphService` ableiten, nicht raten.
4. **Tests:** backlinks liefert die linkenden Notes; broken-links findet ein totes `[[xyz]]`;
   get_tags zählt korrekt; Scope-Filter greift. `pnpm -r build` + core/mcp-Tests grün.
5. **Anti:** `backlinks`/`listTags` nicht umschreiben (nur konsumieren + broken-links additiv).

## Dev Notes
- `graphService.backlinks` `:279`, `listTags` `:244`, `parseLinks`/`parseTitle`/`buildGraph` für die
  Auflösungslogik (broken = Ziel nicht im Graph). REST-Referenz: `/api/graph/backlinks/:id`,
  `/api/graph/tags`. Barrel-Export der neuen `findBrokenLinks` macht Agent W (MCP-Wiring) zusammen
  mit dem Re-Export von `backlinks`/`listTags` falls noch nicht im Barrel.

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 6 + 7 (Tag-Listing)]

## Dev Agent Record

### Agent Model Used
Engineer (Claude Opus 4.8) — CORE part only (Agent GB). MCP wiring (Agent W) pending.

### Completion Notes List (CORE / Agent GB)
- Added `findBrokenLinks(): Promise<BrokenLink[]>` to `graphService.ts` (additive — `backlinks`/`listTags` untouched, AC#5 satisfied).
- Exact signature for Agent W (MCP wiring) + barrel:
  - `export async function findBrokenLinks(): Promise<BrokenLink[]>`
  - `export interface BrokenLink { sourceId: string; sourceTitle: string; linkText: string }`
- **Resolution reuse:** Pass 1 rebuilds the SAME lookup maps `buildGraph()` uses and resolves in the identical priority order **title → alias → basename → full-id** (lc for the first three, exact for id), via `parseTitle` / `parseAliases` / `parseLinks`. A link is broken iff none of the four resolve. `forgotten` notes are skipped as sources and never enter any map (so a link to a forgotten note is reported broken — graph parity). Wikilinks only (AC#1); markdown `.md`-links are out of scope.
- **Barrel status (read-only check of `packages/core/src/index.ts`):** `backlinks` + `listTags` are ALREADY exported (lines 43–44). `findBrokenLinks` + `BrokenLink` are NOT yet exported — **Agent W must add them to the graphService export block** (`findBrokenLinks`, `type BrokenLink`).
- **Tests:** new `packages/core/src/graph/graphService.test.ts` (6 cases, git-backed temp-vault pattern from notesService/git tests): dead `[[xyz]]` reported with source; resolvable-by-title, by-basename, by-full-id, by-alias all NOT reported; link to forgotten note reported; `[[Target|label]]` reports `Target` not the label.
- **Verify:** `pnpm -r build` → exit 0 (core/mcp/server/pwa all green). `vitest run` (core) → 223 passed | 3 skipped (baseline + 6 new). New-file run → 6/6 passed.

### File List (CORE / Agent GB)
- `packages/core/src/graph/graphService.ts` (added `BrokenLink` interface + `findBrokenLinks`)
- `packages/core/src/graph/graphService.test.ts` (new)

### Change Log
- 2026-05-29 — CORE: `findBrokenLinks()` + tests (Engineer / Agent GB). MCP tools + barrel export remain for Agent W.
