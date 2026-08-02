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

## 2. Fork erstellen

Für ein Remote-Deployment brauchst du **einen eigenen Fork** dieses Repos.

**Warum?** Coolify ist ein Server und kann sich nicht mit deinem persönlichen
GitHub-Zugang anmelden — es braucht einen eigenen Schlüssel, der direkt am
Repository hängt (einen „Deploy-Key"). Eintragen darf den nur, wer
Admin-Rechte am Repo hat: in deinem eigenen Fork bist du das, im Original
nicht. Das ist der übliche Weg — bei jedem anderen selbst gehosteten Projekt
läuft es genauso.

1. Oben rechts auf **Fork** klicken. Dein Fork ist ebenfalls privat und gehört
   dir.
2. In Coolify später **deinen Fork** als Repository angeben, nicht das Original.

> **Updates einspielen:** Dein Fork zieht Änderungen nicht automatisch nach.
> Wenn eine neue Version erscheint, in deinem Fork auf **„Sync fork" →
> „Update branch"** klicken (ein Klick im GitHub-UI), danach in Coolify neu
> deployen. Ein `git pull` in einem Clone deines Forks holt **nur deinen
> Fork** — nicht das Original.

---

## 3. Add the project to Coolify

1. Coolify UI → **Projects** → **+ Add**.
2. Resource type: **Docker Compose**.
3. Source: **Private Repository (with deploy key)** — Coolify erzeugt ein
   Schlüsselpaar und zeigt dir den **öffentlichen** Teil. Diesen in deinem Fork
   unter **Settings → Deploy keys → Add deploy key** eintragen. Schreibzugriff
   wird **nicht** gebraucht, Coolify muss nur lesen.
   - Repository: **dein Fork**, z. B. `dein-name/lokyy-brain`
   - Branch: `main`
   - Compose File Path: `docker-compose.coolify.yml`
4. Save. Don't deploy yet.

> **Häufiger Stolperstein:** GitHub erlaubt denselben Schlüssel nur bei *einem
> einzigen* Repository als Deploy-Key. Nutzt dein Coolify denselben Key schon
> für ein anderes Projekt, lehnt GitHub ihn ab — dann in Coolify ein neues
> Schlüsselpaar speziell für dieses Repo erzeugen.

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
- `LOKYY_MCP_TOKEN` — `openssl rand -hex 32` (this is the Bearer token claude.ai sends;
  ohne diese Var deaktiviert `mcpMount.ts` den `/mcp`-Endpoint komplett)
- `GIT_AUTHOR_EMAIL`
- `GIT_REMOTE` — set to the future Forgejo URL, e.g.
  `https://forgejo.lokyy.example.tld/oliver/lokyy-vault` (the repo is created in step 6).

**Nicht** manuell setzen: `POSTGRES_PASSWORD`. Im All-in-one-Pattern erzeugt
Coolify das DB-Passwort als Auto-Secret `SERVICE_PASSWORD_POSTGRES` und
expandiert es sowohl im `postgres`-Service als auch in der `DATABASE_URL`.

Leave empty for now (filled in step 6):
- `LOKYY_VAULT_ID`

Optional:
- `LOKYY_OAUTH_PASSWORD` / `LOKYY_OAUTH_SIGNING_SECRET` — für den OAuth-2.1-Flow
  des claude.ai-Connectors. Ohne Wert fallen beide auf `LOKYY_MCP_TOKEN` zurück;
  in Produktion ein eigenes `openssl rand -hex 32` für das Signing-Secret setzen.
- `OLLAMA_PULL_CHAT=true` to pre-pull `llama3.1:8b` (~5 GB; only if you want
  fully local LLM and have the RAM).
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
`LOKYY_VAULT_ID` leer ist bzw. der Vault noch nicht existiert. Das ist erwartet
und **kein** Crash: `initMcp()` ist best-effort und bricht den Brain-Start nicht
ab, UI und Setup-Wizard laufen normal.

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

1. SSH into the VPS (or use Coolify's terminal shell on the postgres container).
2. Grab the vault ID:

   ```bash
   docker exec $(docker ps -q -f name=postgres) \
     psql -U postgres -d lokyy_brain -c "SELECT id FROM vaults;"
   ```

3. Coolify → Environment Variables → set `LOKYY_VAULT_ID=<that-ulid>`.
4. Redeploy `lokyy-brain` — der MCP-Mount wird beim Brain-Start initialisiert,
   also übernimmt erst ein Neustart die neue Vault-ID.

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

## 10. Configure AI providers (optional)

PWA → Settings → AI Providers. Add an Anthropic, OpenAI, or Cohere key.
Alternatively rely on local Ollama if `OLLAMA_PULL_CHAT=true` was set.

The Settings UI calls `PUT /api/llm/config` which persists keys to
`llm_providers` table and re-initializes the runtime registry.

---

## 11. Connect AI clients

### claude.ai Custom Connector
- URL: `https://lokyy.example.tld/mcp`
- Auth: `Bearer <LOKYY_MCP_TOKEN>`

### Cursor / Claude Desktop / other MCP-stdio clients
Use the MCP setup CLI from a developer machine:

```bash
pnpm --filter @lokyy/mcp setup -- \
  --remote https://lokyy.example.tld/mcp \
  --token <LOKYY_MCP_TOKEN>
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
nicht initialisiert. Prüfe in dieser Reihenfolge: (1) `LOKYY_MCP_TOKEN` ist
gesetzt — ohne Token deaktiviert `mcpMount.ts` den Endpoint bewusst; (2)
`LOKYY_VAULT_ID` zeigt auf die richtige `vaults.id`; (3) `lokyy-brain` wurde
nach der Env-Änderung neu gestartet. Ein `[mcp-mount] MCP mounted at /mcp`
im Brain-Log bestätigt den Erfolg. Achte auf Whitespace am Token-Ende (der
Coolify-Env-Editor pastet gerne einen Newline mit).

**`/mcp` liefert die PWA statt einer MCP-Antwort** — dann läuft ein Reverse
Proxy vor dem Brain, der nur `/api/` durchreicht (z. B. der alte
`pwa/nginx.conf`-Layer). Im aktuellen Compose gibt es diesen Layer nicht mehr;
die Domain muss direkt auf `lokyy-brain:8787` zeigen.

**`pg_search` extension missing** — you're not on the ParadeDB image. Confirm
`postgres.image = paradedb/paradedb:latest-pg17`. The first migration that needs
it is `0004_pg_search`.

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

**Wizard says "Postgres connection failed"** — `DATABASE_URL` resolved to a
host outside the compose network. Inside Coolify the host must be `postgres`,
not `localhost`.
