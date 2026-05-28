# Story 9.1: SPEC + JSON-Schema für `type: skill`

Status: ready-for-dev

## Story

Als Vault-Maintainer
möchte ich `skill` als vollwertigen Doc-Type mit JSON-Schema und Commit-Zeit-Validierung,
damit Skill-Notes exakt wie jede andere Note validiert werden und fehlerhafte Skills abgelehnt werden, bevor sie den Vault erreichen.

## Acceptance Criteria

1. `skill` ist zur geschlossenen `DocType`-Union in `packages/core/src/frontmatter/types.ts` hinzugefügt.
2. `packages/core/src/frontmatter/schemas/skill.json` validiert das Skill-Frontmatter: `id` (ULID 26-Zeichen-Regex), `type` const `"skill"`, `title` (string), `skill_name` (string, Pattern `^[a-z0-9-]+$`), `description` (string), `execution` (enum `["client","server"]`, default `"client"`), `allowed_tools` (array of string), `input_schema` (object, optional), `output` (object {folder,type,path_pattern}, optional), `created`/`updated` (ISO-8601 date-time). Required: `id`, `type`, `title`, `skill_name`, `description`, `created`, `updated`.
3. Die Per-Type-Validator-Map in `frontmatter/index.ts` registriert den `skill`-Validator; `validateFrontmatter(data, 'skill')` liefert ok für einen gültigen Skill und lehnt ab: fehlerhaftes `skill_name` (Großbuchstaben/Leerzeichen), fehlende `description`, falsches `type`.
4. Eine Kopie des Schemas landet im Vault-Scaffold unter `00_meta/schemas/skill.json` (Setup-Wizard Vault-Init-Quelle), damit der Vault-Pre-Commit-Hook Skill-Notes identisch validiert.
5. Unit-Tests (Vitest) decken ab: gültiger client-Skill Round-Trip; `skill_name` mit Großbuchstaben abgelehnt; `skill_name` mit Leerzeichen abgelehnt; fehlende `description` abgelehnt; `execution: server` vom Schema AKZEPTIERT (Phase-1-Gating passiert in `run_skill`, nicht im Schema); `output`-Block round-trippt.
6. CLAUDE.md-Abschnitt "Vault Contract (SPEC)" geschlossene Liste um `skill` ergänzt (**Orchestrator-eigener Edit** — nicht vom Dev-Agent).
7. `pnpm -r build` grün; `pnpm --filter @lokyy/core test` grün.
8. **Anti:** KEINE Parser/Renderer-Logik und KEIN MCP-Tool in dieser Story (das sind 9-2 und 9-3).

## Tasks / Subtasks

- [ ] **(Orchestrator)** `skill` zur SPEC-Liste in CLAUDE.md "Vault Contract" ergänzen
- [ ] `'skill'` zur `DocType`-Union ergänzen (`frontmatter/types.ts`)
- [ ] `packages/core/src/frontmatter/schemas/skill.json` schreiben
- [ ] Skill-Validator in der Validator-Map registrieren (`frontmatter/index.ts`)
- [ ] Schema in den Setup-Wizard Vault-Init-Scaffold als `00_meta/schemas/skill.json` kopieren
- [ ] Vitest-Fälle gemäß AC#5
- [ ] `pnpm -r build` + core-test grün

## Dev Notes

- Schema spiegelt die bestehenden Doc-Type-Schemas (siehe Story 1.5). Basis-Required-Felder wiederverwenden, skill-spezifische Felder ergänzen.
- `execution` ist ab Tag 1 im Schema (`client` default, `server` erlaubt), damit Phase-2-Server-Execution rein additiv ist (siehe skills-prd-phase1.md, Abschnitt "Out (Phase 2+)"). Phase 1 LEHNT `execution: server` zur Laufzeit ab (Story 9-3), nicht bei der Schema-Validierung.
- `allowed_tools` ist in Phase 1 advisory (PRD Q3) — das Schema validiert nur, dass es ein String-Array ist; kein Enum-Lock auf die 6 Vault-Tools (Forward-Compat für künftige Tools).
- Wo der Setup-Wizard Vault-Init-Dateien schreibt: den Vault-Scaffold-Writer aus Story 1.10/1.11 (Setup-Endpoints / Wizard) finden. Das `00_meta/schemas/`-Verzeichnis ist Teil dieses Scaffolds.

### References

- [Source: skills-prd-phase1.md — "Data contracts: Skill frontmatter", Story S1]
- [Source: skills-architecture.md — "Skill-Definition (Frontmatter-Schema)"]
- [Source: Story 1.5 — bestehendes Schema- + Validator-Pattern in `@lokyy/core`]
- [Source: CLAUDE.md "Vault Contract (SPEC)" — geschlossene Doc-Type-Liste]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

### Change Log
