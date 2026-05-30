# Story 11.8: PWA-Share-Target + YouTube-JSON-Bugfix

Status: ready-for-dev

> **Welle 4.** **Agent I** (`pwa/src/share/ShareTarget.tsx` — neu; `pwa/vite.config.ts` — Manifest).
> Route `/share` + `api.share()` = **Orchestrator-Wireup** (`main.tsx`, `api.ts`).
> **K-4 (verbindlich):** KEIN neuer Server-Endpoint — `POST /api/pipes/share` existiert bereits. Architektur: Addendum §6.
> Verarbeitung bleibt **Epic 6**.

## Story

Als Nutzer möchte ich aus anderen Apps Inhalte (YouTube-Links, Webseiten, Bilder, Text) an Lokyy-Brain teilen,
damit sie in der Inbox landen — mit klarer Quittung statt rohem JSON.

## Acceptance Criteria

1. **Manifest:** `pwa/vite.config.ts` (`vite-plugin-pwa` → `manifest`) bekommt einen `share_target`-Block
   (`action:"/share"`, `method:"POST"`, `enctype:"multipart/form-data"`, params `title/text/url/files[image,pdf]`) — exakt Addendum §6.
2. **Empfangs-Screen:** `pwa/src/share/ShareTarget.tsx` sammelt den geteilten Inhalt, posted an `api.share(...)`
   (dünner Wrapper auf **bestehendes** `POST /api/pipes/share`).
3. **YouTube-JSON-Bugfix:** der Screen zeigt **niemals** die Roh-JSON-Antwort, sondern eine Quittung
   „In Inbox aufgenommen — {title|url}" + Link „Inbox öffnen" (Import-Panel). Falls die Roh-JSON-Anzeige aus einem
   bestehenden Pfad in `ImportPanel.tsx`/`api.ts` kommt: dort Job-Antwort in Statusmeldung mappen, nicht stringify-en.
4. **Kein neuer Server-Endpoint** (K-4); optionaler dünner Alias `/api/share` erlaubt, aber nicht Kern.
5. Manuell/Interceptor verifiziert: geteiltes YouTube-Video landet als Inbox-Item, Quittung statt JSON. `pnpm -r build` grün.
6. **Anti:** keine Verarbeitungslogik hier (gehört Epic 6); kein Bearbeiten von `pipes.ts`/`pipeQueue.ts`.

## Dev Notes
- Vorhanden (Addendum §6): `POST /api/pipes/share` (multipart + JSON → `enqueue`), `SharePayload`/`PipeType`/`detectType`/
  `enqueue`/`registerHandler` in `packages/core/src/pipes/pipeQueue.ts`. Gap = nur Frontend.
- `vite.config.ts` ist geteilte Config → allein in dieser Story berühren (keine andere Welle-4-Story).

### References
- [Source: epic-11-architecture-addendum.md §6 + K-4; epic-11-lokyy-workspace.md Story 11.8; 90_ideas/share-to-inbox-pipeline; Epic 6]

## Dev Agent Record
### Agent Model Used
Engineer (Claude Opus 4.8) via Workflow `epic11-welle4-5` (2026-05-30).

### Completion Notes List
- Frontend-only (K-4): `share_target`-Manifest (§6 verbatim). Da ein POST-Share-Target von einer reinen SPA nicht direkt lesbar ist, Standard-Pattern: SW-Snippet `public/share-sw.js` (via `workbox.importScripts`) fängt den POST /share, parkt die FormData (inkl. File) im Cache, 303→GET /share. `ShareTarget.tsx` liest die geparkte Payload (GET-Query-Fallback), `api.share()`, zeigt IMMER Quittung „In Inbox aufgenommen — {title|url}" + „Inbox öffnen" — nie Roh-JSON (YouTube-Bugfix).
- `api.share()` dünner Wrapper auf bestehendes POST /api/pipes/share (kein neuer Endpoint). `main.tsx` branched auf `/share` vor der App-Shell. ImportPanel mappt Job-Status bereits (kein Edit nötig).
- OS-Share-Geste nur mit installierter PWA + Server testbar (nicht im Sandbox).

### File List
- NEU `pwa/src/share/ShareTarget.tsx`, `pwa/public/share-sw.js` · EDIT `pwa/vite.config.ts`, `pwa/src/api.ts`, `pwa/src/main.tsx`

### Change Log
- 2026-05-30 — Welle 4. `pnpm -r build` grün (Orchestrator-verifiziert). Status → review.
