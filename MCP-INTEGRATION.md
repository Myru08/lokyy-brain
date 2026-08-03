# Lokyy Brain — MCP-Integration

> Anbindungs- und Bedienungsanleitung des **Lokyy-Brain-MCP** für ein
> Fremdsystem (App / Agent / KI), das den Vault als gemeinsame Wissensbasis
> nutzen soll. Stand: 2026-06-21.

---

## 1. Was Lokyy Brain ist

Lokyy Brain ist die **Single Source of Truth (SSOT)** — ein git-gestützter
Wissensvault aus SPEC-konformen Markdown-Notizen (Karpathy-Second-Brain-Pattern,
PARA-Ordnerstruktur). Der MCP-Server macht diesen Vault **modell-agnostisch**
für jeden Agenten verfügbar: lesen, durchsuchen, zurückschreiben — über das
Model Context Protocol.

**Kernprinzip für jedes anbindende System:**
- **Read-first:** Bevor du über Projekte/Entscheidungen/Historie des Nutzers
  redest → `search_vault` aufrufen. Nie aus dem Gedächtnis spekulieren.
- **Write-always:** Neue Erkenntnisse / „merk dir das" → als Notiz persistieren
  (`create_managed_note` / `create_note`).
- **Scope-gated:** Was ein Token darf, steht in der Vault-Scope-Config. Verbotene
  Pfade sind **nicht sichtbar** (kein Leak) — Scope-Verletzungen kommen als
  strukturierter Fehler zurück; nicht drumherum-probieren.

---

## 2. Endpoint & Protokoll

| | |
|---|---|
| **MCP-Endpoint** | Lokal (`docker-compose.local.yml`): `http://localhost:8788/mcp`. Remote (Coolify): deine eigene Domain, z. B. `https://mcp.deine-domain.tld/mcp`. |
| **Transport** | Streamable HTTP (MCP-Spec). POST `/mcp` für JSON-RPC; Antworten als JSON **oder** SSE (`text/event-stream`). |
| **Health** | `GET <MCP-Endpoint>/health` → `{"ok":true,...}` (keine Auth) |
| **Protokoll-Version** | `2024-11-05` |
| **Session** | Der `initialize`-Response liefert den Header `Mcp-Session-Id`; bei allen Folge-Requests mitsenden. |

**Header für jeden Call:**
```
Authorization: Bearer <TOKEN>
Content-Type: application/json
Accept: application/json, text/event-stream
Mcp-Session-Id: <aus initialize>     # ab dem 2. Request
```

---

## 3. Authentifizierung (Bearer-Token)

Der **Bearer-Token bestimmt Vault, Rolle und Ordner-Scope** — alles, was das
anbindende System darf:

- **Eigener/Owner-Token** — **Einstellungen → MCP → „Token erzeugen"**. Voller
  Zugriff auf den Haupt-Vault. Der Klartext wird **genau einmal** angezeigt;
  gespeichert wird nur sein SHA-256-Hash, wiederherstellen ist unmöglich —
  verloren heißt widerrufen + neu erzeugen. Der Token wird **pro Request**
  geprüft: er gilt **sofort, ohne Neustart**, und ein Widerruf wirkt ebenso
  sofort. Beim Abschluss des Setup-Wizards wird automatisch der erste Token
  erzeugt und einmalig angezeigt.
- **Mandanten-/Kunden-Token** (Einstellungen → Mandanten): bindet den
  Request an **genau einen** isolierten Kundenvault mit definierter Rolle
  (`read` / `write`) und Ordner-Freigaben. Der MCP zeigt diesem Token **nur**
  die freigegebenen Ordner — der Rest existiert für ihn nicht.
- **Legacy: `LOKYY_MCP_TOKEN` (Umgebungsvariable)** — bleibt als Fallback
  gleichberechtigt gültig, damit bestehende Installationen und hinterlegte
  Client-Configs weiterlaufen. Nachteil: eine Änderung erfordert einen
  **Neustart** des Stacks. Ist die Variable gar nicht gesetzt, akzeptiert `/mcp`
  ausschließlich die in der Oberfläche erzeugten Token — das ist der empfohlene
  Zustand.

> ⚠️ **Der Default `local_dev_token_change_me_32_chars_min` aus
> `docker-compose.local.yml` steht im öffentlichen Repo.** Er wird weiterhin
> akzeptiert (damit laufende Installationen nicht brechen), aber jede
> Installation, die ihn behält, teilt sich dasselbe Passwort. Die Einstellungen
> markieren ihn sichtbar als unsicher: eigenen Token erzeugen und die Variable
> anschließend aus dem Deployment entfernen.

Ein **unbekannter oder widerrufener Token → HTTP 401**. Der Token wird vom
Nutzer/Operator im Lokyy-Brain-Dashboard kopiert; das Fremdsystem hinterlegt ihn
als Secret.

**HTTP 503 `{"error":"mcp-unavailable"}`** heißt dagegen: der Endpunkt ist noch
gar nicht scharf, weil **kein Vault existiert** — das ist der Zustand vor dem
Setup-Wizard. Der Token ist daran unschuldig. Sobald der Wizard durchgelaufen
ist, initialisiert sich `/mcp` beim nächsten Request selbst; ein **Neustart des
Containers ist nicht nötig**. Bleibt der 503 danach bestehen, existiert wirklich
keine Vault-Zeile in der Datenbank (Server-Log: `no vault rows in DB`).

---

## 4. Werkzeuge (29 Tools)

### Lesen & Suchen
| Tool | Zweck |
|---|---|
| `search_vault(query*, limit)` | Volltext (Tier 1) + semantische Embeddings (Tier 2), gemerged. **Zuerst aufrufen** bei „was wissen wir über X". |
| `read_note(path*)` | Eine Notiz lesen (Body + Frontmatter). `path` = Notiz-ID ohne `.md`. |
| `resolve_by_id(id*)` | Notiz über ihre stabile 26-stellige ULID auflösen (überlebt Umbenennen/Verschieben). |
| `list_notes(filter, limit, offset)` | Notizen per Frontmatter-Filter (type/folder/tag/status/updated_after) in EINEM Call. |
| `list_tree()` | Ordner-/Notiz-Baum — **gefiltert auf den lesbaren Scope**. |
| `get_tags()` | Alle Tags mit Häufigkeit. |
| `get_backlinks(path*)` | „Wer verlinkt hierher" inkl. Kontext-Snippet. |
| `get_graph()` | Kompletter Wissensgraph aus Wikilinks `{ nodes, edges }`. |
| `find_broken_links()` | Vault-Health: alle `[[…]]`, die ins Leere zeigen. |
| `get_history(path*, limit)` | Git-Versionshistorie einer Notiz (read-only). |
| `get_note_diff(path*, sha)` | Unified-Diff einer Notiz (read-only). |

### Schreiben
| Tool | Zweck |
|---|---|
| `create_managed_note(title*, type*, body, tags, folder_hint)` | **Empfohlener Schreibpfad** (OS-Contract ADR-004): Pfad/ULID/Frontmatter leitet der Server aus `type` ab. Du gibst nur die Intention. |
| `create_note(path, type, title, body, slug, frontmatter)` | Notiz mit explizitem Pfad/Frontmatter anlegen. |
| `update_note(path*, body*)` | Notiz speichern/überschreiben (Body-Replace). |
| `delete_note(path*, hard)` | Notiz löschen. |
| `create_notes(notes*)` | **Atomar** viele Notizen auf einmal (Projekt-Scaffolding) — alle oder keine. |
| `update_notes(updates*)` | Atomar viele Notizen aktualisieren. |
| `move_note(from*, to*)` | Notiz in anderen Ordner verschieben. |
| `rename_note(path*, new_slug*)` | Im selben Ordner umbenennen. |
| `create_folder(path*, with_readme)` | Ordner explizit anlegen. |
| `validate_note(path, body)` | Frontmatter gegen das Doc-Type-Schema prüfen, **ohne** zu schreiben (Pre-Flight). |

### Skills (wiederverwendbare Prompt-Workflows)
| Tool | Zweck |
|---|---|
| `list_skills()` | Verfügbare Vault-Skills (`type: skill`-Notizen) auflisten. |
| `run_skill(skill_name*, input)` | Skill validieren + Prompt-Template rendern → gibt den **fertigen Prompt zurück, den DU selbst ausführst** (client-seitig, mit den Tools hier). `run_skill` führt KEIN LLM aus und schreibt nichts. |
| `get_skill_schema()` | Offizielles Skill-Frontmatter-Schema + Beispiel. |
| `import_skill(skill_name*, files*)` | Anthropic-Format-Folder-Skill (SKILL.md + references/templates) in einem Call importieren. |

### Meta / Health / Pipes
| Tool | Zweck |
|---|---|
| `get_vault_conventions()` | Maschinenlesbare Ordner + Doc-Type-Liste + Frontmatter-Contract + Wikilink/Tag/ULID-Regeln. **Vor dem ersten Schreiben aufrufen.** |
| `get_health()` | Backend-Snapshot: git/Forgejo-Sync-State, letzter Index, pending writes, DB-Pool, aktive `vault_id`, quarantänierte Notizen. |
| `import_pipe(url*, type)` | Externe URL (Website/YouTube) aktiv in den Vault importieren. |
| `get_pipe_status(job_id*)` | Status eines Import-Jobs abfragen. |

`*` = Pflichtparameter. Die exakten JSON-Schemas liefert `tools/list` zur Laufzeit.

### 4a. Fehlerbehandlung — `isError` prüfen, nicht nur den Text

Jedes Tool-Ergebnis ist ein `CallToolResult` mit `content` **und** einem optionalen
`isError`-Feld (MCP-Spec). Ein fehlgeschlagener Aufruf (Scope-Verletzung,
Frontmatter-Validierung, unbekanntes Tool, jeder sonstige Ausführungsfehler)
setzt `isError: true` — der strukturierte Fehler-Payload (`{ error: "...", ... }`)
steckt dabei weiterhin in `content[0].text`, unverändert im Format.

**Wichtig für jedes anbindende System:** Verlasse dich nicht darauf, dass ein
zurückgegebenes `content` automatisch Erfolg bedeutet — prüfe `result.isError`
explizit, bevor ein Schreibvorgang als erledigt gilt. Ein Klient, der nur auf
"kam eine Antwort zurück" statt auf `isError` prüft, hält einen abgelehnten
Schreibvorgang für erfolgreich.

Bewusst **kein** `isError` bei: einem leeren, aber gültigen Suchergebnis
(`search_vault` ohne Treffer), einem lesenden Lookup, der nichts findet
(`read_note`/`resolve_by_id` bei nicht existierendem Pfad — die Antwort auf
"existiert das?" ist kein Fehler), und einem `validate_note`-Verdikt
`{ valid:false, ... }` (das Tool hat korrekt gearbeitet, das Ergebnis der
Prüfung ist die eigentliche Antwort).

---

## 5. Empfohlenes Nutzungsmuster (aus den Server-Instructions)

Der Server liefert beim `initialize` `instructions` — die KI des Fremdsystems
sollte sie als System-Prompt-Addendum übernehmen. Kernregeln:

1. **Vor** Aussagen über Projekte/Entscheidungen/Historie → `search_vault`, dann
   mit `noteId` zitieren.
2. **Nach** substanziellen Gesprächen mit neuen Erkenntnissen → `create_managed_note`.
   Typ bewusst wählen: `note` → `20_notes/`, `capture` → `30_captures/`,
   `decision` → `50_decisions/`, `intervention` → `70_pai/interventions/`.
3. Bei „speicher das" / „merk dir" → sofort `create_managed_note` (type capture),
   nicht nachfragen.
4. Beim Editieren: konzeptuelle Bezüge als `[[Andere Notiz]]` einfügen → der
   Wissensgraph wächst organisch.
5. Pfadmuster für chronologische Sortierung: `{folder}/{YYYY-MM-DD}-{slug}`.

---

## 6. Minimal-Beispiel (HTTP)

**1) Initialisieren** (liefert `Mcp-Session-Id` + `instructions`):
```bash
curl -s http://localhost:8788/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2024-11-05","capabilities":{},
                 "clientInfo":{"name":"meine-app","version":"1.0"}}}'
# → Response-Header:  Mcp-Session-Id: <SID>
```

**2) initialized melden** (einmalig):
```bash
curl ... -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
```

**3) Tool aufrufen** (z. B. Suche):
```bash
curl ... -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"search_vault","arguments":{"query":"onboarding prozess","limit":5}}}'
```

**4) Notiz schreiben:**
```bash
curl ... -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"create_managed_note","arguments":{
         "title":"Kickoff Kunde Müller","type":"note",
         "body":"## TL;DR\n…","tags":["kunde","kickoff"]}}}'
```

Standard-MCP-Clients (Claude Desktop/Code, claude.ai-Connector, jedes
MCP-SDK) verbinden sich mit denselben drei Angaben: **URL `/mcp` + Bearer-Token**
— Tools werden dann automatisch entdeckt.

---

## 7. Für ein anbindendes System — Checkliste

- [ ] Token im Lokyy-Brain-Dashboard erzeugen (Einstellungen → MCP für den
      eigenen Vault, Einstellungen → Mandanten für einen Kundenvault) und
      **sofort kopieren** — er wird nur einmal angezeigt.
- [ ] MCP-Client auf `http://localhost:8788/mcp` + Bearer-Token zeigen
      lassen (oder die 3 HTTP-Schritte oben implementieren).
- [ ] Die `initialize`-`instructions` in den eigenen System-Prompt übernehmen.
- [ ] Read-first/Write-always als Verhaltensregel verankern.
- [ ] `get_vault_conventions()` einmal lesen, bevor zum ersten Mal geschrieben wird.
- [ ] Scope-Fehler als harte Grenzen behandeln (nicht umgehen).
