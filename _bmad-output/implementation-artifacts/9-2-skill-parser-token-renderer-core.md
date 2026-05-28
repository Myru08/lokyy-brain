# Story 9.2: Skill-Parser + Token-Renderer in `@lokyy/core`

Status: backlog

> Abhängigkeit: **9-1** (Schema/Type muss existieren). Selbes Package wie 9-1 → strikt nach 9-1.

## Story

Als Entwickler
möchte ich, dass `@lokyy/core` eine Skill-Note in ein typisiertes `SkillDef` parst und ihren Prompt mit `{{token}}`-Substitution rendert,
damit die MCP-Schicht Skills auflisten und gefüllte Prompts erzeugen kann, ohne das Parsing neu zu implementieren.

## Acceptance Criteria

1. `packages/core/src/skills/index.ts` exportiert `parseSkill(raw: string): SkillDef` — trennt Frontmatter (nutzt `parseFrontmatter`) + validiert als `skill`-Type + liefert `{ skill_name, title, description, execution, allowed_tools, input_schema?, output?, prompt }`, wobei `prompt` der Body unter dem Frontmatter ist.
2. `renderPrompt(skill: SkillDef, input?: Record<string, unknown>): string` — ersetzt `{{key}}`-Tokens gegen einen flachen Kontext: Input-Parameter (nach Anwendung der `input_schema`-Defaults) + Built-ins `{{today}}` (YYYY-MM-DD), `{{user}}`, `{{vault_root}}`. Unbekannte Tokens bleiben verbatim. Keine Conditionals/Loops (PRD Q1).
3. `listSkillNotes(vaultRoot): Promise<SkillDef[]>` liest alle `type: skill`-Notes (aus `70_pai/skills/` bzw. beliebigem Pfad), überspringt fehlerhafte mit geloggtem Warning (wirft NIE wegen eines defekten Skills).
4. `validateSkillInput(skill, input): { ok, errors? }` prüft Input gegen `input_schema` (type + required), wendet Defaults an.
5. `SkillDef` aus `packages/core/src/index.ts` re-exportiert.
6. Unit-Tests: gültigen Skill parsen; `{{user}}`/`{{today}}`/`{{days}}` füllen; fehlendes Token bleibt verbatim; Default angewendet, wenn Input `days` weglässt; fehlerhaftes Frontmatter → `parseSkill` wirft typisierten Fehler, `listSkillNotes` überspringt ihn; literales `{{` überlebt, wenn kein bekanntes Token.
7. `pnpm --filter @lokyy/core build` + test grün.
8. **Anti:** Kein MCP-Wiring hier (9-3); keine Netzwerk-/LLM-Calls — reine Funktionen + Vault-Read.

## Tasks / Subtasks

- [ ] `parseSkill` (Frontmatter-Split + Validierung als `skill`)
- [ ] `renderPrompt` (Minimal-`{{token}}`-Engine + Built-ins)
- [ ] `listSkillNotes` (Vault-Walk, defekte überspringen)
- [ ] `validateSkillInput` (Defaults + Required-Check)
- [ ] `SkillDef` Typ + Re-Export aus `core/src/index.ts`
- [ ] Vitest-Fälle gemäß AC#6
- [ ] Build + test grün

## Dev Notes

- Token-Engine bewusst minimaler String-Replace (PRD-Q1-Entscheidung). Implementierung als einzelne Regex `/\{\{\s*([\w.]+)\s*\}\}/g` mit Lookup; Miss → Original-Match zurückgeben.
- Built-ins: `today` aus `new Date().toISOString().slice(0,10)`; `user` aus Config/Env (PAI-Principal-Name bzw. Vault-Owner — an das anbinden, was Story 3.x bereitstellt; Fallback `""`); `vault_root` aus der Core-Config.
- `listSkillNotes` nutzt denselben Vault-File-Walk wie graphService/notesService wieder — NICHT von Grund auf neu walken; vorhandenes tree/list-Utility bevorzugen.
- Kein Context-Preloading (PRD Q2) — `render` liefert nur den Prompt-String; die KI holt Daten selbst.

### References

- [Source: skills-prd-phase1.md — Story S2 + Q1/Q2]
- [Source: skills-architecture.md — Prompt-Templating-Abschnitt]
- [Source: Story 1.5 — `parseFrontmatter`/`validateFrontmatter` in `@lokyy/core`]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

### Change Log
