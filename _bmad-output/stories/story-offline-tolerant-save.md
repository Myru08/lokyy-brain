# Story: Offline-toleranter Save bei nicht erreichbarem Forgejo

> **Tracking issue:** https://github.com/oliverhees/lokyy-brain-dev/issues/19

## Kontext

Community-Report (lokale Installation): Wenn der Forgejo-Container nicht läuft/erreichbar ist, meldet der Autosave einen Fehler — obwohl `writeAndSync` den Commit lokal bereits erfolgreich abgesetzt hat. Der Fehler entsteht erst im anschließenden `pull --rebase`/`push` (transienter `GitBackendError` → HTTP 503). Der Nutzer denkt, seine Notiz sei nicht gespeichert; erst ein manueller Sync-Klick „repariert" den Zustand.

Grundsatz bleibt: Forgejo ist die Wahrheit — aber Verfügbarkeit des Remotes darf einen lokal gelungenen Commit nicht als Verlust erscheinen lassen. Vorbild ist `tryDeferredPush` im Idempotenz-Pfad: Commit ist sicher, Push wird nachgeholt.

## Scope / File-Set (dieser Agent besitzt exklusiv)

- `packages/core/src/git/gitService.ts` (writeAndSync, saveBinary, move — Fehlerbehandlung nach Commit)
- `packages/core/src/git/gitService.test.ts`
- `packages/core/src/errors/GitError.ts` (falls neuer Ergebnistyp/Feld nötig)
- `server/src/routes/notes.ts` (Status-Mapping)
- `pwa/src/api.ts` + die Save-Status-Anzeige (Komponente, die Save-Fehler/Erfolg zeigt — NICHT `Editor.tsx`-Extension-Liste, NICHT `App.tsx`-Layout; falls dort eine Zeile Wiring nötig ist, im Ergebnis als WIRING-TODO ausweisen statt editieren)

## Acceptance Criteria

1. **AC1 (Repro-Test zuerst, TDD):** Test in `gitService.test.ts`: Vault mit `origin` auf nicht erreichbare URL (z. B. `http://127.0.0.1:1/dead.git`); `save()` wirft heute → Test dokumentiert neues Soll: resolved mit Ergebnis `{ sha, synced: false }` (Form frei, aber typisiert).
2. **AC2:** `writeAndSync`/`saveBinary`: Nach erfolgreichem Commit führt ein transienter `GitBackendError` aus pull/push NICHT zum Throw, sondern zu Erfolg mit `synced: false` (pending sync). Echte `MergeConflictError`/`PreCommitHookError` werfen weiterhin unverändert.
3. **AC3:** Kein-Remote-Verhalten (`hasRemote()===false`) bleibt exakt wie heute (local commit only, `synced: false` oder äquivalent — Bestandstests grün).
4. **AC4:** `server/src/routes/notes.ts` liefert bei pending sync HTTP 200 mit `synced:false`-Feld im Body; 503 nur noch, wenn schon der Commit scheitert oder ein nicht-transienter Backend-Fehler ohne lokalen Commit vorliegt.
5. **AC5:** PWA zeigt bei `synced:false` einen dezenten Hinweis „Lokal gespeichert – Sync ausstehend" (kein roter Fehler); bei nächstem erfolgreichen Save/Sync verschwindet er.
6. **AC6:** Der bestehende Sync-Button-Flow (`sync()`) holt ausstehende Commits nach (`rev-list`-Push-Pfad existiert schon) — Test, dass nach Wiedererreichbarkeit `sync()` pusht und `changed:true` liefert.
7. **AC7:** `pnpm -r build`, `tsc --noEmit` (server+pwa) und die volle Core-Testsuite grün.

## Nicht-Ziele

Kein Offline-Queue-Umbau, kein Retry-Daemon, keine Änderung der Coalescing-Logik.
