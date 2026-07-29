<p align="center">
  <img src="lokyy-brain-new-logo-transparent.png" alt="Lokyy Brain" width="220">
</p>

<h1 align="center">Lokyy Brain</h1>

<p align="center">
  <strong>Ein git-versionierter Wissensvault, der jede KI verstehen kann.</strong><br>
  Single Source of Truth für dich UND für jeden Agenten, der über MCP anfragt.
</p>

<p align="center">
  <img alt="License: Proprietary" src="https://img.shields.io/badge/license-proprietary-red.svg">
  <img alt="Status" src="https://img.shields.io/badge/status-beta-orange.svg">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-29%20tools-6f42c1.svg">
  <img alt="Stack" src="https://img.shields.io/badge/stack-Hono%20%C2%B7%20Vite%20%C2%B7%20Postgres%20%C2%B7%20Ollama-333.svg">
</p>

---

## Inhaltsverzeichnis

- [Was Lokyy Brain ist](#was-lokyy-brain-ist)
- [Warum Lokyy Brain](#warum-lokyy-brain)
- [Features](#features)
- [Quickstart — lokale Installation](#quickstart--lokale-installation)
- [Befehle im Überblick](#befehle-im-überblick)
- [Der Setup-Wizard im Detail](#der-setup-wizard-im-detail)
- [Architektur](#architektur)
- [Memory-Modell](#memory-modell)
- [MCP-Integration — KI-Agenten anbinden](#mcp-integration--ki-agenten-anbinden)
- [Vault-Contract (SPEC)](#vault-contract-spec)
- [Remote-Deployment](#remote-deployment)
- [Projekt-Status](#projekt-status)
- [Zugriff & Mitwirken](#zugriff--mitwirken)
- [Lizenz](#lizenz)

---

## Was Lokyy Brain ist

Lokyy Brain ist ein **git-gestützter Wissensvault** aus SPEC-konformen
Markdown-Notizen (Karpathy-Second-Brain-Pattern, PARA-Ordnerstruktur). Er läuft
als Web-App **und** als installierbare PWA, wird über eine REST-API bedient und
macht denselben Vault gleichzeitig über das **Model Context Protocol (MCP)**
für jede angeschlossene KI verfügbar — Claude Code, Claude Desktop, eigene
Agenten, alles, was MCP spricht.

**Kernidee:** Deine Notizen sind nicht in einer App gefangen. Sie sind
Klartext-Markdown mit striktem Frontmatter, in einem Git-Repo versioniert —
lesbar, durchsuchbar und beschreibbar von dir *und* von jeder KI, die du
anbindest, über dieselbe Wahrheit.

## Warum Lokyy Brain

| | Lokyy Brain | Obsidian & Co. | Reiner Vector-Store / "KI-Memory" |
|---|---|---|---|
| **Speicherformat** | Klartext-Markdown + Frontmatter, git-versioniert | Klartext-Markdown, kein Server | Proprietäres DB-Format |
| **KI-Zugriff** | Nativ über MCP, 29 Tools, modell-agnostisch | Nur über Community-Plugins | Meist an einen Anbieter gebunden |
| **Wahrheit** | Git (Forgejo lokal oder remote) — volle Historie, Diffs, Rollback | Lokale Datei, kein eingebautes Sync | Kein Diff, keine Historie |
| **Selbst hostbar** | Ja, komplett — ein `docker compose up` | Teilweise (Sync-Server kostenpflichtig) | Selten |
| **Multi-Tenant** | Ja — isolierte Kundenvaults, gescopte Tokens | Nein | Variiert |
| **Semantische Suche** | Eingebaut (pgvector + Ollama, lokal) | Nur via Plugin | Kern-Feature, aber Cloud-only üblich |

## Features

- **CM6-Editor** mit Live-Preview, Wikilinks (`[[Notiz]]`) und Backlinks
- **Wissensgraph** aus Wikilinks, automatisch abgeleitet
- **Zwei-Stufen-Suche**: Volltext (Tier 1) + semantische Embeddings (Tier 2,
  `nomic-embed-text` via Ollama + pgvector), gemerged
- **MCP-Server** mit 29 Tools — Lesen, Suchen, Schreiben, Skills, Health,
  Import — für jeden MCP-fähigen Client
- **Skills-System**: wiederverwendbare Prompt-Workflows als Notizen, über MCP
  auflist- und ausführbar
- **Import-Pipes**: YouTube-Transkripte, einzelne Webseiten, ganze Websites —
  landen automatisch als Notiz im Vault
- **PWA**: installierbar, Offline-Editing mit IndexedDB-Cache, Web-Share-Target
- **Multi-Tenant**: isolierte Kundenvaults mit eigenem Git-Remote, eigener
  Rolle (`read`/`write`) und Ordner-Scope pro MCP-Token
- **Lokal oder remote** — derselbe Stack läuft auf deinem Laptop und auf einem
  Coolify-VPS

## Quickstart — lokale Installation

Eine Voraussetzung, einmalig:

**[Git](https://git-scm.com/downloads)** — zum Herunterladen des Repos.
Kein Umweg über einen ZIP-Download: du brauchst Git ohnehin, sobald du
später remote auf Coolify deployst (siehe [Remote-Deployment](#remote-deployment)),
also lernst du es gleich hier.

```bash
git clone https://github.com/oliverhees/lokyy-brain.git
cd lokyy-brain
```

Dann den passenden Installer starten. Er prüft **Docker** (Installation,
laufender Daemon, Compose-Plugin) und **installiert es bei Bedarf automatisch
mit**: unter Linux vollautomatisch (offizielles Docker-Skript), unter macOS
über Homebrew (wird bei Bedarf ebenfalls mitinstalliert) und unter Windows
über winget (wird bei Bedarf ebenfalls mitinstalliert). Nur wenn dabei ein
System-Neustart nötig ist (Windows/WSL2) oder ein neues Terminal-Fenster
(frisch installiertes `brew`/`winget`), sagt das Skript das klar an — das ist
kein Fehler, einfach einmal neu starten und den Befehl erneut aufrufen.
Danach warnt der Installer bei Port-Konflikten, baut und startet den Stack,
wartet auf die Web-UI und öffnet den Browser:

```bash
# macOS / Linux
./install.sh

# Windows (PowerShell)
.\install.ps1
```

Alternativ manuell, ohne den Installer:

```bash
docker compose -f docker-compose.local.yml up -d --build
```

Das startet sieben Container: `lokyy-brain` (API), `lokyy-pwa` (Web-UI),
`lokyy-mcp` (MCP-Server), `postgres` (ParadeDB — pgvector + BM25), `ollama`
(lokale Embeddings), `forgejo` (optionaler Git-Remote — siehe unten) und
`ollama-init` — ein einmaliger Init-Container, der das Embedding-Modell lädt
und sich danach beendet (`Exited (0)` ist bei ihm der Normalzustand, kein
Fehler).

Sobald alle Container laufen (`docker compose -f docker-compose.local.yml ps`
zeigt überall `healthy`):

```
Web-UI  → http://localhost:8095
API     → http://localhost:8787
MCP     → http://localhost:8788/mcp
```

Öffne `http://localhost:8095` im Browser — der Setup-Wizard startet
automatisch. (Der Installer öffnet den Browser automatisch für dich.)

## Befehle im Überblick

`install.sh`/`install.ps1` sind für die einmalige Erst-Installation da (Docker
prüfen/installieren, Images bauen). Für den Alltag danach gibt es
`lokyy.sh`/`lokyy.ps1` — kein Rebuild, entsprechend schnell:

| Befehl (macOS/Linux) | Befehl (Windows) | Wann | Was passiert |
|---|---|---|---|
| `./install.sh` | `.\install.ps1` | Einmalig, beim ersten Mal | Docker prüfen/installieren, Stack bauen & starten, Browser öffnen |
| `./lokyy.sh start` | `.\lokyy.ps1 start` | Alltag, nach Neustart falls nötig | Stack starten (kein Rebuild), Browser öffnen |
| `./lokyy.sh stop` | `.\lokyy.ps1 stop` | Feierabend | Stack anhalten, Container bleiben erhalten (nächster Start ist schnell) |
| `./lokyy.sh restart` | `.\lokyy.ps1 restart` | Bei komischem Verhalten | Container neu starten |
| `./lokyy.sh status` | `.\lokyy.ps1 status` | Schnellcheck | Läuft alles, ist es erreichbar? (rein lesend) |
| `./lokyy.sh doctor` | `.\lokyy.ps1 doctor` | Bei Problemen | Ausführliche Diagnose — Docker, Ports, Container-Health (rein lesend, ändert nichts) |
| `docker compose -f docker-compose.local.yml logs -f` | *(identisch)* | Debugging | Live-Logs aller Container |
| `docker compose -f docker-compose.local.yml down` | *(identisch)* | Komplett aufräumen | Container + Netzwerk entfernen (Vault/Daten bleiben in Volumes erhalten) |

Nach einem Neustart des Rechners musst du in der Regel **gar nichts** aufrufen:
alle Container laufen mit `restart: unless-stopped` und fahren von selbst
wieder hoch, sobald Docker (Desktop) läuft. Wichtig für die PWA: ein
gepinntes Icon öffnet nur den Browser auf `localhost:8095` — es kann Docker
nicht selbst starten. Läuft der Hintergrunddienst nicht, zeigt die PWA einen
Verbindungsfehler; Docker muss also laufen (siehe oben).

## Der Setup-Wizard im Detail

Fünf Schritte, geführt:

1. **Admin** — Account anlegen (Email, Passwort, Name). Wird sofort eingeloggt.
2. **Forgejo (Vault-Remote)** — zwei Wege:
   - **Mit Forgejo verbinden** (OAuth) — falls du Git-Sync/Backup willst. Der
     mitgelieferte Forgejo-Container läuft schon unter
     `http://localhost:8790`, kein externer Account nötig.
   - **"Ohne Forgejo fortfahren (nur lokal)"** — der empfohlene Standardweg.
     Der Vault wird als lokales Git-Repo im Container angelegt (versioniert,
     mit voller Commit-Historie), nur eben ohne Remote. Ein Forgejo-Remote
     lässt sich jederzeit später in den Einstellungen nachrüsten, ohne dass
     bisherige Commits verloren gehen.
3. **Postgres** — Verbindung wird automatisch geprüft (läuft schon im Stack).
4. **Ollama** — Embedding-Modell-Status wird geprüft (`nomic-embed-text` wird
   beim ersten Start automatisch gezogen).
5. **Fertig** — Setup-Flag wird gesetzt, das System ist scharf.

Danach landest du im Dashboard: Notiz-Baum links, Editor in der Mitte, Graph
und Suche über die Kommandopalette (`⌘/Ctrl K`).

## Architektur

```
┌─────────────┐   HTTP/JSON    ┌──────────────┐   git init/commit(/push)  ┌─────────┐
│  PWA (Vite) │ ─────────────▶ │ Server (Hono)│ ────────────────────────▶ │ Forgejo │
│  CM6 Editor │ ◀───────────── │ Working-Copy │ ◀──────────────────────── │(optional│
│  Graph      │                │  + Pipes     │                           │ Remote) │
└─────────────┘                └──────┬───────┘                           └─────────┘
   IndexedDB                          │
   (Offline-Cache)              ┌─────┴──────┐        ┌────────────────┐
                                 │  Postgres  │        │     Ollama     │
                                 │ (pgvector  │        │ (Embeddings,   │
                                 │  + BM25)   │        │  lokal)        │
                                 └────────────┘        └────────────────┘
                                        ▲
                                        │
                                 ┌──────┴───────┐
                                 │  MCP-Server  │  ← Claude Code, Claude Desktop,
                                 │  (29 Tools)  │    eigene Agenten, jeder MCP-Client
                                 └──────────────┘
```

Vier Bausteine, klare Verantwortung:

1. **PWA** — UI, CM6-Editor mit Live-Preview, Graph. Offline-Cache in
   IndexedDB, queued Saves bei fehlender Verbindung.
2. **Server (Hono)** — hält die einzige Git-Working-Copy, stellt Notizen,
   Graph und Pipes als JSON-API bereit. Git ist dabei immer ein first-class
   State: mit Remote committet & pusht jeder Save, ohne Remote committet er
   trotzdem lokal — nie ein Datenverlust-Risiko.
3. **Postgres (ParadeDB) + Ollama** — semantische Suche, lokal, ohne
   Cloud-API-Abhängigkeit.
4. **MCP-Server** — macht denselben Vault für jeden KI-Agenten verfügbar,
   scope-gated pro Token.

## Memory-Modell

Drei Stufen hinter einem gemeinsamen Interface:

- **Tier 1 — Struktur** (fertig): Wikilinks, Tags, Volltext.
- **Tier 2 — Semantik** (fertig): `nomic-embed-text` (Ollama) + pgvector HNSW —
  Suche findet Notizen auch ohne exakte Wikilinks.
- **Tier 3 — Temporaler Knowledge Graph** (offen, optional): Kandidaten sind
  [Graphiti](https://github.com/getzep/graphiti) und
  [cognee](https://github.com/topoteretes/cognee) — beide selbst-hostbare
  Knowledge-Graph-Engines für Agenten-Memory. Noch keine Wahl getroffen, kein
  Code geschrieben. Löst das, was ein flacher Wikilink-Graph nicht kann:
  benannte Beziehungstypen zwischen Entitäten und eine Zeitachse.

## MCP-Integration — KI-Agenten anbinden

Der MCP-Server exponiert **29 Tools** — Lesen, Suchen, Schreiben, Skills,
Health, Import — für jeden MCP-fähigen Client: Claude Code, Claude Desktop,
den claude.ai Custom Connector, oder einen eigenen Agenten.

**Lokal (Standard):**

```
MCP-Endpoint: http://localhost:8788/mcp
Auth:         Bearer-Token (siehe LOKYY_MCP_TOKEN in docker-compose.local.yml
              — Default zum Testen, für echten Einsatz ändern)
```

Claude Code oder jeder andere MCP-Client verbindet sich mit genau diesen zwei
Angaben; Tools werden automatisch entdeckt.

Vollständige Tool-Referenz, Auth-Modell (Owner- vs. Mandanten-Token),
Scope-Regeln und ein Minimal-Beispiel per `curl`:
**[→ MCP-INTEGRATION.md](MCP-INTEGRATION.md)**

## Vault-Contract (SPEC)

Jede `.md`-Datei im Vault braucht valides Frontmatter: `id` (ULID, 26 Zeichen,
überlebt Umbenennen), `type`, `title`, `created` (unveränderlich), `updated`
(wird automatisch gesetzt). Doc-Types sind eine geschlossene Liste (`note`,
`capture`, `project`, `task`, `decision`, `meeting`, `skill`, u. a.). Ein
Pre-Commit-Hook blockt Commits mit ungültigem Frontmatter — der Vault kann
strukturell nicht verrotten.

## Remote-Deployment

Für den produktiven Einsatz auf einem eigenen Server (z. B.
[Coolify](https://coolify.io)) gibt es zwei dokumentierte Wege:

| Datei | Wann nehmen |
|---|---|
| `docker-compose.coolify.yml` | **Empfohlen.** Alle sechs Services in einer Coolify-Application — ein Netz, native Docker-DNS-Auflösung, keine Cross-Resource-Fallen. |
| `docker-compose.coolify-demo.yml` | Minimal-Variante für eine schnelle Einzelservice-Demo (nur Postgres + Brain, PWA/API auf einer Domain). |

Details: **[→ docs/DEPLOY.md](docs/DEPLOY.md)**

## Projekt-Status

**Beta.** Produktiv im Einsatz, aktiv weiterentwickelt. Fertig & getestet:

- Git-Service (lokal *und* remote, mit/ohne Forgejo) als first-class State
- Notes-, Graph- und Pipes-Service, voller Datei-Baum mit Struktur-Bearbeitung
- CM6-Editor mit Live-Preview + Wikilink-Parsing
- Setup-Wizard inkl. lokalem Vault ohne externe Abhängigkeit
- MCP-Server mit 29 Tools, Multi-Tenant-Token-Scoping
- Semantische Suche (Tier 1 + Tier 2)

Offen: Tier-3-Knowledge-Graph (siehe oben), Graph-Frontend
(react-force-graph), Whisper-Handler für Sprachnachrichten.

## Zugriff & Mitwirken

Dieses Repo ist **privat mit gezielter Freigabe** — Zugriff nur für
eingeladene Personen. Wenn du Zugriff möchtest, wende dich an
[@oliverhees](https://github.com/oliverhees).

## Lizenz

**Proprietär** — [LICENSE](LICENSE). Kurz gesagt: als eingeladene Person
darfst du die Software installieren, ausführen und für eigene Zwecke nutzen
(auch mit deinen eigenen KI-Systemen über MCP), aber nicht weitergeben,
weiterverbreiten oder ohne ausdrückliche schriftliche Zustimmung des
Rechteinhabers weiterverkaufen. Alle Rechte, die hier nicht explizit
eingeräumt werden, bleiben beim Rechteinhaber.
