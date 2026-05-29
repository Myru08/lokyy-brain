# Story 10.4: `get_vault_conventions()` MCP-Tool

Status: ready-for-dev

> Welle 2. Core = **Agent B** (NEU `packages/core/src/conventions/`); MCP-Tool = **Agent C**
> (`mcp/src/server.ts`). Wiederverwendet die `type→folder`-Map aus Story 10.2
> (`packages/core/src/notes/folderMap.ts`) als single source of truth.

## Story

Als KI-Agent, der zum ersten Mal mit dem Vault arbeitet, möchte ich einen `get_vault_conventions()`
-Call, der mir die Vault-Struktur maschinenlesbar liefert, damit ich Ordner/Typen/Pfade **nicht
erraten** muss (genau die Lücke, die heute zu Fehlplatzierungen führt).

## Acceptance Criteria

1. **Core (Agent B):** ein `conventions`-Modul exportiert `getVaultConventions()` →
   `{ folders: [{ path, purpose, pathPattern }], types: [{ type, meaning, folder }], frontmatter:
   {...schema-summary...}, wikilinks, tags, ids }`. Die Ordner-/Typ-Map **leitet sich aus
   `folderMap.ts` (Story 10.2) und `DOC_TYPES` (`frontmatter/types.ts`) ab** — keine zweite,
   driftende Quelle. Frontmatter-Schema-Zusammenfassung aus `frontmatter/schemas/*.json` ableiten.
2. **MCP (Agent C):** `get_vault_conventions()`-Tool gibt das Objekt zurück. Reichhaltige
   Tool-Description, damit Agenten es zu Beginn aufrufen.
3. **Inhalt vollständig:** Top-Level-Ordner mit Bedeutung (`00_meta, 10_projects, 20_notes,
   30_captures, 35_tools, 50_decisions, 70_pai/{interventions,skills,sessions}, 90_ideas,
   99_archive`), Pfad-Patterns (z.B. `30_captures/voice/{YYYY-MM-DD}-slug`), Type-Enum mit Bedeutung,
   Frontmatter-Pflichtfelder (id/type/title/created/updated), Wikilink-/Tag-/ULID-Konventionen.
4. **Tests:** `getVaultConventions()` enthält alle DOC_TYPES und alle kanonischen Ordner;
   konsistent mit `folderMap`. `pnpm -r build` grün.
5. **Anti:** keine hartkodierte Ordner-Map, die von `folderMap.ts` abweicht (Drift verboten).

## Dev Notes

- `folderMap.ts` (Story 10.2, NEU) ist die kanonische `type→folder`-Map — daraus ableiten.
- `DOC_TYPES` `frontmatter/types.ts:10-31`; Schemas `frontmatter/schemas/*.json`;
  `validateFrontmatter`/`frontmatter/index.ts`.
- Reale Struktur via Vault bestätigen; `35_tools` existiert real zusätzlich zu den SPEC-Ordnern.

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 2.1; Vorgespräch 2026-05-29; Story 10.2 folderMap]

## Dev Agent Record
### Agent Model Used
Claude Opus 4.7 (Engineer agent — CORE part only; MCP tool wiring is Agent C's job).

### Completion Notes List
- **Core part (Agent B) DONE.** NEW module `packages/core/src/conventions/index.ts` exports
  `getVaultConventions()` → `{ folders, types, frontmatter, wikilinks, tags, ids }`.
- **No drift (AC#1/AC#5):** the type→folder map is read straight from `notes/folderMap.ts`
  (`TYPE_FOLDER`, `isDatedType`, `derivePathForType`) and the type enum from
  `frontmatter/types.ts` (`DOC_TYPES`). There is no second hand-maintained folder map.
  `buildTypes()` maps over `DOC_TYPES` and reads `TYPE_FOLDER[type]`; `buildFolders()` unions
  every `TYPE_FOLDER` value with the descriptive top-level roots, so every doc-type folder is
  guaranteed present. The dated/static `pathPattern` decision delegates to `isDatedType`.
- The frontmatter summary derives its `required` array from `frontmatter/schemas/base.json`
  (`id/type/title/created/updated`); per-field blurbs are short hand-written notes (the
  schema's own descriptions are verbose). The ULID example path is produced by
  `derivePathForType("capture", "slug", …)` so it can never drift from folderMap's logic.
- Content completeness (AC#3): folder list includes `00_meta, 10_projects, 20_notes,
  30_captures, 35_tools, 40_*, 50_decisions, 60_meetings, 70_pai/{interventions,skills,
  sessions,workflows,peers}, 80_brand, 90_ideas, 99_archive`; type enum with meanings;
  wikilink/tag/ULID conventions.
- AC#2 (MCP tool + rich description) is Agent C's scope.
- Tests assert: every `DOC_TYPE` present with its `folderMap` folder; all `canonicalFolders()`
  present; SPEC roots present; dated vs static path patterns; required-field summary;
  wikilink/tag/ULID strings + derived dated example.

### File List
- NEW `packages/core/src/conventions/index.ts`
- NEW `packages/core/src/conventions/conventions.test.ts`
- `packages/core/src/index.ts` (MCP-wiring agent: barrel re-export of `getVaultConventions` + 5 types)
- `mcp/src/server.ts` (MCP-wiring agent: `get_vault_conventions` ListTools entry + CallTool case)
- `mcp/src/server.test.ts` (MCP-wiring agent: payload + e2e tests)

### Completion Notes List (MCP part — Agent C)
- **AC#2 DONE.** `get_vault_conventions()` tool returns `getVaultConventions()` verbatim (no scope
  gate — it describes vault shape, not note content). Rich description instructs agents to CALL IT
  FIRST so they stop guessing folders/types (the #1 mis-placement cause).
- Barrel re-export added (`getVaultConventions`, `VaultConventions`, `FolderConvention`,
  `TypeConvention`, `FrontmatterConvention`, `FrontmatterFieldConvention`).
- Tests assert (through the `@lokyy/core` barrel AND e2e through the tool): every `DOC_TYPE`
  present, canonical folders present (`00_meta`, `20_notes`, `30_captures`, `50_decisions`,
  `99_archive`), required frontmatter fields present.

### Change Log
- New conventions module + tests; build green; core tests green for this module.
- MCP `get_vault_conventions` tool wired + barrel re-export + tests. `pnpm -r build` exit 0; mcp
  tests 23 passed.
