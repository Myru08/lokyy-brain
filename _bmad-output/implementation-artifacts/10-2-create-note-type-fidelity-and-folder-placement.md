# Story 10.2: `create_note` Type-Treue (kein stilles Umschreiben) + Type→Ordner-Ableitung/-Validierung

Status: ready-for-dev

> Hot-Fix-Welle. Behebt den Skill-Catch-22 (Doc 2.3/2.4) **und** die Ordner-Fehlplatzierung
> (Vorgespräch + Doc 2.1).
> **Konfliktfreie Files (NUR diese editieren):** `packages/core/src/notes/notesService.ts`,
> `mcp/src/server.ts` und zugehörige Tests. NICHT `memory/*`, `db/*`, `gitService.ts` anfassen
> (gehört Story 10.1).

## Story

Als KI-Agent, der über MCP Notes anlegt, möchte ich, dass `create_note` meinen `type` **exakt
übernimmt oder mit klarer Meldung ablehnt** (niemals still umschreibt) und mir den **kanonischen
Ordner aus dem `type` ableitet bzw. eine Fehlplatzierung erkennt, damit Notes deterministisch am
richtigen Ort mit dem richtigen Typ landen — ohne dass ich die Vault-Konventionen erraten muss.

## Kontext / korrigierte Root-Cause

- **Skill-Catch-22 (Doc 2.4):** `create_note` mit `type:"skill"` landet still als `type:"note"`.
  **Korrigierte Verortung:** der Core (`createNote`, `notesService.ts:304-321`) erlaubt
  `type:skill` (in `DOC_TYPES`, `frontmatter/types.ts:30`, Schema `schemas/skill.json` vorhanden).
  Der Fehler ist die **MCP-Schicht**: das `create_note`-inputSchema-Enum (`mcp/src/server.ts:152-164`)
  **lässt `skill` (und `peer`) weg**, und der Handler defaultet `args.type ?? "note"`
  (`server.ts:254`). MCP-SDK 1.x validiert `arguments` nicht gegen das inputSchema (advisory).
  Ergebnis: ein gemeldeter, aber nicht enum-konformer Typ wird stillschweigend verschluckt; ein
  korrekt als `skill` gemeinter Typ ist über das Tool gar nicht erst sauber meldbar →
  `list_skills` (matcht `type:skill`, `skills/index.ts:254`) findet die Note nicht.
- **Ordner-Fehlplatzierung (Doc 2.1 + Vorgespräch):** `createNote` nimmt einen **freien** `path`
  und koppelt ihn **nirgendwo** an `type` (`notesService.ts:304-372`). Die einzige Leitplanke ist
  Prosa im MCP-`instructions`-String und der Tool-Description — advisory, nicht erzwungen. Eine KI
  kann `type:capture` problemlos nach `20_notes/x` schreiben.

## Acceptance Criteria

1. **Kein stilles Umschreiben:** `create_note` übernimmt einen gültigen `type` 1:1. Ein ungültiger
   `type` wird mit strukturiertem Fehler **abgelehnt** (`{ error: "invalid-type", got, allowed: [...] }`),
   niemals still auf `note` gemappt. `type:skill` ist gültig und wird durchgereicht.
2. **Type-Enum vollständig:** das `create_note`-inputSchema-Enum (`mcp/src/server.ts:152-164`)
   listet **alle** `DOC_TYPES` aus `@lokyy/core` (`frontmatter/types.ts`), inkl. `skill`. Single
   source of truth: Enum aus `DOC_TYPES` ableiten statt Handpflege (kein Drift).
3. **Type→Ordner-Ableitung:** Es gibt eine kanonische Map `type → folder` (z.B. `note→20_notes`,
   `capture→30_captures`, `project→10_projects`, `decision→50_decisions`, `task→…`,
   `intervention→70_pai/interventions`, `skill→70_pai/skills`, …). Die exakte Map gegen den realen
   Vault verifizieren (siehe Dev Notes — `list_tree`/`00_meta` prüfen) und an **einer** Stelle in
   `@lokyy/core` definieren (wiederverwendbar für Story 10.4 `get_vault_conventions`).
4. **Pfad-Ableitung wenn weggelassen:** Ruft der Client `create_note` mit `type` + `slug` (ohne
   vollständigen `path`), leitet der Server den kanonischen Pfad ab: `{folder}/{slug}` bzw. das
   datierte Muster `{folder}/{YYYY-MM-DD}-{slug}` wo der Ordner es vorsieht (captures/sessions).
5. **Pfad-Validierung wenn angegeben:** Wird ein voller `path` übergeben, der dem `type`
   widerspricht (Ordner ≠ kanonischer Ordner und kein erlaubter Unterordner wie
   `30_captures/youtube/`), antwortet der Server mit strukturiertem Korrektur-Fehler
   (`{ error: "type-folder-mismatch", type, expectedFolder, gotPath }`) statt stiller Fehlablage.
   Erlaubte Unterordner unter dem kanonischen Top-Ordner bleiben zulässig.
6. **Skill-Anlage in einem Call:** `create_note({ type:"skill", path/slug, body, title })` erzeugt
   eine Note, die `list_skills` sofort findet — der bisherige Zwei-Call-Workaround
   (create→update) entfällt. (Per Verifikation gegen `listSkillNotes`.)
7. **Verifikation (stdio MCP-Client):** `create_note` mit jedem Typ legt korrekt ab; ungültiger
   Typ → `invalid-type`; widersprüchlicher Pfad → `type-folder-mismatch`; `type:skill` →
   in `list_skills` sichtbar. `pnpm -r build` grün; bestehende notes-Tests grün.
8. **Anti:** Keine Änderung an `memory/*`, `db/*`, `gitService.ts`. Bestehende REST-Route
   `POST /api/vault/note` darf nicht brechen (gleiche `createNote`-Signatur respektieren;
   Ableitung/Validierung so bauen, dass die Route weiter funktioniert — additive Opts).

## Tasks / Subtasks

- [ ] Kanonische `type→folder`-Map + erlaubte Unterordner in `@lokyy/core` (eine Quelle) — AC#3
- [ ] `createNote` um Ableitung (Pfad aus type+slug) + Validierung (mismatch) erweitern, additiv — AC#3/4/5
- [ ] `mcp/src/server.ts`: Enum aus `DOC_TYPES` generieren, `skill` inkl.; `?? "note"` durch
      strikte Validierung ersetzen (`invalid-type`); `path` optional, `slug` akzeptieren — AC#1/2/4/5
- [ ] Strukturierte Fehler `invalid-type` / `type-folder-mismatch` — AC#1/5
- [ ] Tests: Type-Treue, Skill-One-Call, Ableitung, Mismatch-Reject; REST-Route-Regress — AC#6/7/8
- [ ] Builds grün — AC#7

## Dev Notes

- **Fundstellen:** `createNote` `notesService.ts:304-372` (Default `?? "note"` bei :321 greift nur
  bei `undefined`, kein Coerce); `CreateNoteOpts` `:276`; `DOC_TYPES` `frontmatter/types.ts:10-31`;
  MCP-Enum `server.ts:152-164`; MCP-Handler-Default `server.ts:254`; `saveNote`-Merge (Type-Präzedenz
  `:164`) `notesService.ts:137-213`; `list_skills`-Filter `skills/index.ts:254`.
- **Ordner-Map verifizieren:** Die kanonische Top-Level-Struktur aus dem realen Vault bestätigen,
  bevor die Map hartkodiert wird — `list_tree` zeigt `00_meta, 10_projects, 20_notes, 30_captures,
  50_decisions, 70_pai/…, 90_ideas, 99_archive` (+ `35_tools` existiert real). Falls eine
  `00_meta/SPEC`-Note die Ordner definiert, daraus ableiten statt raten. Diese Map wird in Story
  10.4 (`get_vault_conventions`) wiederverwendet — sauber als exportierte Konstante/Funktion bauen.
- **MCP-SDK:** `setRequestHandler(CallToolRequestSchema)` validiert `arguments` NICHT automatisch —
  die Validierung muss explizit im Handler passieren (kein Verlass auf das inputSchema-Enum).
- **Pipe-Handler-Kompatibilität:** Captures landen unter `30_captures/{urls,youtube,voice,pdfs}/`
  (CLAUDE.md Vault-Contract) — diese Unterordner müssen als erlaubt gelten (AC#5).
- **Backwards-compat:** REST `POST /api/vault/note` (`server/src/routes/vault.ts:73`) ruft dasselbe
  `createNote`; Erweiterung additiv halten (optionales `slug`, Validierung tolerant für bereits
  korrekte volle Pfade).

### References

- [Source: 90_ideas/lokyy-mcp-gaps — Sektion 2.1/2.3/2.4, korrigiert durch Code-Investigation 2026-05-29]
- [Source: Vorgespräch 2026-05-29 — Type→Ordner deterministisch statt Prompt]
- [Source: Story 1.6 (createNote SPEC-Frontmatter), 9.3 (list_skills)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

### Change Log
