# Story 11.9: Einheitliches Aufklapp-Fähnchen-/Collapse-Pattern

Status: ready-for-dev

> **Welle 5.** **Agent J** (`pwa/src/panels/CollapsiblePanel.tsx` — neu, + ggf. Inline-Hook).
> `App.tsx`-Umhüllung der Panels = **Orchestrator-Wireup NACH Batch** (R-3). **K-2 (verbindlich):**
> Open/zu-State in **localStorage**, NICHT im Vault. Architektur: Addendum §4.

## Story

Als Nutzer möchte ich, dass Panels standardmäßig geschlossen sind und über ein Fähnchen an der Kante
aufklappbar sind — und dann die volle Fläche nutzen —, damit immer das Wichtige im Fokus ist statt alles gleichzeitig.

## Acceptance Criteria

1. `CollapsiblePanel.tsx` mit Props `{ id, title, icon?, side:"left"|"right", defaultOpen?, children }` (exakt Addendum §4).
2. **Default geschlossen** (`defaultOpen` Default `false`); umhüllt bestehende Panels (`TagPane`/`Outline`/`BacklinksPanel`)
   **unverändert** (ersetzt keine Logik).
3. **K-2:** Open/zu pro Panel in `localStorage["lokyy:panel:<id>"]` ("1"/"0"), gleiches try/catch-Muster wie
   `useResizableWidth`. **Kein Vault, kein Forgejo-Commit** pro Toggle.
4. Geschlossen → Fähnchen/Tab an der `side`-Kante; Klick öffnet auf **volle, scroll-/suchbare** Fläche; erneuter Klick schließt.
5. **Anti:** kein `App.tsx`-Edit hier (nur die Wrapper-Komponente + Tests); Verdrahtung = Orchestrator-Wireup nach Batch (R-3).
6. `pnpm -r build` grün; Interceptor-Screenshot: Panel zu mit Fähnchen, dann aufgeklappt.

## Dev Notes
- Präzedenz für localStorage-UI-State: `useResizableWidth` (Key `lokyy:resize:*`). Addendum §4 begründet Hybrid-Regel
  (Fenster-Zustand → localStorage; *was es gibt* → Vault).
- R-3 (Addendum §7): `App.tsx` von 11.3/11.9/11.10 berührt → genau ein Wireup-Schritt nach dem Batch.

### References
- [Source: epic-11-architecture-addendum.md §4 + K-2, §7 (R-3); epic-11-lokyy-workspace.md Story 11.9; 90_ideas/workspace-shell-ux]

## Dev Agent Record
### Agent Model Used
Engineer (Claude Opus 4.8) via Workflow `epic11-welle4-5` (2026-05-30).

### Completion Notes List
- `CollapsiblePanel.tsx`: Props `{id,title,icon?,side,defaultOpen?,children}` (§4 verbatim), default geschlossen. State in `localStorage["lokyy:panel:<id>"]` ("1"/"0", try/catch wie `useResizableWidth`) — K-2, nicht Vault. Geschlossen → 32px-Fähnchen an der `side`-Kante; offen → volle scroll-/suchbare Fläche, Children unverändert. aria-expanded/-label.
- App.tsx-Umhüllung der bestehenden Panels = Wireup-Schritt (R-3).

### File List
- NEU `pwa/src/panels/CollapsiblePanel.tsx`

### Change Log
- 2026-05-30 — Welle 5. tsc + `pnpm -r build` grün; via Wireup in App.tsx verdrahtet. Status → review.
