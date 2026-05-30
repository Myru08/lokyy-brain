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
### Completion Notes List
### File List
### Change Log
