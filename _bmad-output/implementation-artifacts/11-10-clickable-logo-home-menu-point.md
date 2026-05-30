# Story 11.10: Klickbares Logo → Home-Menüpunkt

Status: ready-for-dev

> **Welle 5 — Paket mit 11.11 (Entscheidung 30.05.: Home + Dashboard zusammen ausliefern).**
> **Agent K**. Header-/Logo-Verdrahtung in `App.tsx` = **Orchestrator-Wireup NACH Batch** (R-3).
> Home ist ein System-Menüpunkt (Datenmodell aus 11.1/§3). Architektur: Addendum §3, §7 (R-2/R-3).

## Story

Als Nutzer möchte ich durch Klick auf das „Lokyy Brain"-Logo immer zur Home-/Start-Ansicht zurückkommen,
damit ich einen festen Orientierungsanker habe.

## Acceptance Criteria

1. Das Logo oben ist klickbar und navigiert zum System-Menüpunkt `system:home` (`viewType:"dashboard"`, `folder:""`).
2. Home ist als `SYSTEM_ITEMS`-Eintrag bereits im Datenmodell (11.1/§3) — diese Story verdrahtet nur Logo→Auswahl,
   legt das Modell **nicht** neu an.
3. **Paket mit 11.11:** beim ersten Klick erscheint sofort ein echter Startbildschirm (das Dashboard aus 11.11),
   **kein** leeres Home. Daher gemeinsam ausliefern.
4. **Anti:** kein `App.tsx`-Edit isoliert parallel (R-3) — Logo-Header-Verdrahtung über den einen Orchestrator-Wireup.
5. `pnpm -r build` grün; Interceptor: Logo-Klick → Dashboard.

## Dev Notes
- `system:home` kommt aus `SYSTEM_ITEMS` (Addendum §3). Auswahl-Mechanik = dieselbe wie Sidebar-Klick (11.3).
- R-2 (Addendum §7): Datenmodell trägt Home/Dashboard schon ab Welle 1; 11.10 kann mit 11.11 in Welle 5 ausgeliefert werden.

### References
- [Source: epic-11-architecture-addendum.md §3, §7; epic-11-lokyy-workspace.md Story 11.10; 90_ideas/workspace-shell-ux; Entscheidung 30.05.]

## Dev Agent Record
### Agent Model Used
Engineer (Claude Opus 4.8) via Workflow `epic11-welle4-5` (Wireup-Phase, 2026-05-30).

### Completion Notes List
- App.tsx-Wireup: Logo klickbar → wählt `system:home` (erster System-Eintrag, `viewType:dashboard`) → `resolveView` rendert die DashboardView in der Main-Fläche. Default-Landing beim Start = Home/Dashboard.
- Paket mit 11.11: funktioniert, sobald der dashboard-Lazy-Import aktiv ist (im 11.11-Finish gesetzt) — keine weitere App.tsx-Änderung nötig.

### File List
- EDIT `pwa/src/App.tsx` (gebündelter Welle-5-Wireup, zusammen mit 11.9)

### Change Log
- 2026-05-30 — Welle 5. `pnpm -r build` grün (Orchestrator-verifiziert). Status → review.
