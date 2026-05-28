# Story 9.3: MCP-Meta-Tools `list_skills` + `run_skill`

Status: backlog

> Abhängigkeit: **9-2** (Parser/Renderer in core).

## Story

Als KI-Agent, der über den lokyy-brain-MCP-Server verbunden ist,
möchte ich `list_skills`- und `run_skill`-Tools,
damit ich Vault-Skills entdecken und einen gefüllten Prompt erhalten kann, den ich mit meinen eigenen Tool-Calls ausführe.

## Acceptance Criteria

1. `list_skills()` MCP-Tool liefert `{ skills: SkillSummary[] }`, wobei jede Summary = `{ skill_name, title, description, input_schema?, execution, allowed_tools }`, bezogen via `listSkillNotes` aus `@lokyy/core`.
2. `run_skill({ skill_name, input? })` MCP-Tool: lädt den Skill, validiert `input` gegen `input_schema` (Defaults angewendet), rendert den Prompt, liefert `{ ok: true, skill_name, prompt, allowed_tools, output? }`.
3. `run_skill`-Fehlerformen (`ok: false`): `skill-not-found`, `invalid-input` (mit Feld-Fehlern), `server-execution-not-supported` (bei `execution: server` — Phase 1 nur client).
4. Beide Tools respektieren `mcp-scopes.yaml`: der Agent braucht Read-Scope für den Pfad der Skill-Notes; out-of-scope → bestehender strukturierter Scope-Violation-Fehler (PRD Q4 — Skills erben Caller-Scope, kein neues Permission-Modell).
5. Die Tool-LISTE bleibt statisch (nur diese zwei Meta-Tools ergänzt) — keine Per-Skill-Tools, kein `list_changed`-Churn (Architektur "Warum Meta-Tools").
6. Verifiziert von einem echten MCP-Client (stdio): `list_skills` zeigt die Seed-Skills; `run_skill({skill_name:"wochenrueckblick", input:{days:14}})` liefert einen Prompt, der "14" enthält; falscher Name → `skill-not-found`; `execution: server`-Skill → `server-execution-not-supported`.
7. `pnpm --filter @lokyy/mcp build` + `pnpm -r build` grün.
8. **Anti:** `run_skill` ruft KEIN LLM und schreibt KEINE Notes — es liefert nur das Execution-Payload; die aufrufende KI führt aus (Execution-Modell v1 = client).

## Tasks / Subtasks

- [ ] `list_skills`-Tool in `mcp/src` registrieren (an `listSkillNotes` anbinden)
- [ ] `run_skill`-Tool: load → validate-input → render → payload
- [ ] Fehlerformen gemäß AC#3
- [ ] Scope-Check via Story-7.2-Resolver
- [ ] stdio-Verifikation gemäß AC#6
- [ ] Build grün

## Dev Notes

- MCP-Tools liegen in `mcp/src/*` neben read_note/search_vault/etc (siehe Story 7.3/7.4/7.7 für das Tool-Registrierungs-Pattern + Scope-Resolver-Nutzung).
- `allowed_tools` ist in v1 advisory (PRD Q3) — in der Response ausgeben und (optional) eine Zeile an den Prompt voranstellen ("Du darfst nur diese Tools nutzen: ..."); out-of-allowlist-Calls NICHT blockieren (kein Per-Skill-Session-State in v1).
- Scope-Resolver aus Story 7.2 wiederverwenden — Skill-Notes sind nur Notes; ihr Lesen läuft bereits durch Scope-Globs.
- `run_skill` rein/schnell/seiteneffektfrei halten (PRD Q2).

### References

- [Source: skills-prd-phase1.md — Story S3 + run_skill-Contract + Q3/Q4]
- [Source: skills-architecture.md — "MCP-Tool-Exposure: Meta-Tools"]
- [Source: Stories 7.2 (Scope-Resolver), 7.3/7.7 (Tool-Pattern)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

### Change Log
