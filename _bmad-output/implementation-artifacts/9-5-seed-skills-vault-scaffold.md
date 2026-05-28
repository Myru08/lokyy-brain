# Story 9.5: Seed-Skills im Vault-Scaffold

Status: backlog

> Abhängigkeit: **9-1** (Schema muss existieren, um die Seeds zu validieren).

## Story

Als neuer lokyy-brain-User
möchte ich vier fertige Skills in meinem frisch initialisierten Vault,
damit Skills ab Tag eins nützlich sind, ohne dass ich selbst welche schreiben muss.

## Acceptance Criteria

1. Der Setup-Wizard Vault-Init-Scaffold schreibt vier `type: skill`-Notes unter `70_pai/skills/`: `wochenrueckblick` (periodische Summary), `capture-to-todos` (Capture-Veredelung), `zk-steward` (Knowledge-Graph-Pflege), `research-capture` (externe Daten) — einer pro Use-Case-Klasse (Architektur "Beispiel-Skills").
2. Jeder Seed-Skill hat vollständiges schema-valides Frontmatter (besteht das Story-9-1-`skill.json`-Schema) und einen echten Prompt-Body mit `{{tokens}}`.
3. Jeder deklariert ein sinnvolles `allowed_tools`-Subset und (wo passend) eine `output`-Konvention + `input_schema`.
4. Verifiziert: ein frisch initialisierter Vault (Wizard/Vault-Init ausführen) enthält alle vier Dateien; `list_skills` (Story 9-3) liefert alle vier.
5. `pnpm -r build` grün.
6. **Anti:** Seeds werden nur beim Vault-Init erstellt; ein erneutes Init darf einen vom User editierten bestehenden Skill NICHT überschreiben (idempotentes create-if-absent).

## Tasks / Subtasks

- [ ] 4 Skill-Notes verfassen (deutsch, mit `{{tokens}}`)
- [ ] In den Scaffold-Writer einhängen (`00_meta/schemas/` Nachbarschaft)
- [ ] Idempotentes create-if-absent
- [ ] Via frisches Init + `list_skills` verifizieren
- [ ] Build grün

## Dev Notes

- Vault-Scaffold-Writer ist der Setup-Wizard Vault-Init-Pfad (Story 1.10/1.11). Seeds liegen neben dem `00_meta/schemas/skill.json` aus Story 9-1.
- `id` via `generateUlid()` erzeugen; `created`/`updated` setzen. Das Frontmatter MUSS das 9-1-Schema bestehen, sonst lehnt der Vault-Pre-Commit-Hook den Seed-Commit ab.
- Prompts auf Deutsch halten (passt zum Beispiel in skills-architecture.md und der Arbeitssprache des Users).
- create-if-absent: Pfad-Existenz vor dem Write prüfen, damit User-Edits ein Re-Init überleben (AC#6).

### Seed-Skill-Vorlagen (Richtwert)

- `wochenrueckblick` — `allowed_tools: [search_vault, read_note, create_note]`, `input_schema.days` default 7, `output.folder: 70_pai/digests`.
- `capture-to-todos` — liest `30_captures/`, erzeugt `type: task`-Notes; `allowed_tools: [search_vault, read_note, create_note]`.
- `zk-steward` — findet Orphans/fehlende Wikilinks, schlägt Verbindungen vor; `allowed_tools: [search_vault, read_note, list_tree, update_note]`.
- `research-capture` — Web-Research → Capture-Note in `30_captures/`; `allowed_tools: [search_vault, create_note]`.

### References

- [Source: skills-prd-phase1.md — Story S5]
- [Source: skills-architecture.md — "Beispiel-Skills" + Seed-Absatz]
- [Source: Story 1.10/1.11 — Setup-Wizard Vault-Init-Scaffold]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

### Change Log
