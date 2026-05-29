# Story 10.5: Skill-Schema offiziell + `get_skill_schema()` + Template

Status: ready-for-dev

> Welle 2. Core = **Agent B** (`packages/core/src/skills/` — `getSkillSchema()`-Export); MCP-Tool =
> **Agent C** (`mcp/src/server.ts`). Das Vault-Template `00_meta/templates/skill.md` liegt im
> separaten Vault-Repo → hier NICHT schreiben; stattdessen Template-Inhalt als Teil der
> `get_skill_schema`-Antwort ausliefern (Seed ins Vault ist Follow-up).

## Story

Als KI-Agent, der einen Vault-Skill anlegen will, möchte ich `get_skill_schema()`, das mir das
Skill-Frontmatter-Schema **plus ein Beispiel** liefert, damit ich Skills korrekt in **einem** Call
anlege (zusammen mit Story 10.2 entfällt der Catch-22) statt das Schema per Trial & Error zu erraten.

## Acceptance Criteria

1. **Core (Agent B):** `getSkillSchema()` exportiert `{ schema, example, fieldDocs }` —
   `schema` = das (bereits existierende) Skill-Frontmatter-Schema (`frontmatter/schemas/skill.json`
   bzw. die Skill-Parser-Erwartung in `skills/index.ts`), `example` = ein vollständiger
   Beispiel-Skill (Frontmatter + Body), `fieldDocs` = Kurzbeschreibung je Pflicht-/Optionalfeld
   (`skill_name`, `title`, `description`, `execution: client|server`, `input_schema`, `allowed_tools`).
2. **MCP (Agent C):** `get_skill_schema()`-Tool gibt das Objekt zurück, mit Hinweis: Skill in einem
   Call via `create_note({ type:"skill", ... })` anlegbar (dank Story 10.2). `{{var}}`-Substitution
   in `run_skill` ist bereits vorhanden (`renderPrompt`) — in `fieldDocs`/Description erwähnen.
3. **Konsistenz:** `example` validiert gegen `schema` und ist via `validateSkillInput`/`parseSkill`
   tatsächlich ladbar (kein erfundenes Schema).
4. **Tests:** `getSkillSchema()` liefert Schema+Beispiel; das Beispiel parst als gültiger Skill.
   `pnpm -r build` grün.
5. **Anti:** kein neues Template-System erfinden (Substitution existiert); kein Schreiben ins
   Vault-Repo aus dieser Story.

## Dev Notes

- Skill-Logik: `parseSkill` `skills/index.ts:56-87`, `validateSkillInput` `:157-205`, `renderPrompt`
  `:98-117` (rendert `{{var}}` — Doc-Annahme „1:1" war falsch). Schema-Datei
  `frontmatter/schemas/skill.json`. `DOC_TYPES` enthält `skill`.
- Template-Seed (`00_meta/templates/skill.md`) als Follow-up notieren (Vault = separates Repo; ggf.
  via `server/src/setup/seedSkills.ts` in einem späteren Schritt).

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 2.4; Investigation 2026-05-29 (renderPrompt substituiert {{var}})]

## Dev Agent Record
### Agent Model Used
Claude Opus 4.7 (Engineer agent — CORE part only; MCP tool wiring is Agent C's job).

### Completion Notes List
- **Core part (Agent B) DONE.** Added `getSkillSchema()` to `packages/core/src/skills/index.ts`
  returning `{ schema, example, fieldDocs }` (types `SkillSchemaInfo`, `SkillFieldDoc` exported).
- **Real schema (AC#1/AC#5):** `schema` is the live `frontmatter/schemas/skill.json` imported
  with `with { type: "json" }` (same pattern `frontmatter/index.ts` uses) — no re-invented
  schema, no new template system.
- **Example actually parses (AC#3):** `EXAMPLE_SKILL` is a complete frontmatter+body note that
  validates via `validateFrontmatter(data,"skill")` AND round-trips through the existing
  `parseSkill`; proven by tests. Its `skill_name` matches `^[a-z0-9-]+$`, ULID is 26 chars.
- **{{var}} reflected (AC#2):** the example body uses `{{days}}`/`{{topic}}` (from
  `input_schema`) and the `{{today}}` built-in, and `fieldDocs.input_schema` explicitly states
  the keys become `{{tokens}}` substituted by `run_skill` (`renderPrompt`) — correcting the
  doc's earlier "1:1" assumption. A test renders the example via `renderPrompt` to prove it.
- `fieldDocs` covers all required fields (`id,type,title,skill_name,description,created,updated`)
  plus optionals (`execution,input_schema,allowed_tools,output,tags`).
- AC#2 MCP tool (returns the object + create_note-in-one-call hint) is Agent C's scope.
- Template-seed into the Vault repo (`00_meta/templates/skill.md`) remains a Follow-up (Vault is
  a separate repo) — the template content ships as `example` in the response per the story note.

### File List
- `packages/core/src/skills/index.ts` (added `getSkillSchema`, `SkillSchemaInfo`, `SkillFieldDoc`,
  skill.json import)
- `packages/core/src/skills/skills.test.ts` (added `getSkillSchema` describe block)
- `packages/core/src/index.ts` (MCP-wiring agent: barrel re-export of `getSkillSchema` +
  `SkillSchemaInfo` + `SkillFieldDoc`, added to the existing skills export block)
- `mcp/src/server.ts` (MCP-wiring agent: `get_skill_schema` ListTools entry + CallTool case)
- `mcp/src/server.test.ts` (MCP-wiring agent: payload + e2e tests)

### Completion Notes List (MCP part — Agent C)
- **AC#2 DONE.** `get_skill_schema()` tool returns `getSkillSchema()` verbatim. Description tells
  agents a skill is creatable in ONE call via `create_note({ type:"skill", ... })` (using the
  returned example shape) and that a skill's `input_schema` keys become `{{var}}` tokens that
  `run_skill` substitutes (`renderPrompt`).
- Barrel re-export added (`getSkillSchema`, `SkillSchemaInfo`, `SkillFieldDoc`) — `parseSkill`,
  `renderPrompt`, `validateSkillInput`, `listSkillNotes` were already exported; no duplicate-export
  collision.
- Tests assert the example contains `type: skill`, carries a `{{var}}` token, and that `fieldDocs`
  cover `skill_name`/`description`/`input_schema` (via the barrel AND e2e through the tool).

### Change Log
- `getSkillSchema()` + tests; build green; skills tests green (17 incl. new ones).
- MCP `get_skill_schema` tool wired + barrel re-export + tests. `pnpm -r build` exit 0; mcp tests
  23 passed.
