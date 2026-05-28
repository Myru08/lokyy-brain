# Skills-Architektur — Strategy Doc

> Status: **Strategy / pre-PRD**. Brainstorm-Output 2026-05-28. Noch keine Story.
> Entscheidungen hier sind die Grundlage für die spätere Epic-Zerlegung.
> Vorgänger-Kontext: aktuelle "Skills" sind ein hardcoded JSON-Array in
> `server/src/routes/admin.ts:505` — reine Doku-Karten die auf PAI/Claude-Code-
> Built-ins verweisen, tun selbst nichts, nicht erweiterbar.

## Problem

Die heutigen "Empfohlenen PAI Skills" (Knowledge, Telos, ZK Steward, Research)
sind:
- **Statisch** — hardcoded im Server-Code, neuer Skill = Code-Deploy
- **Funktionslos** — nur `description` + `howToUse` + `examplePrompt`, keine Ausführung
- **Fremd** — verweisen auf PAI/Claude-Code-Built-ins, nicht auf lokyy-brain. Ein
  lokyy-brain-User ohne PAI-Setup kann mit null davon was anfangen.

Ziel: Skills die **tatsächlich etwas tun**, **mit dem MCP-Server mitkommen**
(zero extra install), **erweiterbar ohne Redeploy** sind, und sowohl
KI-getrieben als auch (Phase 2) standalone laufen können.

## Kern-Entscheidung: Skills = Vault-Notes, MCP-Server ist der Träger

Skills sind `.md`-Notes im Vault unter `70_pai/skills/`. Der lokyy-mcp-Server
liest sie und exposed sie über MCP. Damit:

- **Distribution gelöst**: Wer den lokyy-brain-MCP in Claude installiert, kriegt
  alle Skills automatisch mit. Kein separater Skill-Install pro Skill (anders als
  PAI heute).
- **Daten statt Code**: Neuer Skill = neue Note. Kein Redeploy. Editierbar im
  PWA-Editor. Versioniert in Forgejo. User schreiben eigene Skills.
- **Composable**: Die KI entdeckt Skills via `list_skills`, führt aus via
  `run_skill`.

### Warum nicht reine MCP-Tools (hardcoded server-side)?

Würde "alle Use-Cases" + User-eigene Skills nicht skalieren — jeder Skill bräuchte
Code + Redeploy. Daten-getriebene Skill-Definitionen (Vault-Notes) sind die einzige
Variante die beliebig wächst.

## Skill-Definition (Frontmatter-Schema)

Datei: `70_pai/skills/{slug}.md`

```yaml
---
id: <ULID>                      # wie jede Vault-Note
type: skill                     # NEUER doc-type, muss in SPEC + JSON-Schema
title: Wochenrückblick
skill_name: wochenrueckblick    # eindeutiger Aufruf-Name für run_skill
description: >                  # was der Skill tut — die KI liest das in list_skills
  Fasst alle Notes der letzten 7 Tage zu einem strukturierten Wochenrückblick
  zusammen und legt ihn als Note in 70_pai/digests/ ab.
execution: client               # client (default) | server (Phase 2)
allowed_tools:                  # welche MCP-Tools der Skill nutzen darf
  - search_vault
  - read_note
  - create_note
input_schema:                   # optional — Parameter die run_skill annimmt
  type: object
  properties:
    days: { type: number, default: 7 }
output:                         # optional — Konvention wohin das Ergebnis
  folder: 70_pai/digests
  type: note
  path_pattern: "{YYYY-MM-DD}-wochenrueckblick"
---

# Prompt

Du erstellst einen Wochenrückblick für {{user}}. Vorgehen:
1. Rufe search_vault / list_tree für Notes der letzten {{days}} Tage.
2. Gruppiere nach Thema (Projekte, Entscheidungen, Captures, offene TODOs).
3. Schreibe eine strukturierte Markdown-Zusammenfassung: TL;DR, Highlights,
   offene Punkte, Verbindungen via [[wikilinks]].
4. Lege das Ergebnis via create_note in {{output.folder}} ab.
```

Der Body unter `# Prompt` ist die Instruktion die die KI bekommt. Mustache-artige
`{{tokens}}` werden aus `input_schema`-Werten + Vault-Kontext gefüllt.

## MCP-Tool-Exposure: Meta-Tools

Zwei feste Tools (Tool-Liste bleibt stabil, keine Reconnect-Probleme):

### `list_skills()`
Liest alle `type: skill` Notes, gibt zurück:
```json
[{ "skill_name": "wochenrueckblick", "title": "...", "description": "...",
   "input_schema": {...}, "execution": "client" }, ...]
```

### `run_skill(skill_name, input?)`
- Lädt die Skill-Note
- **execution: client (v1)**: returnt ein strukturiertes Objekt:
  `{ prompt: <gefüllter Prompt>, allowed_tools: [...], context: <vorab geladene
  Daten>, output_convention: {...} }`. Die **aufrufende KI** führt dann mit ihren
  normalen Tool-Calls aus. Der Server macht nur das Prompt-Templating + optionales
  Context-Preloading (z.B. "lade schon mal die Notes der letzten 7 Tage").
- **execution: server (Phase 2)**: Server ruft selbst das konfigurierte LLM mit
  dem Prompt + Vault-Daten, schreibt das Ergebnis, returnt es fertig.

### Discoverability
Die MCP-`instructions` (Begrüßungstext beim initialize, existiert schon) wird
ergänzt: "Du hast Zugriff auf Skills — wiederverwendbare Workflows. Rufe
`list_skills` um zu sehen welche verfügbar sind, dann `run_skill`."

### Warum Meta-Tools statt individueller Tools pro Skill
MCP-Clients cachen die Tool-Liste beim Connect. `notifications/tools/list_changed`
wird von claude.ai/Desktop unterschiedlich zuverlässig gehandhabt → neuer Skill =
Reconnect nötig = schlechte UX. Meta-Tools halten die Tool-Liste stabil, Skills
bleiben dynamische Daten. Individuelle Tools (`skill_xyz`) sind eine optionale
Phase-3-Verbesserung falls sich list_changed als zuverlässig erweist.

## Execution-Modell

| | v1 (client) | Phase 2 (server) |
|---|---|---|
| Wer arbeitet | aufrufende Claude-Instanz | lokyy-Server (eigener LLM-Call) |
| LLM-Kosten | beim User (zahlt Claude eh) | server-side (llm_providers) |
| Voraussetzung | MCP-Client (Claude) | nichts — auch In-App + Cron |
| Use-Cases | on-demand-Workflows | scheduled digests, In-App-Buttons |

`execution`-Feld ist von Tag 1 im Schema → Phase 2 ist additiv, kein Umbau.

## Beispiel-Skills (decken die vier Use-Case-Klassen ab)

1. **Periodische Summaries** — `wochenrueckblick`, `meeting-destillat` (alle
   `type: meeting` der Woche → Action-Items).
2. **Capture-Veredelung** — `capture-to-todos` (TODOs aus 30_captures ziehen →
   task-Notes), `youtube-action-items` (Transkript → strukturierte Takeaways),
   `auto-verschlagworten` (Voice-Notes Tags + Wikilinks vorschlagen).
3. **Knowledge-Graph-Pflege** — `zk-steward` (Orphans finden, Wikilinks
   vorschlagen, Topic-Notes generieren), `dedup` (ähnliche Notes mergen).
4. **Externe Daten** — `research-capture` (Web-Research → Capture-Note),
   `newsletter-parse` (RSS/Newsletter → Captures).

Diese werden als seed-Skills mit dem Vault-Scaffold ausgeliefert (im Setup-Wizard
Vault-Init), sodass jeder neue lokyy-brain sie sofort hat.

## Implementierungs-Phasen (grobe Epic-Zerlegung)

**Phase 1 — Skill-Fundament (client-execution)**
- `type: skill` zu SPEC + JSON-Schema (`00_meta/schemas/skill.json`)
- Skill-Parser in `@lokyy/core` (frontmatter → SkillDef, Prompt-Templating)
- MCP-Tools `list_skills` + `run_skill` (client-mode: returnt Prompt+Context)
- Seed-Skills ins Vault-Scaffold (Setup-Wizard)
- MCP-`instructions` um Skill-Hinweis ergänzen
- Settings → Skills-Tab: zeigt Vault-Skills (statt hardcoded Array), Link zum
  Editor um sie zu bearbeiten

**Phase 2 — Server-Execution + Automation**
- `execution: server` im run_skill (server-side LLM-Pipeline)
- In-App-Buttons in der PWA (Skill direkt aus dem Editor triggern)
- Cron-Scheduling für Skills (`schedule: "0 18 * * 5"` im Frontmatter → nightly/
  weekly digests ohne offenen Claude)

**Phase 3 — Polish (optional)**
- Individuelle MCP-Tools pro Skill (falls list_changed zuverlässig)
- Skill-Marketplace / Import-Export (Skills zwischen Vaults teilen)
- Skill-Verkettung (ein Skill ruft einen anderen)

## Offene Fragen für die PRD-Phase

1. **Prompt-Templating-Engine** — Mustache? Eigene `{{token}}`-Substitution?
   Wie viel Logik (Conditionals, Loops) braucht ein Skill-Prompt?
2. **Context-Preloading** — soll run_skill (client) schon Daten vorladen, oder
   nur den Prompt liefern und die KI lädt selbst via allowed_tools? Vorladen
   spart Roundtrips, ist aber weniger flexibel.
3. **allowed_tools Enforcement** — rein advisory (Prompt sagt der KI was sie darf)
   oder hart (MCP-Server lehnt Tool-Calls außerhalb der Allowlist während eines
   Skill-Runs ab)? Hartes Enforcement braucht Session-State.
4. **Skill-Permissions** — greift das bestehende `00_meta/mcp-scopes.yaml`
   (read/write-Globs pro Agent) auch auf Skills? Vermutlich ja — ein Skill kann
   nicht mehr als sein aufrufender Agent.
5. **type: skill vs eigener Ort** — Skills als normale Notes mit `type: skill`
   (tauchen im Tree auf, durchsuchbar) oder versteckt in einem Sonder-Verzeichnis?
   Tendenz: normale Notes, sichtbar, editierbar.

## Verweise

- Aktueller Skill-Stub: `server/src/routes/admin.ts:505`
- Settings-Skills-Tab: `pwa/src/Settings.tsx` (tab === "skills")
- MCP-Tools heute: `mcp/src/*` (read_note, search_vault, list_tree, create_note,
  update_note, resolve_by_id)
- MCP-Scopes: `00_meta/mcp-scopes.yaml` im Vault
- Backlog-Kontext: Vault-Note `70_pai/sessions/2026-05-27-backlog-snapshot`
