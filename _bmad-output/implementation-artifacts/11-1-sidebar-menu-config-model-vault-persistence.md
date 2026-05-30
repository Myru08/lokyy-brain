# Story 11.1: Menü-Config-Modell + Vault-Persistenz

Status: ready-for-dev

> **Welle 1.** Core = **Agent A** (`packages/core/src/workspace/menuConfig.ts`); Server-Route =
> **Agent B** (`server/src/routes/workspace.ts`). Beide editieren NUR ihre neuen Files. Mounting in
> `server/src/index.ts` + `pwa/src/api.ts`-Wrapper = **Orchestrator-Wireup** nach dem Batch.
> Architektur verbindlich: Addendum §1 + §3.

## Story

Als Nutzer möchte ich, dass meine selbst definierten Seitenleisten-Menüpunkte dauerhaft und
geräteübergreifend gespeichert werden, damit mein Workspace nach Reload und auf anderen Geräten
gleich aussieht.

## Acceptance Criteria

1. **Core (Agent A):** Neuer Service `packages/core/src/workspace/menuConfig.ts` mit Typen
   `ViewType = "tree"|"skills"|"dashboard"`, `MenuItem { id, label, icon, folder, viewType, shortcut, kind }`,
   `MenuConfig { version, items }` (exakt wie Addendum §1).
2. **Persistenz:** Datei `00_meta/sidebar-menu.yaml` im Vault. `read()` macht `git.pull()` → parse → validieren →
   System-Defaults mergen (§3) → `MenuConfig`. `write(customItems)` validiert, serialisiert **nur `kind:"custom"`** und
   schreibt **ausschließlich via `gitService.save()`** (kein direkter fs-Write), Commit-Prefix `workspace:`.
3. **O-1-Verifikation:** Vor Merge prüfen, dass der lokyy-vault pre-commit-Hook eine frontmatter-lose `.yaml` in
   `00_meta/` durchlässt (Präzedenz: `00_meta/mcp-scopes.yaml` wird bereits committet). Falls er blockt → Fallback
   `00_meta/sidebar-menu.json`, Schema identisch.
4. **Validierung:** `ajv` (bereits Core-Dep `ajv@8.20.0`) gegen neues `00_meta/schemas/sidebar-menu.schema.json`.
   Invalider Read → **System-Defaults zurückgeben + `console.error`**, niemals crashen.
5. **System-Defaults (§3):** `SYSTEM_ITEMS` als Code-Konstante (`system:home`/dashboard, `system:skills`/skills),
   immer vor Custom gemerged; werden **nie** in die YAML geschrieben.
6. **Server (Agent B):** `server/src/routes/workspace.ts` — `GET /api/workspace/menu` → gemergte Liste;
   `PUT /api/workspace/menu` ← `{items}`, **verwirft serverseitig jedes `kind:"system"`** vor Persistenz, ruft
   `menuConfig.write(custom)`. Flache Route (kein `:vaultId`), camelCase-JSON.
7. **Tests:** read/write Roundtrip, System-Merge, System-Item-Reject im PUT, invalider YAML → Defaults. `pnpm -r build` grün.
8. **Anti:** kein direkter fs-Write; System-Items nie persistiert; kein `:vaultId` in der Route.

## Dev Notes

- Lese-/Schreibmuster wie `dataview.queryNotes` (pull-first über `coreConfig().vaultDir`). `gitService.save()` ist der
  einzige Schreibweg. Siehe Addendum §1 (Schema + HTTP), §3 (Merge/Schutz).
- Realität (Addendum §0): Routen sind flach + single-vault; PWA hat keinen MCP-Client.

### References
- [Source: epic-11-architecture-addendum.md §1, §3; epic-11-lokyy-workspace.md Story 11.1; 90_ideas/dynamische-seitenleisten-menuepunkte]

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### File List
### Change Log
