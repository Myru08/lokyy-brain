# Story 11.11: Dashboard-View-Typ (Home-Landing)

Status: ready-for-dev

> **Welle 5 — Paket mit 11.10.** Mehrere Slices: **Agent L1** Core/Server
> (`packages/core/src/git/gitService.ts` `vaultActivity`, `packages/core/src/workspace/looseEnds.ts`,
> `server/src/routes/dashboard.ts`), **Agent L2** PWA (`pwa/src/sidebar/views/DashboardView.tsx`).
> Mount/Wrapper (`server/src/index.ts`, `pwa/src/api.ts`) = **Orchestrator-Wireup**.
> **K-3 (verbindlich):** neuer vault-weiter git-Helper `vaultActivity`. Architektur: Addendum §5.

## Story

Als Nutzer möchte ich beim Reinkommen ein Dashboard auf der Main-Fläche, das mir die wichtigsten Vault-Zahlen,
meine Aktivität und offene Punkte auf einen Blick zeigt und von dem aus ich direkt arbeiten kann.

## Acceptance Criteria

1. `DashboardView.tsx` implementiert `ViewRenderer` (ersetzt den `dashboard`-Lazy-Stub aus 11.4), **Bento-Grid**, responsive.
   **Ausrichtung: Vault-Wissens-Cockpit + Entdeckung** — **keine** Projekte/Tasks/Ziele (O-5: Life-OS → separates Lokyy OS).
2. **Gebündelter `GET /api/dashboard`** (`server/src/routes/dashboard.ts`) liefert die billigen Kacheln synchron:
   `counts {notes, byType, tags}`, `health {brokenLinks, brokenTop}`, `recent[]`, `today`, `serendipity`, `system`
   — Schema exakt `DashboardSummary` (Addendum §5), alles aus vorhandenem `queryNotes`/`findBrokenLinks`/`getHealth`.
3. **`GET /api/dashboard/activity?days=365`** (lazy): `{ days[], currentStreak, longestStreak }`. **K-3:** neuer read-only
   Core-Helper `vaultActivity(sinceDays)` in `gitService.ts` — EIN `git log --format=%cI` über HEAD im `serialize`-Lock,
   in-memory zu Tagesbuckets; 60s-Memo-Cache empfohlen. (`noteHistory` ist per-Note und reicht NICHT.)
4. **`GET /api/dashboard/loose-ends?limit=50`** (lazy): `{ items[], total }`. Neuer `packages/core/src/workspace/looseEnds.ts`:
   vault-weiter Walk (wie `dataview.walk`) nach **offenen Checkboxen `^\s*[-*] \[ \]` UND `#todo`** (O-4: beide), mit
   `limit` + 60s-Memo-Cache. (Captures/Archiv-Ausschluss optional — falls als sinnvoll erkannt.)
5. **Konsolidierungs-/Unverarbeitet-Kachel:** reused **bestehendes** `GET /api/agent-review/queue` (Epic 8); **graceful empty
   state**, wenn Epic 8 noch keine Vorschläge liefert (R-1, nicht blockierend).
6. **Quick-Actions / Quick-Capture / Heutiges Journal:** Quick-Capture postet an bestehende `/api/pipes` bzw. Note-Route;
   Journal-Karte → `40_daily` Tagesnotiz (anlegen/öffnen). Kacheln klickbar; Zahlen führen in gefilterte Listen.
7. Lazy geladen (nicht Boot-Pfad). `pnpm -r build` grün; Interceptor-Screenshot des Dashboards.
8. **Anti:** keine MCP-Aufrufe aus der PWA (HTTP-Routen, §0); kein zweiter gitService-berührender Story parallel (R-4);
   keine Telos-/Task-Kachel (O-5).

## Dev Notes
- Teure vs. billige Kacheln getrennt (Addendum §5): `/api/dashboard` synchron, `/activity` + `/loose-ends` lazy + Memo-Cache.
- `vaultActivity` = neuer Helper, read-only, gleiches `serialize`+`git()`-Muster wie `noteHistory` (K-3, R-4).
- Reuse: `/api/agent-review/queue` existiert (mem0/lint/topicNotes). R-1: leer-degradieren.

### References
- [Source: epic-11-architecture-addendum.md §5 + K-3, §7 (R-1/R-4); epic-11-lokyy-workspace.md Story 11.11; 90_ideas/workspace-shell-ux; Entscheidungen 30.05. (Lose Enden = beide, kein Life-OS)]

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### File List
### Change Log
