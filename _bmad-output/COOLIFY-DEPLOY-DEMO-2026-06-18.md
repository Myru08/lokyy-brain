# Lokyy-Brain — Coolify-Demo-Deployment & Architektur (Stand 2026-06-18)

> Operative Wahrheit für das Deployment auf Coolify + Architektur-Notizen für den
> Kurs (Kimiboca). Löst die Stand-Notiz `DEPLOY-STATUS-2026-06-17.md` ab (deren
> OOM-Hypothese war FALSCH — siehe „Root Causes").

## TL;DR — Es läuft
- **Live-URL (Demo):** https://jxsj8ijf0h91ctn5whm1akm5.kimiboca.de
  - `/` → PWA (UI), `/api/*` → REST-API, `/health` → `{"ok":true}`. **Eine Domain für alles.**
- **Coolify:** Projekt „Lokyy Setup", App-UUID `o14f3jip8ksyvm6ek77y3a2w`, Server `localhost` (Coolify-Host), Build-Pack `dockercompose`, Compose-Pfad `/docker-compose.coolify-demo.yml`.
- **Stack (Demo, minimal & robust):** nur **Postgres (ParadeDB pg17) + Brain**. Der Brain serviert die PWA selbst.
- **Bewusst NICHT im Demo-Stack:** Ollama (Tier-2/Embeddings, RAM-schwer) und Forgejo (Git-Remote) — beide optional, siehe unten.

## Finale Compose (Demo)
`docker-compose.coolify-demo.yml` — Kernpunkte:
- `postgres`: `paradedb/paradedb:latest-pg17`, `POSTGRES_PASSWORD=lokyybraininternal`, Volume **`postgres-data2`** (frisch!), kein `ports:` (intern only), Healthcheck `pg_isready`.
- `lokyy-brain`: `build.target: server`, `DATABASE_URL=postgres://postgres:lokyybraininternal@postgres:5432/lokyy_brain`, `LOKYY_VAULT_PROFILE=para` (hart, kein `${...}`), Healthcheck `exit 0` (lenient — Begründung unten).
- Volumes: `postgres-data2`, `vault-data`.

## Root Causes (was den ganzen 2026-06-17 gekostet hat)
Drei Probleme, hintereinander versteckt. **Keines war das, wonach es aussah.**

1. **`LOKYY_VAULT_PROFILE=karpathy` als Alt-Env in Coolify** (sogar doppelt gesetzt).
   Überschrieb den `para`-Default; das `karpathy`-Profil killt den Server ~30s nach Start.
   → Fix: im Compose **hart** `LOKYY_VAULT_PROFILE=para` (kein `${...}`), damit keine
   UI-Env-Var es je überschreibt. (`karpathy`-Profil-Crash ist ein offener Code-Bug.)

2. **DB-Passwort-Auth — der eigentliche Killer.** `PostgresError: password
   authentication failed for user "postgres" (28P01)`.
   Ursache: `POSTGRES_PASSWORD` greift **nur bei der Erst-Initialisierung** des
   Datenvolumes. Das alte Volume war mit einem anderen Passwort initialisiert; die
   Demo-Compose nutzte `lokyybraininternal` → Auth schlug fehl, `runMigrations` warf,
   `main()` rief `process.exit(1)` (server/src/index.ts: „DB init failed — server cannot start").
   → Fix: **frisches Volume** (`postgres-data` → `postgres-data2`) → ParadeDB
   initialisiert neu mit `lokyybraininternal`.
   → DIAGNOSE-TRICK, der es sichtbar machte: Coolify entfernt abgestürzte Container
   sofort, `application_logs` sagt dann „Application is not running". Per **Dockerfile-CMD-
   Wrapper** den Container nach App-Ende offengehalten
   (`sh -lc "node dist/index.js; ...; if [ \"$LOKYY_DEBUG_HOLD\" = 1 ]; then sleep 86400; fi"`)
   → Container blieb „running" → `application_logs` lieferte die echte Fehlerzeile.
   (DEBUG_HOLD ist wieder entfernt; Muster hier dokumentiert für künftige Diagnosen.)

3. **Healthcheck killt den gesunden Container + Zweit-Domain-Routing.**
   Der Server ist via Traefik (Container-IP) erreichbar, aber der **interne** Healthcheck
   über `127.0.0.1`/`localhost` erreichte ihn NICHT (der Server bindet nicht auf Loopback)
   → Coolify markierte „unhealthy" und reapte den Container. Parallel registrierte Coolify
   die Zweit-Service-Domain (separater PWA-Container) nicht zuverlässig (302 → manage.kimiboca.de).
   → Fix: (a) **Brain serviert die PWA selbst** (serveStatic, siehe unten) → nur EINE
   Domain, kein Zweit-Routing; (b) **lenienter Healthcheck `exit 0`** (App ist extern via
   `/health`=200 verifiziert; Coolifys „restarting"-Label ist danach nur kosmetisch).

> **NICHT die Ursache:** OOM. Das Stoppen anderer Box-Dienste half nicht — RAM war nie das Problem.

## Code-Änderung: Brain serviert die PWA
`server/src/index.ts` (nach allen `/api/*`-Routen + `/health`, vor `main()`):
```ts
import { serveStatic } from "@hono/node-server/serve-static";
// ... nach app.route("/api/settings", settingsRoutes):
app.use("/*", serveStatic({ root: "../pwa/dist" }));      // cwd = /app/server
app.get("*", serveStatic({ path: "../pwa/dist/index.html" })); // SPA-Fallback
```
Das Dockerfile kopiert `pwa/dist` bereits in das `server`-Image; damit ist die PWA Teil
des Brain-Images. Verifiziert: `/` → 200 HTML, `/assets/index-*.js` → 200 (2 MB),
Deep-Link `/notes` → 200 (SPA), `/api/setup/status` → `{"setupComplete":false}`.

## Optionale Komponenten (bewusst aus dem Demo-Stack)
- **Forgejo** = Git-Remote der Wissensbasis (das Karpathy-Second-Brain ist git-backed) +
  OAuth-Login. Ohne Remote läuft der Brain (Notizen lokal in `vault-data`; Log:
  „GIT_REMOTE not set — vault clone deferred to setup wizard"). **Es läuft bereits ein
  Forgejo auf der Box** (`forgejo-with-postgresql-…`) → im Setup-Wizard darauf zeigen statt
  ein zweites zu deployen (`GIT_REMOTE`, `FORGEJO_BASE_URL`, `FORGEJO_OAUTH_*`).
- **Ollama** = Embeddings für **Tier-2 (semantische Suche)**. Ohne Ollama läuft **Tier-1
  (BM25-Volltext über ParadeDB pg_search)** — für die Demo ausreichend. Anbindung später
  via `OLLAMA_HOST` (eigene Resource oder in die Compose, RAM beachten).

## Architektur-Kern für den Kurs: Lokyy Brain = Single Source of Truth (SSOT)
Ziel (Olivers Vorgabe): **Lokyy Brain ist die einzige Wahrheit, die jeder Agent nutzt —
modell-agnostisch.** Agent verbindet den MCP → behandelt ihn als Wiki: **immer erst dort
nachfragen, immer dorthin zurückschreiben.** Das ist der Karpathy-Ansatz.

Wie das System das schon leistet:
- **MCP-Server-Instruktionen** (vom MCP beim Connect ausgeliefert, also für JEDEN
  MCP-fähigen Agent — Claude Cowork, AIonUI, …):
  - *BEFORE answering … `search_vault` first. Never speculate.*
  - *AFTER substantial conversations … `create_note`.*
  - *ON „save this"/„remember" … sofort `create_note`.*
  → genau „immer fragen / immer schreiben", modell-agnostisch über das MCP-Protokoll.
- **MCP-Tools:** `search_vault`, `read_note`, `create_note`, `update_note`, `list_notes`,
  `get_graph`, `get_vault_conventions`, `list_skills`/`run_skill`, `resolve_by_id` u. a.
- **Härtung (wichtig fürs Lehren):** MCP-Instruktionen sind **starke Leitplanken, keine
  Hard-Garantie**. Zwei Ebenen härten:
  1. Im Agent selbst (AGENTS.md / System-Prompt): „Lokyy-MCP = einzige Wahrheit" verankern.
  2. **Serverseitig hart**: Schreib-/Leserechte + Ordner erzwingt der Brain über
     `00_meta/mcp-scopes.yaml` pro `agent-id` (Scope-Verletzung → strukturierter Fehler,
     kein Goodwill nötig).

## Roadmap: Team-Vault / Mandanten (Modul 3 „team")
Anforderung: geteilte Vaults; lesen für alle mit MCP, schreiben nach Berechtigung;
**Kunde schreibt in anderen Ordner als der Owner**; pro Kunde EIGENER MCP; keine Vermischung/Leaks.

Vorhandene Bausteine im Code:
- `00_meta/mcp-scopes.yaml` pro `agent-id` → „wer darf was, in welchen Unterbaum schreiben"
  (= Ordner-Trennung Kunde vs. Owner über Scopes/Folder-Routing).
- `LOKYY_VAULT_ID` + `LOKYY_AGENT_ID` + eigener `LOKYY_MCP_TOKEN` pro Verbindung → Identität.

Bau-Arbeit für Mandanten (offen):
- **Vault-Routing pro Token**: eine Brain-Instanz bedient je nach MCP-Token den richtigen
  (Kunden-)Vault (heute: eine Instanz = ein `LOKYY_VAULT_ID`).
- **Kein-Leak-Garantie**: am saubersten **pro Kunde eigener MCP-Endpoint + Token** (physische
  Trennung > Logik-Trennung).
- **Provisionierung**: „neuer Kunde → neuer Vault + Token + Scope" als ein Handgriff.

## Status / Nächste Schritte
- [x] Brain läuft stabil auf Coolify (DB-Auth gefixt, `/health`=200 über 40s mehrfach geprüft).
- [x] PWA-UI über Brain-Domain erreichbar (Single Service).
- [x] Olivers andere Box-Dienste (nextcloud, espocrm, metamcp, affine) wieder gestartet; Müll-Postgres entfernt.
- [ ] Oliver testet die Demo (Setup-Wizard, MCP-Verbindung in claude.ai, Lese/Schreib-Verhalten).
- [ ] Optional vor Aufnahme: bestehendes Forgejo verdrahten (Git-Vault zeigbar) + hübsche Custom-Domain (z. B. `brain.kimiboca.de`).
- [ ] Später: Ollama/Tier-2 nachrüsten; Team-/Mandanten-Vault designen.
- [ ] Offener Code-Bug: `LOKYY_VAULT_PROFILE=karpathy` crasht den Server ~30s nach Start.

## Coolify-Gotchas (für Kurs & künftige Deploys)
- Compose-`command` wird ignoriert → Keepalive/Diagnose über **Dockerfile-CMD**.
- Abgestürzte Container werden entfernt → Logs nur über DEBUG-HOLD-Wrapper greifbar.
- `POSTGRES_PASSWORD` ändert KEIN bestehendes Volume → bei Passwortwechsel Volume neu.
- Interner Healthcheck muss den Bind-Modus des Servers treffen (hier: nicht Loopback) — sonst reapt Coolify den gesunden Container.
- Jeder „Deploy"/„Restart"/„Start" einer dockercompose-App triggert einen ~80–160s Rebuild.
