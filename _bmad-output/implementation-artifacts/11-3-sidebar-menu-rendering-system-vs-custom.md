# Story 11.3: Seitenleisten-Rendering (System + Custom Menüpunkte)

Status: ready-for-dev

> **Welle 2.** **Agent D** (`pwa/src/sidebar/Sidebar.tsx` — neu). `App.tsx`-Mount = **Orchestrator-Wireup**
> NACH dem Batch (R-3: App.tsx-Kollision mit 11.9/11.10 vermeiden). Architektur: Addendum §3, §0.

## Story

Als Nutzer möchte ich meine System- und selbst definierten Menüpunkte in der Seitenleiste sehen und
zwischen ihnen wechseln, damit ich meinen Workspace tatsächlich navigieren kann.

## Acceptance Criteria

1. `Sidebar.tsx` rendert die via `api.getMenu()` (11.1) gelieferten Items in Reihenfolge **System zuerst, dann Custom**.
2. Jeder Menüpunkt zeigt Icon + Label; aktiver Punkt ist markiert; Klick wählt ihn → der zugehörige View-Renderer
   (`resolveView(item.viewType)`, 11.4) wird in der Main-Fläche gemountet, mit `item` + `onOpenNote`.
3. System-Items sind als read-only erkennbar (kein Lösch-/Edit-Affordance); Custom-Items haben Edit/Löschen (öffnet 11.2).
4. Ein-/ausklappbare Seitenleiste; aktiver Menüpunkt + Collapse-Zustand der Sidebar selbst in localStorage (Addendum §4-Muster).
5. **Anti:** kein `App.tsx`-Edit in dieser Story (nur neue `Sidebar.tsx`); Mount macht der Orchestrator-Wireup.
6. `pnpm -r build` grün; Interceptor-Screenshot zeigt System- + Custom-Items.

## Dev Notes
- Liest die gemergte Menü-Liste über den `api.getMenu()`-Wrapper (Orchestrator-Wireup aus 11.1). View-Auflösung über
  `resolveView` aus 11.4. `onOpenNote` delegiert an `App.open()`.
- R-3 (Addendum §7): `App.tsx` wird von 11.3/11.9/11.10 berührt → genau ein Wireup-Schritt nach dem parallelen Batch.

### References
- [Source: epic-11-architecture-addendum.md §3, §7 (R-3); epic-11-lokyy-workspace.md Story 11.3]

## Dev Agent Record
### Agent Model Used
Engineer (Claude Opus 4.8) via Workflow `epic11-welle2` (2026-05-30).

### Completion Notes List
- `Sidebar.tsx`: `api.getMenu()` → System-first-then-Custom (defensiver stable-sort), Icon (lucide, kebab→Pascal-Normalisierung + `Circle`-Fallback) + Label, aktiver Punkt hervorgehoben, `onSelectItem`/`onOpenEditor`-Callbacks. System read-only; Custom mit Pencil/Trash2 + Zahnrad. Collapse 240↔56px, State in localStorage (`lokyy:sidebar:*`, K-2).
- Kein App.tsx-Edit (R-3); View-Mounting bleibt Wireup. Props `{activeItemId, onSelectItem, onOpenEditor}`.

### File List
- NEU `pwa/src/sidebar/Sidebar.tsx`

### Change Log
- 2026-05-30 — Welle 2. Eigenständig tsc-clean; via Wireup in App.tsx gemountet; `pnpm -r build` grün (Orchestrator-verifiziert). Status → review.
