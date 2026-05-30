# Story 11.4: View-Typ-Registry (Frontend) + TreeView

Status: ready-for-dev

> **Welle 1.** **Agent C** (`pwa/src/sidebar/views/registry.ts`, `pwa/src/sidebar/views/TreeView.tsx`).
> **K-1 (verbindlich):** legt `SkillsView.tsx`/`DashboardView.tsx` **NICHT** an — nur Registry + TreeView +
> Lazy-Stub-Verweise. Architektur: Addendum §2.

## Story

Als Entwickler möchte ich eine geschlossene Registry, die einem Menüpunkt anhand seines `viewType` einen
Renderer zuordnet, damit das Leitprinzip „Menüpunkt = (Ordner) + (View-Typ)" generisch funktioniert.

## Acceptance Criteria

1. `pwa/src/sidebar/views/registry.ts`: `ViewProps { item: MenuItem; onOpenNote: (noteId)=>void }`,
   `ViewRenderer = ComponentType<ViewProps>`, statisches `VIEW_REGISTRY: Record<ViewType, ViewRenderer>` und
   `resolveView(viewType)` mit Default-Fallback `tree` (exakt Addendum §2).
2. **Statisch, kein Plugin-System** — kein Laufzeit-`register()`.
3. `TreeView.tsx` (echt): umhüllt die bestehende `FileTree.tsx`-Logik mit `folder`-Scope (ersetzt sie **nicht**),
   reicht `onOpenNote` an `App.open()` durch.
4. **K-1:** `skills`/`dashboard` werden als `React.lazy`-Importe referenziert; solange die Dateien (11.5/11.11) fehlen,
   liefert die Registry einen Inline-„Coming soon"-Fallback. 11.4 erstellt diese Dateien NICHT.
5. `DashboardView`/`SkillsView` lazy (wie `GraphView` in `App.tsx`) — nicht auf dem Boot-Pfad.
6. **Tests:** `resolveView` mappt korrekt, unbekannt → tree. `pnpm -r build` grün.
7. **Anti:** keine `SkillsView.tsx`/`DashboardView.tsx` anlegen (Kollision mit 11.5/11.11); `MenuItem`-Typ aus PWA-Inline
   (core ist node-only, Addendum §0).

## Dev Notes
- `MenuItem`/`ViewType` werden in der PWA inline gespiegelt (core node-only). Addendum §2 hat das Interface.
- `lazy()`-Praxis: siehe bestehendes `GraphView`-Lazy in `App.tsx`.

### References
- [Source: epic-11-architecture-addendum.md §2 + K-1; epic-11-lokyy-workspace.md Story 11.4]

## Dev Agent Record
### Agent Model Used
Engineer (Claude Opus 4.8) via Workflow `epic11-welle1` (2026-05-30).

### Completion Notes List
- `registry.ts` (§2): inline-gespiegelte `MenuItem`/`ViewType` (kein core-Import, §0), `ViewProps`, statisches `VIEW_REGISTRY` (Record über die geschlossene Union → Compiler erzwingt Vollständigkeit), `resolveView()` mit `?? tree`-Fallback. Kein Laufzeit-`register()`.
- **K-1 eingehalten:** `SkillsView.tsx`/`DashboardView.tsx` NICHT angelegt — nur als Lazy-`ComponentType` mit Inline-„Coming soon"-Fallback (via `createElement`, damit `registry.ts` `.ts` bleibt) referenziert; TODO-Kommentare markieren die späteren Lazy-Importe für 11.5/11.11.
- `TreeView.tsx`: komponiert die bestehende `FileTree` (unverändert) mit `folder`-Scope; `scopeToFolder()` mit graceful „Ordner nicht gefunden"; `onOpen`→`onOpenNote`; nur lokales `activeId` fürs Highlighting, kein eigener Router/Editor-State.

### File List
- NEU `pwa/src/sidebar/views/registry.ts`, `…/TreeView.tsx`, `…/registry.test.ts` (5/5 grün)

### Change Log
- 2026-05-30 — Welle 1. `tsc --noEmit` clean; `pnpm --filter pwa build` grün; `pnpm -r build` grün (Orchestrator-verifiziert). Status → review. Mount in App.tsx bleibt Scope 11.3.
