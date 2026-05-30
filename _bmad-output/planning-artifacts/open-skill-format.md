# Open-Skill Format — Spezifikation + MCP-Exposition (Story 11.7)

> Status: **verifiziert** (Read/Verify, kein Neu-Bau). Belegt, dass Lokyy-Skills
> bereits modell-agnostisch über `list_skills`/`run_skill` ausgeliefert werden —
> über **stdio UND HTTP**, mit `{{var}}`-Rendering und `input_schema`-Validierung.
>
> Quelle: `packages/core/src/skills/index.ts`, `mcp/src/server.ts`,
> `mcp/src/httpServer.ts`, `packages/core/src/frontmatter/schemas/skill.json`.
> Tests grün: 17 core-skill-Tests + 63 mcp-Tests (Stand 2026-05-30).

---

## 0. Kernaussage

Ein Lokyy-Skill ist **kein proprietäres Artefakt**. Er ist eine ganz normale
SPEC-konforme Markdown-Note mit `type: skill` — Frontmatter oben, Prompt-Template
unten. Jede MCP-fähige KI (Claude Desktop, Claude.ai Connector, ChatGPT mit
MCP-Bridge, Gemini, Custom-Agents) kann die Skills

1. **entdecken** (`list_skills`),
2. **das Schema lernen** (`get_skill_schema`) und
3. **feuern** (`run_skill`) —

ohne Lokyy-spezifisches SDK. Der gemeinsame Nenner ist das offene
**Model Context Protocol (MCP)**. Die PWA hat bewusst keinen MCP-Client
(Addendum §0); externe KIs schon — genau dafür ist das Format offen.

---

## 1. Das offene Skill-Format

### 1.1 Datei

- Eine `.md`-Datei, kanonisch unter `70_pai/skills/<skill_name>.md`.
- `listSkillNotes` durchsucht `70_pai/skills/` rekursiv; ist der Ordner leer,
  fällt es auf den gesamten Vault-Root zurück. Jeder Pfad mit
  `type: skill` wird gefunden (`packages/core/src/skills/index.ts:231-267`).
- Die Datei unterliegt demselben Vault-Contract wie jede andere Note (gültiges
  Frontmatter, Pre-Commit-Hook). **Kein Sonderweg, kein Sonderschema-Loader.**

### 1.2 Frontmatter (Vertrag)

Validiert gegen `packages/core/src/frontmatter/schemas/skill.json`
(JSON-Schema draft-07). Pflicht- und Optionalfelder:

| Feld | Pflicht | Bedeutung |
|------|---------|-----------|
| `id` | ja | ULID, 26 Zeichen, stabil bei Rename |
| `type` | ja | Literal `skill` |
| `title` | ja | Menschlicher Titel (non-empty) |
| `skill_name` | ja | Stabiler Maschinenname, `^[a-z0-9-]+$` — der Handle für `run_skill` |
| `description` | ja | Einzeiler, was der Skill tut |
| `created` / `updated` | ja | ISO-8601 (Hook pflegt `updated`) |
| `execution` | nein | `client` \| `server` (Default `client`). Phase 1 führt nur `client` aus; `server` ist schemavalide, wird zur Laufzeit aber abgelehnt |
| `input_schema` | nein | JSON-Schema-artiges Objekt. **Seine Keys werden zu `{{var}}`-Tokens** |
| `allowed_tools` | nein | Advisory-Liste der Vault-Tools, die der Skill erwartet (in Phase 1 nicht erzwungen) |
| `output` | nein | Hinweis `{ folder, type, path_pattern }` für erzeugte Notes |
| `tags` | nein | Freie Tags |
| `privacy` | nein | `default` \| `local-only` (zwingt lokales LLM) |

`additionalProperties: true` — das Format ist **vorwärtskompatibel**: neue Felder
brechen ältere Parser nicht.

### 1.3 Body = Prompt-Template

Alles unterhalb des Frontmatters ist das Prompt-Template. Token-Syntax:

```
{{ key }}   ·   {{key}}   ·   {{ foo.bar }}
```

Regex `\{\{\s*([\w.]+)\s*\}\}` (`packages/core/src/skills/index.ts:91`).
Ein **einziger** Regex-Replace — keine Conditionals, keine Loops (PRD Q1).

**Built-in-Tokens** (immer verfügbar, ohne `input_schema`):
`{{today}}` (ISO-Datum), `{{user}}`, `{{vault_root}}`.

**Unbekannte Tokens bleiben wörtlich stehen** (kein Fehler, kein Leerstring) —
robust gegen Tippfehler und literale `{{ }}`-Klammern.

### 1.4 Beispiel-Skill (schemavalide, parsebar, rendert)

```markdown
---
id: 01JXYZABCDEFGHJKMNPQRSTVWX
type: skill
title: Weekly Review
skill_name: weekly-review
description: Summarize the last N days of notes on a topic.
execution: client
allowed_tools:
  - search_vault
  - read_note
input_schema:
  properties:
    days:
      type: integer
      default: 7
    topic:
      type: string
created: "2026-05-24T10:00:00.000Z"
updated: "2026-05-24T10:00:00.000Z"
---
Review the last {{days}} days of notes about {{topic}} (today is {{today}}).
Cite related notes via [[wikilinks]].
```

Dieses Beispiel wird von `get_skill_schema` verbatim ausgeliefert und ist im
Test sowohl schemavalide als auch über `renderPrompt` rendernd belegt
(`packages/core/src/skills/skills.test.ts`).

---

## 2. Wie eine externe MCP-fähige KI Skills zieht und feuert

Der Ablauf ist transport-unabhängig (stdio = Claude Desktop / lokal;
HTTP = Claude.ai-Connector, Remote-Bridges, ChatGPT/Gemini über MCP-HTTP).

### Schritt 1 — Discovery: `list_skills`

Gibt pro Skill `skill_name`, `title`, `description`, optional `input_schema`,
`execution` und `allowed_tools` zurück. Es werden **nur Skills im Read-Scope**
des Agenten geliefert (`mcp/src/server.ts:663-678`; Scope aus
`00_meta/mcp-scopes.yaml`). Die KI weiß danach, welche Skills existieren und
welche Parameter sie nehmen.

### Schritt 2 (optional) — Schema lernen: `get_skill_schema`

Liefert das echte `skill.json`, ein vollständiges Beispiel und Per-Field-Docs.
Damit kann eine KI in **einem** `create_note({ type: "skill", ... })`-Call einen
neuen Skill anlegen, ohne Create-then-Fix-Schleife (`mcp/src/server.ts:746-749`).

### Schritt 3 — Ausführen: `run_skill`

Eingabe: `{ skill_name, input? }`. Der Handler (`mcp/src/server.ts:680-723`):

1. **Scope-Gate** vor Disk-Zugriff — out-of-scope → strukturierter `ScopeViolation`.
2. **Lookup** — unbekannt → `{ ok:false, error:"skill-not-found" }`.
3. **execution-Gate** — `server` → `{ ok:false, error:"server-execution-not-supported" }`.
4. **`input_schema`-Validierung** (`validateSkillInput`): Pflichtfelder + Typen
   (`integer`/`number` → `number`), Defaults werden aufgefüllt, Extra-Keys
   durchgereicht (Schema ist advisory). Fehler → `{ ok:false, error:"invalid-input", field_errors:[...] }`.
5. **Rendering** (`renderPrompt`): `{{var}}`-Substitution mit Input + Built-ins.
6. **Rückgabe**: `{ ok:true, skill_name, prompt, allowed_tools, output? }`.
   Bei nicht-leerer `allowed_tools` wird eine Hinweiszeile vorangestellt
   (advisory, nicht erzwungen).

**Wichtig — modell-agnostisches Vertragsmodell:** `run_skill` ruft **kein** LLM
auf und schreibt **keine** Note. Es gibt nur den fertig gerenderten Prompt
zurück. Die externe KI führt diesen Prompt **selbst** mit ihren eigenen
Tool-Calls aus. Dadurch ist der Skill unabhängig vom konkreten Modell — Lokyy
liefert die Instruktion, die KI liefert die Intelligenz.

### Sequenz

```
Externe KI (Claude/ChatGPT/Gemini)        Lokyy MCP-Server
        |                                         |
        |  list_skills                            |
        |---------------------------------------->|
        |  <- [{skill_name, input_schema, ...}]   |
        |                                         |
        |  run_skill {skill_name, input}          |
        |---------------------------------------->|  scope → lookup →
        |                                         |  validate → render
        |  <- {ok:true, prompt:"Review the last   |
        |      7 days about AI (today is ...)"}    |
        |                                         |
        | (KI führt prompt mit eigenen Tools aus) |
```

---

## 3. Transport-Verifikation: stdio UND HTTP

Beide Entry-Points bauen denselben `Server` über dieselbe Factory — der
Tool-Surface kann nicht auseinanderdriften:

| Transport | Entry | Server | Auth |
|-----------|-------|--------|------|
| **stdio** | `mcp/src/bin.ts` → `buildServer()` → `start()` → `StdioServerTransport` | identisch | Prozess-lokal |
| **HTTP** | `mcp/src/binHttp.ts` → `startHttpServer(() => createServer(), ...)` → `StreamableHTTPServerTransport` | Bearer (`LOKYY_MCP_TOKEN`) **oder** OAuth-JWT (RFC 9728 `WWW-Authenticate`) |

- HTTP exponiert den MCP-Standard-Endpunkt `POST/GET/DELETE /mcp` mit
  Per-Client-Sessions und CORS allow-all für Browser-MCP-Clients
  (`mcp/src/httpServer.ts`). Das deckt die dokumentierten Use-Cases ab:
  Remote-Claude-Desktop via `mcp-remote`, **claude.ai Custom Connector**
  (OAuth), self-hosted/Docker mit public ingress.
- Da `list_skills`/`run_skill`/`get_skill_schema` in der **einen**
  `ListTools`-Registrierung stehen (`mcp/src/server.ts:299-355`) und im **einen**
  `CallTool`-Switch behandelt werden, sind sie über **beide** Transports
  identisch sichtbar und ausführbar. **AC#1/AC#2 bestätigt.**

---

## 4. Verifikationsergebnis

**Bestätigt — Exposition ist modell-agnostisch und vollständig (selfBuildPassed = true).**

| AC | Befund |
|----|--------|
| AC#1 Doku | Dieses Dokument. |
| AC#2 Verifikation | `list_skills`/`run_skill` liefern Skills über stdio + HTTP; `{{var}}`-Rendering (`renderPrompt`, TOKEN_RE) und `input_schema`-Validierung (`validateSkillInput`: Pflicht/Typ/Defaults) belegt durch Code + 17 grüne core-Tests + 63 grüne mcp-Tests. |
| AC#3 Format offen | Kein proprietäres Schema. `skill.json` ist Standard-JSON-Schema, `additionalProperties:true`; Skill ist eine reguläre `type:skill`-Note. Portabel. |
| AC#4 Export | Siehe §5 — nur Vorschlag, keine v1-Pflicht. |
| AC#5 Anti | Kein `mcp/`-Produktionscode geändert; kein Schema-Bruch; keine neuen Features. |

### Verifizierte Garantien

- `parseSkill` validiert gegen `skill.json` und wirft `FrontmatterValidationError`
  (typisiert) bei kaputtem Skill — **ein** defekter Skill bricht `list_skills`
  nicht (Skip + Warn, `index.ts:256-264`).
- `renderPrompt`: Built-ins `{{today}}/{{user}}/{{vault_root}}`, unbekannte Tokens
  bleiben verbatim, `null`/`undefined` bleiben als Token stehen.
- `validateSkillInput`: tolerant gegenüber flachem `input_schema` (Keys = Params)
  **und** verschachteltem `{ properties, required }`. `integer`/`number` werden
  auf `number` gemappt. Extra-Keys durchgereicht.
- HTTP-Transport refuses-to-start ohne `LOKYY_MCP_TOKEN` (kein anonymer Zugang).

### Findings (dokumentiert, NICHT gefixt)

1. **F-1 (low) — keine Transport-E2E-Tests für `list_skills`/`run_skill`.**
   Die Kern-Logik ist erschöpfend unit-getestet (17 Tests) und der CallTool-Pfad
   ist allgemein über die In-Memory-Transport-Suite abgedeckt, aber es gibt
   **keinen** dedizierten E2E-Test, der `list_skills`/`run_skill` über
   `client.callTool` fährt (nur `get_skill_schema` ist transport-level getestet,
   `server.test.ts:155-167`). Empfehlung: eigene Story für E2E-Coverage der
   Skill-Switch-Cases (inkl. `invalid-input`, `skill-not-found`,
   `server-execution-not-supported`, Scope-Gate). Kein Funktionsdefekt — reine
   Test-Lücke.
2. **F-2 (info) — `allowed_tools` ist nur advisory.** In Phase 1 wird die Liste
   nicht erzwungen; sie wird als Hinweiszeile vorangestellt. Bewusst (PRD Q3),
   hier nur zur Transparenz für externe Integratoren festgehalten.
3. **F-3 (info) — `privacy: local-only`** ist im Schema vorhanden, aber im
   `run_skill`-Handler (Phase 1) nicht erzwungen. Reiner Schema-Hinweis;
   Durchsetzung wäre eigene Story.

---

## 5. Optionaler Skill-Export (Vorschlag, nicht v1-Pflicht)

Da ein Skill bereits **eine eigenständige, selbsterklärende `.md`-Datei** ist,
ist „Export" trivial: die Datei kopieren. Ein dünnes CLI/MCP-Convenience wäre
denkbar, aber nicht erforderlich:

- `export_skill(skill_name) → { filename, content }` — liefert die rohe
  `.md` (Frontmatter + Body) zum Speichern/Teilen.
- Import = `create_note({ type:"skill", ... })` mit demselben Inhalt; der
  Pre-Commit-Hook validiert das Frontmatter automatisch.

**Empfehlung:** Kein neues Format, kein Bundle-Schema. Der „Open-Skill"-Anspruch
ist bereits erfüllt, weil die Transporteinheit eine portable Markdown-Datei nach
einem offenen JSON-Schema ist. Ein Export-Tool ist Komfort, kein Vertrag — daher
bewusst aus v1 ausgeklammert.
