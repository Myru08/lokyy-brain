# Story 10.6: Git-Sync — Idempotenz-Check, Error-Klassifikation, `gitBranch`-Trim

Status: ready-for-dev

> Welle 2. **Agent A (Git-Cluster).** Konfliktfreie Files (NUR diese):
> `packages/core/src/git/gitService.ts`, `packages/core/src/util/coreConfig.ts`,
> `server/src/config.ts`, `server/src/routes/notes.ts` (+ Tests).
> NICHT `mcp/src/*`, NICHT `notesService.ts`, NICHT `memory/*`/`db/*` anfassen.

## Story

Als Nutzer/Agent, der unter Last in den Vault schreibt, möchte ich, dass ein benigner
Git-Sync-Race **nicht** als „Merge-Konflikt" gemeldet wird, wenn mein Inhalt bereits sauber auf
Disk liegt, und dass echte Fehlertypen (Pre-Commit-Hook-Ablehnung vs. echter Konflikt vs.
Backend-Fehler) klar unterschieden werden, damit der Client sinnvoll reagieren kann.

## Kontext / Root-Cause (aus Investigation, bestätigt)

- **False-positive „Merge-Konflikt":** `gitService.ts:255-270` (analog `saveBinary` `:313-327`, `move`
  `:360-371`) fängt **jede** Rejection von `git pull --rebase --autostash` und meldet hartkodiert
  „Merge-Konflikt" + `git rebase --abort`. Der Commit (`:248`) ist da aber schon gelandet → Inhalt
  liegt sauber auf Disk, API gibt trotzdem 409. Korreliert mit Schreibfrequenz, nicht Inhalt.
- **`fatal: Cannot rebase onto multiple branches`:** Command-Args `["pull","--rebase","--autostash",
  "origin", gitBranch]` (`gitService.ts:217` u.a.). Ursache: ungetrimmter/ungültiger `gitBranch`
  (z.B. `"main "` oder ein `branch.main.merge` mit zwei Refs) → zwei Refspecs. `gitBranch` kommt aus
  `GIT_BRANCH`-Env / `vaults`-Row (`server/src/config.ts:26`, Default `"main"`), nie getrimmt/validiert.
- **Keine Idempotenz-Prüfung:** Nach fehlgeschlagenem Pull kein Re-Read/Vergleich, ob der Inhalt
  schon HEAD/Disk entspricht. Einzige „schon gespeichert"-Prüfung ist `git status --porcelain`
  **vor** dem Pull (`:243-246`).
- **Keine Error-Typisierung:** `FrontmatterValidationError` existiert (pre-git geworfen), aber
  Git-stderr wird nie geparst — Pre-Commit-Hook-Ablehnung, Netz, Auth, echter Konflikt fallen alle
  in einen generischen „Merge-Konflikt"-Error; Route `server/src/routes/notes.ts:78-87` mappt alles
  auf 409.

## Acceptance Criteria

1. **`gitBranch`-Trim/Validierung:** der Branch-Wert wird beim Laden getrimmt und auf ein einzelnes
   gültiges Ref-Token validiert (kein Whitespace, kein zweites Token). Quelle: `util/coreConfig.ts`
   und `server/src/config.ts`. Ungültiger Wert → klarer Fehler beim Boot/Config-Load, nicht erst im
   `pull`. Damit ist `Cannot rebase onto multiple branches` aus dieser Quelle ausgeschlossen.
2. **Idempotenz vor „Merge-Konflikt":** schlägt `git pull --rebase --autostash` fehl, prüft der
   Code **bevor** er einen Konflikt-Fehler wirft, ob der beabsichtigte Inhalt bereits auf Disk/HEAD
   liegt (z.B. file-content-Vergleich bzw. `git status` sauber + Datei == gewünschter Content). Wenn
   ja → kein Fehler, Erfolg (ggf. Push retryen/aufschieben). Gilt für `save`, `saveBinary`, `move`.
3. **Error-Klassifikation:** Git-stderr wird geparst und in distinkte, typisierte Fehler übersetzt:
   - Pre-Commit-Hook-Ablehnung (Vault-Frontmatter-Hook) → eigener Typ (z.B.
     `PreCommitHookError` / reuse `FrontmatterValidationError`-Familie), **nicht** „Merge-Konflikt".
   - Echter Merge-/Rebase-Konflikt → `MergeConflictError`.
   - Netz/Auth/sonst → `GitBackendError` (transient-Flag wo erkennbar).
4. **Route-Mapping:** `server/src/routes/notes.ts` mappt die typisierten Fehler auf passende
   HTTP-Codes/Bodies (Pre-Commit → 422 mit Validierungsdetails; echter Konflikt → 409;
   Backend/transient → 503 mit Retry-Hinweis) statt pauschal 409.
5. **Lock unangetastet lassen / nicht verschlechtern:** die bestehende `serialize()`-Promise-Lock
   (`:31-38`) bleibt; keine neue Race einführen. (Backend-Write-Queue/Debounce ist Story 10.12 —
   hier NICHT umsetzen.)
6. **Tests:** Branch-Trim (Whitespace/Doppel-Token abgelehnt); Idempotenz (simulierter
   Pull-Fail bei bereits-korrektem Disk-Content → kein Fehler); stderr-Klassifikation für die 3
   Fälle. `pnpm -r build` grün; bestehende git/notes-Tests grün.
7. **Anti:** keine Schema-/MCP-Änderung; `move`/`saveBinary` müssen weiter funktionieren; kein
   `--no-verify` o.Ä. (Pre-Commit-Hook bleibt scharf).

## Tasks / Subtasks

- [ ] `gitBranch`-Trim+Validierung in `util/coreConfig.ts` + `server/src/config.ts` — AC#1
- [ ] Idempotenz-Check im Pull-Fehlerpfad von `save`/`saveBinary`/`move` — AC#2
- [ ] stderr-Parser → typisierte Fehler (`PreCommitHookError`/`MergeConflictError`/`GitBackendError`) — AC#3
- [ ] Route-Status-Mapping in `routes/notes.ts` — AC#4
- [ ] Tests — AC#6
- [ ] Builds grün — AC#7

## Dev Notes

- Fundstellen: `save` `gitService.ts:234-270`, `saveBinary` `:293-327`, `move` `:355-371`, `pull`
  `:215-217`, `remove` `:336-340`, `git()` `:41-54`, lock `:31-38`, pre-pull-`status` `:243-246`;
  Route `server/src/routes/notes.ts:78-87`; Branch-Default `server/src/config.ts:26`.
- `FrontmatterValidationError` liegt unter `packages/core/src/errors/` — neue Git-Fehlertypen dort
  anlegen (Agent A darf `errors/` für NEUE Git-Fehler-Files nutzen; `FrontmatterValidationError.ts`
  selbst nicht umschreiben).
- Pre-Commit-Hook-stderr enthält typischerweise den Hook-Pfad/`frontmatter`-Hinweis — daran erkennbar.
- `setupVaultFromForgejo` kann ein `branch.<x>.merge` mit zwei Refs hinterlassen → Trim allein
  reicht ggf. nicht; defensiv im `pull` die Args explizit als zwei getrennte argv-Elemente halten
  (sind sie schon) und den Branch-Wert hart auf ein Token begrenzen.

### References

- [Source: 90_ideas/lokyy-mcp-gaps — Sektion 4, korrigiert/bestätigt durch Investigation 2026-05-29]
- [Source: Story 1.3 (gitService in core), CLAUDE.md Vault-Contract (Pre-Commit-Hook)]

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### File List
### Change Log
