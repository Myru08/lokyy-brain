# Story 11.6: Skill-Creator-Skill (Vault-Seed)

Status: ready-for-dev

> **Welle 3 — parallel/jederzeit (reiner Vault-Seed, keine Code-Files).** **Agent G**.
> Nutzt das bestehende Skill-System (Epic 9) + `00_meta/templates/skill.md` (Story 10.5).

## Story

Als Nutzer möchte ich einen „Skill-Creator"-Skill, der mich durch das Anlegen eines neuen Skills führt
(Titel, Ausführungsbefehl/Name, Prompt) und daraus eine SPEC-valide Skill-Note schreibt — wie Claudes Skill-Creator.

## Acceptance Criteria

1. Neue Skill-Note `70_pai/skills/skill-creator.md` mit gültigem Skill-Frontmatter (`type: skill`, `skill_name`,
   `title`, `description`, `execution: client`, `input_schema`, `allowed_tools`) — Schema gemäß `get_skill_schema` (10.5).
2. `input_schema` erfasst: `skill_title`, `skill_name` (lowercase-kebab), `run_command`/Name, `prompt_body`
   (+ optional `allowed_tools`, `input_fields`).
3. Der gerenderte Prompt weist den Agent an, via `create_note` mit `type: "skill"` (10.2 erlaubt das direkt) eine
   SPEC-valide Skill-Note nach `70_pai/skills/<skill_name>` zu schreiben und das Schema aus `get_skill_schema` einzuhalten.
4. **Verifikation:** `list_skills` zeigt `skill-creator`; `run_skill` rendert den Prompt mit eingesetzten Variablen;
   ein damit erzeugter Test-Skill ist `list_skills`-sichtbar + SPEC-valide.
5. **Anti:** kein Zwei-Call-Workaround (create→update) — `type: skill` direkt (10.2). Keine Code-Änderung im `mcp`/`server`.

## Dev Notes
- Skill-Frontmatter-Schema: `get_skill_schema` (Story 10.5). `create_note type:skill` ist seit 10.2 ohne Umschreiben gültig.
- Reiner Vault-Seed → läuft über `gitService` (SPEC-valides Frontmatter zwingend).

### References
- [Source: epic-11-lokyy-workspace.md Story 11.6; Epic 9; Story 10.2, 10.5; 90_ideas/dynamische-seitenleisten-menuepunkte]

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### File List
### Change Log
