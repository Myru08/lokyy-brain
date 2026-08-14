# lokyy-brain — Coolify Deploy Guide

End-to-end recipe for deploying lokyy-brain on a self-hosted Coolify VPS.
Targets the `docker-compose.coolify.yml` stack: Brain + Forgejo + ParadeDB +
Ollama.

> **Ein Container für UI, API und MCP.** Der `lokyy-brain`-Prozess serviert die
> PWA auf `/` ([`server/src/index.ts`](../server/src/index.ts)), die REST-API auf
> `/api/*` und den MCP-Endpoint für den claude.ai-Connector in-process auf `/mcp`
> ([`server/src/mcpMount.ts`](../server/src/mcpMount.ts)). Separate `lokyy-pwa`-
> und `lokyy-mcp`-Container gibt es **nicht mehr**: der
> nginx-PWA-Layer proxyte nur `/api/` und machte `/mcp` unerreichbar, und der
> Standalone-MCP-Container überbuchte das RAM der Box und riss das Brain mit.
> Du brauchst deshalb nur **eine** Lokyy-Domain, nicht drei.

---

## Deploy-Pattern

**All-in-one** (`docker-compose.coolify.yml`, dieses Dokument) — alle vier
Services in einer Coolify-Application, ein Netz, native Docker-DNS-Auflösung.
Braucht einen Build-Host mit ≥6 GB freiem RAM; bei kleineren Hosts gibt's gerne
OOM-Kills (Exit 255) — dann die Build-Ressourcen in Coolify hochsetzen.

Für eine schlanke Einzelservice-Demo statt des vollen Stacks siehe
`docker-compose.coolify-demo.yml` im Repo-Root.

---

## 1. Prerequisites

- A VPS with Coolify v4 installed and reachable on its dashboard URL.
- A domain you control with DNS managed (Cloudflare, Hetzner DNS, etc.).
- Enough resources on the VPS:
  - 4 vCPU / 8 GB RAM minimum (16 GB recommended if you pull `llama3.1:8b`).
  - 40 GB free disk (Postgres + Ollama models + vault grow over time).
- Outbound network access from the VPS (Forgejo pulls/pushes, Ollama model pulls,
  optional Anthropic/OpenAI API calls).

### DNS records to create (BEFORE first deploy)

| Subdomain | Type | Target | Used by |
|-----------|------|--------|---------|
| `lokyy.example.tld` | A | VPS IP | `lokyy-brain` — UI (`/`), REST API (`/api/*`) und MCP (`/mcp`) |
| `forgejo.lokyy.example.tld` | A | VPS IP | `forgejo` (vault git) |

Eine eigene `mcp.`-Subdomain ist **nicht** mehr nötig — der MCP-Endpoint liegt
als Pfad `/mcp` auf der Brain-Domain.

Wait for DNS propagation (`dig +short lokyy.example.tld`) before continuing —
Coolify's Traefik needs working DNS to fetch Let's Encrypt certificates.

---

## 2. Repository wählen — Fork optional

Lokyy Brain ist **öffentlich**. Coolify kann direkt aus
`https://github.com/oliverhees/lokyy-brain` deployen — kein Fork, kein
Deploy-Key, keine Zugangsdaten nötig. Für den Standardfall überspringst du
diesen Schritt einfach.

**Wann ein Fork trotzdem sinnvoll ist:**

- Du willst eigene Änderungen am Code deployen.
- Du willst selbst steuern, *wann* eine neue Version bei dir landet, statt bei
  jedem Push auf `main` automatisch mitzugehen.

Dann oben rechts auf **Fork** klicken und in Coolify deinen Fork angeben.

> **Updates in einem Fork:** Dein Fork zieht Änderungen nicht automatisch nach.
> Bei einer neuen Version im Fork auf **„Sync fork" → „Update branch"** klicken,
> danach in Coolify neu deployen. Ein `git pull` in einem Clone deines Forks
> holt **nur deinen Fork** — nicht das Original.

---

## 3. Add the project to Coolify

1. Coolify UI → **Projects** → **+ Add**.
2. Resource type: **Docker Compose**.
3. Source: **Public Repository** — URL `https://github.com/oliverhees/lokyy-brain`.
   Kein Deploy-Key, keine Zugangsdaten. (Nutzt du einen eigenen Fork und ist der
   privat, dann stattdessen **Private Repository (with deploy key)** und den von
   Coolify erzeugten öffentlichen Schlüssel in deinem Fork unter
   **Settings → Deploy keys** eintragen — Lesezugriff genügt.)
   - Branch: `main`
   - Compose File Path: `docker-compose.coolify.yml`
4. Save. Don't deploy yet.

---

## 4. Attach domains to each service

Inside the new resource → **Domains** tab. For each service, click "Add Domain":

| Service | Add Domain |
|---------|------------|
| `lokyy-brain` | `https://lokyy.example.tld` |
| `forgejo` | `https://forgejo.lokyy.example.tld` |

Coolify auto-injects the matching `SERVICE_FQDN_LOKYYBRAIN_8787` and
`SERVICE_FQDN_FORGEJO_3000` env vars and writes Traefik labels. Nur diese zwei
Services bekommen eine Domain; `postgres` und `ollama` bleiben ohne `ports:`
compose-intern.

---

## 5. Set environment variables

In the Coolify UI → **Environment Variables**, paste the contents of
[`.env.coolify.example`](../.env.coolify.example) and replace the `CHANGE_ME_*`
placeholders. The variables Coolify provides automatically (the `SERVICE_FQDN_*`
ones) are NOT pasted manually — they appear once you attach domains in step 3.

Mandatory at first deploy:
- `GIT_AUTHOR_EMAIL`
- `GIT_REMOTE` — set to the future Forgejo URL, e.g.
  `https://forgejo.lokyy.example.tld/oliver/lokyy-vault` (the repo is created in step 6).

**Nicht** manuell setzen: `POSTGRES_PASSWORD`. Im All-in-one-Pattern erzeugt
Coolify das DB-Passwort als Auto-Secret `SERVICE_PASSWORD_POSTGRES` und
expandiert es sowohl im `postgres`-Service als auch in der `DATABASE_URL`.

Leave empty for now (filled in step 6):
- `LOKYY_VAULT_ID`

Optional:
- `LOKYY_MCP_TOKEN` — Legacy-Bearer-Token. **Nicht mehr nötig:** den Token für
  die MCP-Anbindung erzeugst du nach dem Setup unter Einstellungen → MCP, er
  gilt sofort und ohne Neustart. Die Variable bleibt nur als Fallback für
  bestehende Installationen gültig. Lässt du sie leer, akzeptiert `/mcp`
  ausschließlich die in der Oberfläche erzeugten Token — der empfohlene Zustand.
- `LOKYY_CORS_ORIGINS` — nur nötig, wenn die PWA unter einer ANDEREN Domain
  liegt als die API und direkt auf sie zeigt. Beim All-in-one-Pattern teilen
  sich beide die FQDN → leer lassen. Komma-Liste vollständiger Origins
  (`https://ui.lokyy.example.tld`). Ein Wildcard ist nicht vorgesehen: die API
  authentifiziert per Session-Cookie, und `*` würde jede fremde Seite mitlesen
  lassen.
- `LOKYY_OAUTH_PASSWORD` / `LOKYY_OAUTH_SIGNING_SECRET` — für den OAuth-2.1-Flow
  des claude.ai-Connectors. Ohne Wert fallen beide auf `LOKYY_MCP_TOKEN` zurück;
  ist auch diese Variable leer, ist der OAuth-Flow **deaktiviert** (`/mcp`
  funktioniert weiterhin per Bearer-Token). Willst du den claude.ai-Connector
  nutzen, setze beide — für das Signing-Secret ein eigenes `openssl rand -hex 32`.
- `OLLAMA_PULL_CHAT=true` to pre-pull `llama3.1:8b` (~5 GB; only if you want
  fully local LLM and have the RAM). This is the model the **Privacy-Max**
  profile (all 10 roles local, zero cloud) routes every chat/classify/rewrite
  role at. If you leave `OLLAMA_PULL_CHAT=false`, the chat model is NOT pulled
  and Privacy-Max would silently no-op — but you don't have to redeploy: the
  **Einstellungen → AI-Provider → Lokale Modelle (Ollama)** panel shows any
  configured-but-missing model and installs it with one click (progress bar
  included). `GET /api/diagnostics` reports the same gap as an actionable
  finding. Plan for ~5 GB disk + ~8 GB RAM for `llama3.1:8b`.
- `LOKYY_OLLAMA_TIMEOUT_MS` — Timeout pro Ollama-Request in Millisekunden
  (Default 300000 = 5 min). Nur nötig, wenn lokale LLM-Rollen mit
  `This operation was aborted` abbrechen; siehe
  [Lokale Inferenz ist langsam](#lokale-inferenz-ist-langsam--timeout-und-ram-privacy-max).
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `COHERE_API_KEY` — can also be added
  later via the Settings UI; the DB row wins over the env var.

---

## 6. First deploy

Click **Deploy**. Coolify will:

1. Clone the repo.
2. Build the `lokyy-brain` image (`server` target; first build ~5-8 min).
3. Pull `paradedb/paradedb`, `ollama/ollama`, `codeberg.org/forgejo/forgejo:15`.
4. Start everything in dependency order.
5. Fetch TLS certs from Let's Encrypt for each attached domain.

Der `/mcp`-Endpoint meldet auf dem ersten Deploy `503 mcp-unavailable`, solange
der Vault noch nicht existiert. Das ist erwartet und **kein** Crash: `initMcp()`
ist best-effort und bricht den Brain-Start nicht ab, UI und Setup-Wizard laufen
normal. Sobald der Wizard durch ist, initialisiert sich `/mcp` beim nächsten
Request selbst — ohne Neustart.

Watch the logs. When `lokyy-brain` reaches `lokyy-brain Server laeuft auf :8787`
and `postgres` + `forgejo` are **healthy** in the UI, proceed.

---

## 7. Run the Setup Wizard

1. Open `https://lokyy.example.tld` in a browser.
2. The Setup Wizard appears (the server detects `setup_complete=false`).
3. Step 1 — create the admin user (email + password).
4. Step 2 — connect Forgejo:
   - Open `https://forgejo.lokyy.example.tld` in a second tab.
   - Register the first user (this becomes the Forgejo owner).
   - Create an empty repo named `lokyy-vault`.
   - In the Wizard, paste `https://forgejo.lokyy.example.tld/<user>/lokyy-vault`
     and the branch (`main`). The Wizard validates by running `git ls-remote`
     against the URL.
5. Step 3 — initialize the vault. The server clones the empty repo, scaffolds
   the SPEC frontmatter directories (`00_meta/`, `10_inbox/`, ...) and pushes
   the seed commit.
6. Finish. Server flips `setup_complete=true`.

---

## 8. Wire MCP

**Seit v1.11 ist hier nichts mehr zu tun.** Der Brain löst die Vault-ID selbst
auf und initialisiert den MCP-Mount beim ersten Request nach dem Setup-Wizard —
kein `LOKYY_VAULT_ID`, kein Redeploy. Den Bearer-Token erzeugst du in der
Oberfläche unter **Einstellungen → MCP** (siehe Abschnitt 11).

`LOKYY_VAULT_ID` bleibt nur für Sonderfälle nützlich: wenn in derselben
Datenbank mehrere Vaults liegen und du den MCP explizit auf einen davon
festnageln willst. Dann gilt weiterhin — Wert setzen, `lokyy-brain` neu
starten, weil die Variable beim Start gelesen wird:

```bash
docker exec $(docker ps -q -f name=postgres) \
  psql -U postgres -d lokyy_brain -c "SELECT id FROM vaults;"
```

Verify:

```bash
curl https://lokyy.example.tld/mcp/health
# {"ok":true,"sessions":0}
```

---

## 9. Verify a note write hits Forgejo

1. In the PWA → New Note → "Hello from Coolify" → save.
2. Inside Forgejo → `lokyy-vault` repo → latest commit should be your save.
3. Wikilinks / graph view should populate within a few seconds (Tier 1 index).

---

## 8b. Access control — what is reachable without a login

Since the session sweep (issue #37) **every data route requires a valid
`lokyy_session` cookie**: notes, vault tree, graph, search, pipes, dashboard,
settings, diagnostics and logs all answer `401` to an anonymous caller, and they
do so before reading a request body. This is the server's own guarantee — it
does not depend on a reverse proxy or on the port being firewalled.

Deliberately reachable without a session:

| Endpoint | Why |
|----------|-----|
| `/health` | Liveness. The `lokyy-updater` sidecar polls it while services restart. |
| `/api/setup/*` | Runs before the first user exists; closes itself once setup completes. |
| `/api/auth/*` | Login/register/logout. Requiring a session to get one is a deadlock. |
| `/api/auth/forgejo/*`, `/api/forgejo/*` | The OAuth wizard — usable pre-setup; every handler checks the session itself. |
| `/mcp` | Bearer token per request (DB-managed tokens or `LOKYY_MCP_TOKEN`). Cookie auth does not apply. |

`/api/admin/*`, `/api/tenants/*` and `/api/system/update/*` go one step further
and require `role=admin`.

Smoke test after a deploy — the first must be `401`, the second `200`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://lokyy.example.tld/api/notes
curl -s -o /dev/null -w '%{http_code}\n' https://lokyy.example.tld/health
```

**Local docker (`docker-compose.local.yml`)**: all host ports are published on
`127.0.0.1` only, so the stack is not exposed to the LAN. To reach it from
another device on purpose, drop the `127.0.0.1:` prefix from the specific port
line — and know that everyone on that network then sees the login page.

### Lokal vs. Remote erreichbar machen (`docker-compose.yml`)

The generic `docker-compose.yml` publishes three host ports — `8787` (API),
`3000` (Forgejo UI) and `2222` (Forgejo SSH) — and their bind address is a
single variable, `LOKYY_BIND_ADDR`:

| `LOKYY_BIND_ADDR` | Effect |
|-------------------|--------|
| _unset_ / `127.0.0.1` | **Default, safe.** Reachable only from the host itself. |
| `0.0.0.0` | Reachable from the whole network (every interface). |
| `<interface-ip>` | Reachable on that one interface only. |

The default keeps a fresh install off the network. Do **not** just flip it to
`0.0.0.0` to go remote: the recommended remote setup is a **reverse proxy that
terminates TLS** in front of the app, with `LOKYY_COOKIE_SECURE=true` so the
session cookie never travels over plain HTTP. The API already enforces login on
every data route (since the session sweep, issue #37), but the login exchange
itself must be encrypted. If the proxy runs on the same host, leave
`LOKYY_BIND_ADDR=127.0.0.1` and let the proxy reach the app over localhost;
only widen it when the proxy or client lives on another machine.

---

## 10. Configure AI providers (optional)

PWA → Settings → AI Providers. Add an Anthropic, OpenAI, or Cohere key.
Alternatively rely on local Ollama if `OLLAMA_PULL_CHAT=true` was set.

The Settings UI calls `PUT /api/llm/config` which persists keys to
`llm_providers` table and re-initializes the runtime registry.

### Lokale Inferenz ist langsam — Timeout und RAM (Privacy Max)

Lokale und Cloud-Inferenz liegen eine Größenordnung auseinander. Ein
Cloud-Modell antwortet in ein bis drei Sekunden; dasselbe `llama3.1:8b` auf
einer CPU rechnet jedes Token selbst — ohne GPU-Durchreichung sind **60 bis
120 Sekunden pro Aufruf normal**, nicht kaputt. Gemessen auf einer
Beta-Installation (Docker Desktop, Apple Silicon, keine GPU im Container):
**76,6 s für einen einzigen Aufruf.**

Deshalb hat der Ollama-Provider einen eigenen Default von **300 000 ms
(5 Minuten)** statt der 60 s, die für Cloud-Provider passen.

**Wann anheben:** wenn im Brain-Log Zeilen wie

```
[sleep-agent] topic-synthesis cluster "…" failed: This operation was aborted
```

stehen — das ist ein abgelaufener Timeout, kein Modellfehler. Dann

```
LOKYY_OLLAMA_TIMEOUT_MS=600000
```

setzen (Wert in Millisekunden) und den Brain-Container neu starten. Die
Variable gilt für alle Ollama-Aufrufe inklusive des lokalen Rerankers. Ein
ungültiger Wert (leer, nicht-numerisch, ≤ 0) wird ignoriert, der Default
greift, der Start bricht **nicht** ab.

**RAM ist die eigentliche Ursache.** `llama3.1:8b` belegt allein ~4,9 GB.
Wer Docker Desktop bei den Standardeinstellungen lässt (oft 7–8 GB für die
gesamte VM), betreibt zusätzlich Postgres, Forgejo und Brain im selben
Speicher — das Modell wird dann teilweise ausgelagert und jeder Aufruf
dauert ein Vielfaches. Für **Privacy Max** (alle LLM-Rollen lokal):

- **Docker Desktop → Settings → Resources → Memory: mindestens 12 GB**
  (16 GB empfohlen), CPUs so hoch wie die Maschine hergibt.
- ~5 GB freier Plattenplatz allein für das Chat-Modell.
- Alternativ ein kleineres Modell wählen (`llama3.2:3b`, ~2 GB) — spürbar
  schneller, aber schwächer bei Topic-Synthese.
- Wer eine NVIDIA-GPU durchreichen kann, löst das Zeitproblem vollständig;
  am RAM-Bedarf des Modells ändert das nichts.

---

## 11. Connect AI clients

Den Token erzeugst du in der Oberfläche: **Einstellungen → MCP → „Token
erzeugen"**. Er wird genau einmal angezeigt — gleich kopieren.

### claude.ai Custom Connector
- URL: `https://lokyy.example.tld/mcp`
- Auth: `Bearer <dein Token aus Einstellungen → MCP>`

### Cursor / Claude Desktop / other MCP-stdio clients
Use the MCP setup CLI from a developer machine:

```bash
pnpm --filter @lokyy/mcp setup -- \
  --remote https://lokyy.example.tld/mcp \
  --token <dein Token aus Einstellungen → MCP>
```

This generates the right `mcpServers` block for your client config.

---

## Troubleshooting

**Coolify build fails on `pnpm install`** — older Coolify builders sometimes
out-of-memory on the pnpm install layer. Bump the builder VM to 4 GB or run
the build on a beefier host and push the image.

**TLS cert stays in "pending"** — DNS hasn't propagated. Verify with
`dig +short lokyy.example.tld`. Let's Encrypt rate-limits failed challenges,
so wait 10 minutes before retrying.

**`/mcp` antwortet `503 mcp-unavailable` nach Schritt 7** — der MCP-Mount ist
nicht initialisiert, weil **kein Vault existiert**. Das ist der normale Zustand
vor dem Setup-Wizard; der Token ist daran unschuldig (ein falscher Token gäbe
`401`, nicht `503`). Sobald der Wizard durchgelaufen ist, initialisiert sich
`/mcp` beim nächsten Request selbst — ein **Neustart ist nicht nötig**. Bleibt
der 503 danach bestehen, prüfe: (1) das Brain-Log auf `no vault rows in DB`;
(2) `LOKYY_VAULT_ID` zeigt, falls gesetzt, auf die richtige `vaults.id`. Ein
`[mcp-mount] MCP mounted at /mcp` im Brain-Log bestätigt den Erfolg.

`LOKYY_MCP_TOKEN` ist dafür **nicht** mehr erforderlich: ist die Variable leer,
akzeptiert `/mcp` ausschließlich die in Einstellungen → MCP erzeugten Token —
das ist der empfohlene Zustand. Setzt du sie doch, achte auf Whitespace am Ende
(der Coolify-Env-Editor pastet gerne einen Newline mit).

**`/mcp` liefert die PWA statt einer MCP-Antwort** — dann läuft ein Reverse
Proxy vor dem Brain, der nur `/api/` durchreicht (z. B. der alte
`pwa/nginx.conf`-Layer). Im aktuellen Compose gibt es diesen Layer nicht mehr;
die Domain muss direkt auf `lokyy-brain:8787` zeigen.

**`pg_search` extension missing** — you're not on the ParadeDB image. Confirm
`postgres.image = paradedb/paradedb:latest-pg17`. The first migration that needs
it is `0004_pg_search`.

**`This operation was aborted` in den Sleep-Agent-Logs** — der Ollama-Timeout
ist abgelaufen, das Modell rechnet schlicht länger als erlaubt. Typisch auf
CPU-only-Installationen mit knappem Docker-Speicher.
`LOKYY_OLLAMA_TIMEOUT_MS` anheben und Docker mehr RAM geben — Herleitung und
Richtwerte in
[Lokale Inferenz ist langsam](#lokale-inferenz-ist-langsam--timeout-und-ram-privacy-max).

**Ollama init never finishes** — first model pull is ~270 MB
(`nomic-embed-text`) and can take several minutes on slow uplinks. Re-run
`docker compose up ollama-init` on the host if it timed out.

**Commit rejected by the pre-commit hook** — the hook found a `.md` without the
five required frontmatter fields, without a ULID `id`, or with a `type` that has
no `00_meta/schemas/<type>.json`. Fix the frontmatter; the hook prints the file
and the reason.

**Hook never runs at all** — the Setup Wizard installs it on a fresh vault as
`.githooks/pre-commit` and sets `git config core.hooksPath .githooks`. Git runs
hooks only from `core.hooksPath` (or `.git/hooks`), so a repo you brought
yourself needs that config set once by hand; copy the hook from
`packages/core/src/vault/hooks/pre-commit` if it is missing.

**`fatal: cannot exec '.githooks/pre-commit': No such file or directory`** —
JEDER Commit scheitert, jeder Save wirkt kaputt. Der Hook ist ein endungsloses
POSIX-Skript; wurde das Image aus einem Windows-Checkout gebaut
(`core.autocrlf=true`), trägt er CRLF, und der Linux-Kernel sucht dann den
Interpreter `/bin/sh\r`. **Lokyy repariert das seit v1.9.x beim Start selbst:**
der Hook wird auf LF normalisiert, ausführbar gemacht und — wenn er im
Vault-Repo versioniert ist — als `chore: pre-commit-Hook repariert
(Zeilenenden)` committet. Ein Neustart des Brain-Containers genügt also. Von
Hand geht es auch: `sed -i 's/\r$//' <vault>/.githooks/pre-commit && chmod +x
<vault>/.githooks/pre-commit`. Vorbeugend sorgt die `.gitattributes` des Repos
(`eol=lf`) dafür, dass die CRLF-Fassung gar nicht erst entsteht.

**Wizard says "Postgres connection failed"** — `DATABASE_URL` resolved to a
host outside the compose network. Inside Coolify the host must be `postgres`,
not `localhost`.
