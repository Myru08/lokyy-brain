# Epic 12 — Ordner-Skills (Anthropic Agent Skills Format)

Status: in-progress

> **Quelle:** [[90_ideas/ordner-skills-struktur-anthropic-format]] (Feedback 30.05.) — Skills sollen Strukturen übernehmen können wie der `lokyy-agent` auf claude.ai: ein Skill = Ordner mit `SKILL.md` + `references/` + `templates/`.

## Ziel
Lokyy unterstützt **Ordner-Skills** (Anthropic-Format) zusätzlich zu den bestehenden Einzel-Note-Skills. Ein Skill kann eine Struktur tragen (Haupt-`SKILL.md` + Begleit-Docs), die SkillsView zeigt sie, und bestehende Anthropic-Skills lassen sich importieren.

## Ist-Zustand (verbindlich für Design)
`packages/core/src/skills/index.ts`: `listSkillNotes(vaultRoot)` walkt `70_pai/skills/` rekursiv, liest jede `.md`, filtert `type: skill`, parst via `parseSkill` → `SkillDef`. `run_skill` (mcp) gibt nur den gerenderten `SKILL.md`-Body. Skills sind heute EINZELNE `.md`-Dateien.

## Design-Entscheidungen (Alice)
1. **Skill = Ordner mit `SKILL.md`.** Discovery erkennt `70_pai/skills/<name>/SKILL.md` (type:skill) als EINEN Skill und sammelt seine Begleit-Files. **Einzel-Note-Skills (`<name>.md`) bleiben unterstützt** (rückwärtskompatibel — Phase-1-Skills wie skill-creator).
2. **`SkillDef` erweitern** um `basePath`, `references: {path, title}[]`, `templates: {path}[]` — damit UI + run_skill die Struktur kennen. Optional/leer bei Einzel-Note-Skills.
3. **Begleit-`.md`-Frontmatter** (Vault-Contract: jede `.md` braucht Frontmatter): Begleit-Docs unter `references/` bekommen **`type: reference`**-Frontmatter (contract-treu, kein Hook-Eingriff). Beim **Import** (12.3) von Anthropic-Skills, die kein Frontmatter haben, wird es automatisch injiziert. Non-`.md` (z.B. `templates/dashboard.jsx`) sind vom Frontmatter-Hook nicht betroffen.
4. **run_skill / progressive disclosure:** liefert weiterhin den `SKILL.md`-Prompt PLUS die Liste der reference-Pfade als Hinweis („lade bei Bedarf via read_note") — KEIN automatisches Einbetten (Anthropic-Pattern: SKILL.md ist die Eingangstür).
5. **Discovery-Hygiene:** Begleit-`.md` (type:reference) sind kein `type:skill` → werden ohnehin nicht als eigene Skills geladen.

## Stories
| Story | Titel | Kern-Files |
|-------|-------|-----------|
| **12.1** | **Core: Ordner-Skill-Discovery** — `SKILL.md`-Ordner erkennen, `SkillDef` um references/templates/basePath erweitern, run_skill liefert reference-Pfade; Einzel-Note-Skills bleiben gültig | `packages/core/src/skills/index.ts` (+ test), `mcp/src/server.ts` (run_skill-Antwort) |
| **12.2** | **SkillsView-Strukturansicht** — Ordner-Skills mit Baum (SKILL.md + references/templates) darstellen, wie die claude.ai-Ansicht | `pwa/src/sidebar/views/SkillsView.tsx` |
| **12.3** | **Import** — bestehende Anthropic-Skills (Ordner + SKILL.md + references) in den Vault importieren, Frontmatter-Injektion für Begleit-`.md` | Import-Pfad (PWA + ggf. core/notes) |

## Definition of Done
`pnpm -r build` grün · pro Story Test (Lehre: Build allein fängt Runtime/Loading-Fehler nicht) · Einzel-Note-Skills bleiben funktionsfähig (Regression vermeiden) · `list_skills`/`run_skill` liefern Ordner-Skills korrekt.

## Reihenfolge
12.1 (Core, Fundament) → 12.2 (UI) → 12.3 (Import). 12.2/12.3 bauen auf 12.1.
