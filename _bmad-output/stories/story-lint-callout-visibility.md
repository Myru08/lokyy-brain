# Story: Widerspruchs-Warnkasten in Notiz + Editor-Callout-Rendering (Paket B)

> **Tracking issue:** https://github.com/oliverhees/lokyy-brain-dev/issues/21

## Kontext

Lint-Erkennung (Widersprüche u. a.) läuft, `/api/lint/findings` (server/src/routes/lint.ts) ist komplett — aber die Funde sind unsichtbar: kein Kasten in der Notiz, der CM6-Editor kann Callouts nicht rendern, kein Auflösen-Flow. Ziel: „Roter Kasten mitten in der Notiz. Mit beiden Aussagen. Oliver entscheidet."

## Scope / File-Set (dieser Agent besitzt exklusiv)

- `packages/core/src/lint/**` (Callout-Writer)
- `server/src/routes/lint.ts` (Resolve-/Write-Endpunkt ergänzen)
- `pwa/src/editor/callouts.ts` (NEU) + zugehörige Tests (vitest+jsdom vorhanden)
- `pwa/src/LintFindingsPanel.tsx` (NEU)
- NICHT editieren: `pwa/src/editor/Editor.tsx` Extension-Liste, `App.tsx` (Wiring macht der Wire-up-Agent — im Ergebnis als WIRING-TODO mit exakter Zeile ausweisen), `gitService.ts` (nur Save-API aufrufen)

## Acceptance Criteria

1. **AC1 — Kasten schreiben:** Neuer Core-Schritt: Für ein offenes Finding wird ein Markdown-Callout-Block (`> [!warning] Widerspruch …` mit beiden Aussagen + Quell-Wikilinks + Finding-ID als Kommentar) idempotent in die betroffene Notiz geschrieben (über gitService-Save-API, SPEC-Frontmatter unangetastet, `updated` via saveNote-Pfad). Kein Doppel-Kasten bei erneutem Lauf (Finding-ID-Anker).
2. **AC2 — Editor-Rendering:** CM6 rendert `> [!warning]`/`> [!info]`-Callout-Blöcke farbig abgesetzt. ZWINGEND als Block-Decoration via **StateField, nicht ViewPlugin** (bekannter Runtime-RangeError, den der Build nicht fängt — Memory cm6_block_decoration_statefield). Test mit EditorView (vitest+jsdom) vorhanden.
3. **AC3 — Auflösen:** Aktion am Kasten/Panel „Auflösen": markiert Finding via bestehender Lint-API als resolved UND entfernt den Kasten aus der Notiz (ein Commit). Regel im UI-Text: „Quelle reparieren, nicht nur Kasten löschen" — Auflösen verlangt Auswahl, welche Aussage gilt (oder „beide ok").
4. **AC4 — Liste:** `LintFindingsPanel` zeigt alle offenen Funde (Notiz, beide Aussagen, Alter), Klick öffnet die Notiz.
5. **AC5:** Editor-Tests + Core-Tests + `pnpm -r build` + `tsc --noEmit` grün; keine Regression in bestehenden Editor-Tests.
6. **AC6:** WIRING-TODO-Block im Abschlussbericht: exakte Import-/Registrierungszeilen für Editor.tsx-Extension-Liste und View-Registrierung.

## Nicht-Ziele

Keine neuen Lint-Regeln, kein Umbau der Erkennung, kein Scheduler.
