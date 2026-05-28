# Skills — PRD Phase 1 (Client-Execution Foundation)

> Status: **PRD**. Derived from `skills-architecture.md` (strategy). Resolves the
> 5 open questions, scopes Phase 1, breaks it into implementable stories with
> acceptance criteria. 2026-05-28.
>
> Phase 1 goal: skills as vault-notes, exposed via MCP meta-tools, executed by
> the calling AI (client-side). No server-side LLM, no scheduling, no in-app
> buttons — those are Phase 2.

## Resolved open questions

### Q1 — Prompt-Templating-Engine → **Minimal `{{token}}` substitution, no logic**
Decision: a tiny string-replace of `{{key}}` tokens against a flat context map
(input params + a small set of vault built-ins like `{{today}}`, `{{user}}`,
`{{vault_root}}`). **No conditionals, no loops, no partials.** Rationale: skill
prompts are instructions to a reasoning model — the model handles branching
logic itself. A templating language would be re-inventing what the LLM already
does. If a skill needs conditional behavior, it writes that into the prose
("If there are no meetings this week, say so and stop").

Unknown tokens are left verbatim (so a literal `{{` in a prompt survives).

### Q2 — Context-Preloading → **No preloading in v1; the AI loads via allowed_tools**
Decision: `run_skill` returns the rendered prompt + allowed_tools + output
convention, but does **not** pre-fetch vault data. The calling AI uses its tool
budget to `search_vault` / `read_note` as the prompt directs. Rationale: keeps
`run_skill` a pure, fast, side-effect-free call; avoids guessing what data the
skill needs; the AI is already good at fetching. Preloading is a Phase-2
optimization (`preload:` frontmatter directive) once we see real latency pain.

### Q3 — allowed_tools Enforcement → **Advisory in v1, with a documented path to hard**
Decision: `allowed_tools` is surfaced to the AI in the run_skill response and in
the prompt ("Du darfst nur diese Tools nutzen: ..."), but the MCP server does
**not** block out-of-allowlist calls during a skill run in v1. Rationale: hard
enforcement needs per-session skill-run state in the MCP server (track "we are
inside skill X, reject tool Y"), which is real complexity for a single-user
trust context. The existing `mcp-scopes.yaml` already caps what any agent can do
(Q4) — that's the real security boundary. Hard per-skill enforcement is a
Phase-3 hardening if multi-tenant / untrusted-skill scenarios arise.

### Q4 — Skill-Permissions → **Skills inherit the calling agent's mcp-scopes**
Decision: a skill can never do more than its caller. Since skills execute
client-side via the same MCP connection, every tool call already passes through
the agent's `mcp-scopes.yaml` read/write globs. No separate skill-permission
model. A skill that tries to write outside the agent's scope gets the same
structured scope-violation error any direct call would. This is clean and needs
zero new code.

### Q5 — Skills location/visibility → **Normal notes, `type: skill`, visible in tree**
Decision: skills live as ordinary notes under `70_pai/skills/`, with
`type: skill`, fully visible in the file tree, searchable, editable in the CM6
editor. Rationale: "skills are data you own and edit" is the whole point —
hiding them contradicts it. The `type: skill` lets the MCP server filter them and
lets the UI badge them. They're excluded from normal semantic-search results for
*content* queries only if it proves noisy (defer; likely fine).

## Phase 1 scope (in / out)

**In:**
- `type: skill` added to the SPEC + a JSON schema `00_meta/schemas/skill.json`
- Skill parser in `@lokyy/core` (frontmatter → `SkillDef`, `{{token}}` renderer)
- MCP meta-tools `list_skills` + `run_skill` (client-execution only)
- MCP `instructions` text updated to announce skills
- 4 seed skills shipped in the vault scaffold (one per use-case class)
- Settings → Skills tab reads real vault skills (replaces the hardcoded array),
  with an "open in editor" link

**Out (Phase 2+):**
- Server-side execution (`execution: server`)
- Scheduling / cron
- In-app skill buttons in the PWA
- Context preloading
- Hard allowed_tools enforcement
- Individual per-skill MCP tools

## Data contracts

### Skill frontmatter (`type: skill`)
```yaml
id: <ULID>
type: skill
title: <human title>
skill_name: <unique kebab id, validated ^[a-z0-9-]+$>
description: <one paragraph — the AI reads this in list_skills to choose>
execution: client        # Phase 1: only 'client' accepted; 'server' rejected with clear error
allowed_tools: [search_vault, read_note, create_note, ...]   # subset of the 6 vault tools
input_schema:            # optional JSON-schema-ish; properties with type + default
  type: object
  properties: { days: { type: number, default: 7 } }
output:                  # optional — convention surfaced verbatim in run_skill return
  folder: 70_pai/digests
  type: note
  path_pattern: "{YYYY-MM-DD}-wochenrueckblick"
created / updated: <auto>
```
Body below frontmatter = the prompt (with `{{tokens}}`).

### `list_skills()` → returns
```json
{ "skills": [
  { "skill_name": "wochenrueckblick", "title": "...", "description": "...",
    "input_schema": {...}, "execution": "client", "allowed_tools": [...] }
]}
```

### `run_skill({ skill_name, input? })` → returns
```json
{ "ok": true,
  "skill_name": "wochenrueckblick",
  "prompt": "<rendered prompt with tokens filled>",
  "allowed_tools": ["search_vault","read_note","create_note"],
  "output": { "folder": "70_pai/digests", "type": "note", "path_pattern": "..." }
}
```
Or `{ ok: false, error: 'skill-not-found' | 'invalid-input' | 'server-execution-not-supported', message }`.

The calling AI receives this, then executes the prompt using its own tool calls.

## Story breakdown (Phase 1)

> Each is a BMAD dev-story candidate. Acceptance = builds green + criteria below.

**S1 — SPEC + schema for `type: skill`**
- Add `skill` to the closed doc-type list in the SPEC doc + vault contract
- New `00_meta/schemas/skill.json` validating the skill frontmatter
- pre-commit hook accepts valid skill notes, rejects malformed ones
- AC: a hand-written skill note commits; one with bad `skill_name` is rejected

**S2 — Skill parser + token renderer in @lokyy/core**
- `parseSkill(noteBody) → SkillDef` (frontmatter + prompt split)
- `renderPrompt(skillDef, input) → string` ({{token}} substitution, built-ins
  today/user/vault_root, input params, unknown tokens verbatim)
- `listSkillNotes()` reads all `type: skill` notes from the vault
- Unit tests for parse + render edge cases
- AC: tests green incl. missing-token, default-value, malformed-frontmatter

**S3 — MCP meta-tools list_skills + run_skill**
- `list_skills` tool: returns the SkillDef summaries
- `run_skill` tool: validates input against input_schema, renders prompt,
  returns the execution payload. Rejects `execution: server` with a clear
  "not supported in this version" error.
- Both respect mcp-scopes (skill notes must be readable by the agent)
- AC: from an MCP client, list_skills shows seed skills; run_skill returns a
  filled prompt; bad skill_name → skill-not-found

**S4 — MCP instructions update**
- Append to the initialize-time `instructions`: skills exist, use list_skills →
  run_skill, then execute the returned prompt with the listed tools
- AC: initialize response contains the skill guidance

**S5 — Seed skills in vault scaffold**
- 4 skills written into the Setup-Wizard's vault-init scaffold:
  `wochenrueckblick` (summary), `capture-to-todos` (extraction),
  `zk-steward` (graph), `research-capture` (ingest)
- AC: a freshly-initialized vault contains all 4 under 70_pai/skills/

**S6 — Settings Skills tab reads real skills**
- Replace the hardcoded `/api/admin/skills` array with a read of `type: skill`
  notes from the vault
- Each skill card: title, description, skill_name, allowed_tools, "open in
  editor" link, "wie aufrufen" hint (e.g. 'Sag zu Claude: run_skill
  wochenrueckblick')
- AC: editing a skill note in the editor updates what the Settings tab shows

## Dependencies / sequencing

```
S1 (schema) ──▶ S2 (parser) ──▶ S3 (MCP tools) ──▶ S4 (instructions)
                          └────▶ S6 (settings tab)
S5 (seed skills) depends on S1 (schema must exist to validate them)
```
S1 first. Then S2 + S5 in parallel. Then S3 → S4. S6 after S2.

## Success criteria for Phase 1

A user connects Claude via the lokyy-brain MCP, says "run my Wochenrückblick",
Claude calls list_skills → run_skill → receives the prompt → executes it with
search_vault + create_note → a structured digest note appears in
70_pai/digests/. The user can open the skill note in the editor, tweak the
prompt, and the next run uses the edited version — all with zero redeploy.
