# lokyy-brain — Coolify Deploy Guide

End-to-end recipe for deploying lokyy-brain on a self-hosted Coolify VPS.
Targets the `docker-compose.coolify.yml` stack: server + PWA + MCP + Forgejo +
ParadeDB + Ollama.

---

## Deploy-Pattern wählen

Es gibt zwei unterstützte Wege:

1. **All-in-one** (`docker-compose.coolify.yml`, dieses Dokument): alle sechs
   Services in einer Coolify-Application. Einfacher (ein Resource-Item), aber
   RAM-intensiv beim Build — geeignet wenn dein Coolify-Build-Server ≥6 GB
   freien RAM hat. Bei kleineren Build-Hosts gibt's gerne OOM-Kills
   (Exit 255).
2. **Resources + App** (`docker-compose.coolify-app.yml`, **empfohlen**):
   Postgres + Ollama + Forgejo als separate Coolify-Resources, nur die drei
   Lokyy-Services (`lokyy-brain`, `lokyy-pwa`, `lokyy-mcp`) als Application.
   Vermeidet Build-OOM, bietet saubere Lifecycles und separate Backups pro
   Service. Schritt-für-Schritt in [DEPLOY-RESOURCES.md](DEPLOY-RESOURCES.md).

Der Rest dieses Dokuments beschreibt das **All-in-one-Pattern**.

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
| `lokyy.example.tld` | A | VPS IP | `lokyy-brain` (REST API) + `lokyy-pwa` (UI) |
| `mcp.lokyy.example.tld` | A | VPS IP | `lokyy-mcp` (claude.ai Custom Connector) |
| `forgejo.lokyy.example.tld` | A | VPS IP | `forgejo` (vault git) |

Wait for DNS propagation (`dig +short lokyy.example.tld`) before continuing —
Coolify's Traefik needs working DNS to fetch Let's Encrypt certificates.

---

## 2. Add the project to Coolify

1. Coolify UI → **Projects** → **+ Add**.
2. Resource type: **Docker Compose**.
3. Source: **Public Git Repository** (or your fork).
   - Repository URL: `https://github.com/oliverhees/lokyy-brain`
   - Branch: `main`
   - Compose File Path: `docker-compose.coolify.yml`
4. Save. Don't deploy yet.

---

## 3. Attach domains to each service

Inside the new resource → **Domains** tab. For each service, click "Add Domain":

| Service | Add Domain |
|---------|------------|
| `lokyy-brain` | `https://lokyy.example.tld` |
| `lokyy-pwa` | `https://lokyy.example.tld` *(same FQDN if you split paths; or `ui.lokyy.example.tld`)* |
| `lokyy-mcp` | `https://mcp.lokyy.example.tld` |
| `forgejo` | `https://forgejo.lokyy.example.tld` |

Coolify auto-injects matching `SERVICE_FQDN_LOKYYBRAIN_8787`,
`SERVICE_FQDN_LOKYYPWA_80`, `SERVICE_FQDN_LOKYYMCP_8788`,
`SERVICE_FQDN_FORGEJO_3000` env vars and writes Traefik labels.

---

## 4. Set environment variables

In the Coolify UI → **Environment Variables**, paste the contents of
[`.env.coolify.example`](../.env.coolify.example) and replace the `CHANGE_ME_*`
placeholders. The variables Coolify provides automatically (the `SERVICE_FQDN_*`
ones) are NOT pasted manually — they appear once you attach domains in step 3.

Mandatory at first deploy:
- `POSTGRES_PASSWORD` — `openssl rand -hex 32`
- `LOKYY_MCP_TOKEN` — `openssl rand -hex 32` (this is the Bearer token claude.ai sends)
- `GIT_AUTHOR_EMAIL`
- `GIT_REMOTE` — set to the future Forgejo URL, e.g.
  `https://forgejo.lokyy.example.tld/oliver/lokyy-vault` (the repo is created in step 6).

Leave empty for now (filled in step 6):
- `LOKYY_VAULT_ID`

Optional:
- `OLLAMA_PULL_CHAT=true` to pre-pull `llama3.1:8b` (~5 GB; only if you want
  fully local LLM and have the RAM).
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `COHERE_API_KEY` — can also be added
  later via the Settings UI; the DB row wins over the env var.

---

## 5. First deploy

Click **Deploy**. Coolify will:

1. Clone the repo.
2. Build `lokyy-brain`, `lokyy-pwa`, `lokyy-mcp` images (first build ~5-8 min).
3. Pull `paradedb/paradedb`, `ollama/ollama`, `codeberg.org/forgejo/forgejo:9`.
4. Start everything in dependency order.
5. Fetch TLS certs from Let's Encrypt for each attached domain.

`lokyy-mcp` will crash-loop on the first deploy because `LOKYY_VAULT_ID` is
empty — that's fine, the rest of the stack still comes up. The PWA and the
Setup Wizard work without MCP.

Watch the logs. When `lokyy-brain` reaches `lokyy-brain Server laeuft auf :8787`
and `postgres`, `forgejo`, `lokyy-pwa` are **healthy** in the UI, proceed.

---

## 6. Run the Setup Wizard

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

## 7. Wire MCP

1. SSH into the VPS (or use Coolify's terminal shell on the postgres container).
2. Grab the vault ID:

   ```bash
   docker exec $(docker ps -q -f name=postgres) \
     psql -U postgres -d lokyy_brain -c "SELECT id FROM vaults;"
   ```

3. Coolify → Environment Variables → set `LOKYY_VAULT_ID=<that-ulid>`.
4. Redeploy **only** `lokyy-mcp` (Coolify → Services → lokyy-mcp → Redeploy).

Verify:

```bash
curl https://mcp.lokyy.example.tld/mcp/health
# {"ok":true,"sessions":0}
```

---

## 8. Verify a note write hits Forgejo

1. In the PWA → New Note → "Hello from Coolify" → save.
2. Inside Forgejo → `lokyy-vault` repo → latest commit should be your save.
3. Wikilinks / graph view should populate within a few seconds (Tier 1 index).

---

## 9. Configure AI providers (optional)

PWA → Settings → AI Providers. Add an Anthropic, OpenAI, or Cohere key.
Alternatively rely on local Ollama if `OLLAMA_PULL_CHAT=true` was set.

The Settings UI calls `PUT /api/llm/config` which persists keys to
`llm_providers` table and re-initializes the runtime registry.

---

## 10. Connect AI clients

### claude.ai Custom Connector
- URL: `https://mcp.lokyy.example.tld/mcp`
- Auth: `Bearer <LOKYY_MCP_TOKEN>`

### Cursor / Claude Desktop / other MCP-stdio clients
Use the MCP setup CLI from a developer machine:

```bash
pnpm --filter @lokyy/mcp setup -- \
  --remote https://mcp.lokyy.example.tld/mcp \
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

**`lokyy-mcp` keeps crash-looping after step 7** — check `LOKYY_VAULT_ID` is
set correctly. Also confirm `LOKYY_MCP_TOKEN` has no leading/trailing
whitespace (Coolify env editor sometimes pastes a newline).

**`pg_search` extension missing** — you're not on the ParadeDB image. Confirm
`postgres.image = paradedb/paradedb:latest`. The first migration that needs it
is `0004_pg_search`.

**Ollama init never finishes** — first model pull is ~270 MB
(`nomic-embed-text`) and can take several minutes on slow uplinks. Re-run
`docker compose up ollama-init` on the host if it timed out.

**`git push` rejected by pre-commit hook** — your vault repo is missing the
SPEC-mandated `.forgejo/hooks/pre-commit`. Setup Wizard installs it
automatically on a fresh repo. If you brought an existing repo, copy the hook
from `packages/core/src/vault/hooks/pre-commit` manually.

**Wizard says "Postgres connection failed"** — `DATABASE_URL` resolved to a
host outside the compose network. Inside Coolify the host must be `postgres`,
not `localhost`.
