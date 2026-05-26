# lokyy-brain — Lean Deploy (externes Forgejo)

> **Setup für den Fall:** Forgejo läuft bereits auf einem anderen Server.
> Auf der lokyy-brain-Box deployt Coolify nur:
>
> - **Application** (3 Services): `lokyy-brain`, `lokyy-pwa`, `lokyy-mcp` aus
>   [`docker-compose.coolify-app.yml`](../docker-compose.coolify-app.yml).
> - **Postgres-Resource** (ParadeDB) — getrennter Lifecycle, eigene Backups.
> - **Ollama-Resource** — nur `nomic-embed-text` (~270 MB), kein Chat-Modell.
>
> Gegenüber [`DEPLOY-RESOURCES.md`](DEPLOY-RESOURCES.md) entfällt die
> Forgejo-Resource komplett. `GIT_REMOTE` zeigt per HTTPS+Token auf das externe
> Forgejo.
>
> Alternative: [`DEPLOY.md`](DEPLOY.md) für das All-in-One-Pattern mit
> Forgejo-on-the-same-host.

---

## Voraussetzungen

- Coolify v4 auf einem VPS mit **4 GB RAM + 20 GB Disk** (deutlich kleiner als
  All-in-One, weil keine Forgejo-Daten lokal liegen).
- Externes Forgejo erreichbar per HTTPS und ein **Application Token** mit Scope
  `repo:write` für den Vault-Repo (z. B. `oliver/lokyy-vault`).
- Drei A-Records für die App-Subdomains (Postgres und Ollama brauchen **keine**
  Domain — bleiben privat im Coolify-Netz):

| Subdomain | Zweck |
|-----------|-------|
| `api.lokyy.example.tld` | `lokyy-brain` (REST API) |
| `lokyy.example.tld` | `lokyy-pwa` (Browser-UI) |
| `mcp.lokyy.example.tld` | `lokyy-mcp` (claude.ai Custom Connector) |

`dig +short api.lokyy.example.tld` muss VOR dem ersten Deploy auflösen, sonst
schlägt Let's-Encrypt-Issuance fehl.

---

## Phase 1 — Resources anlegen

Beide Resources gehören ins **selbe Coolify-Project** wie die spätere
Application, sonst landen sie nicht im gleichen Docker-Netzwerk und die App
findet `postgres` / `ollama` nicht per DNS.

### 1.1 Postgres (ParadeDB)

Coolifys Standard-Postgres-Template hat **kein `pg_search`**. Das brauchen wir
für Tier-2-Hybrid-Suche → Custom Compose:

1. Project → **+ New Resource** → **Service** → **Docker Compose** (Custom)
2. Name: `postgres-paradedb`
3. Compose (Block unten **flush-left** in Coolify einfügen, keine führenden
   Leerzeichen — Coolify validiert YAML strikt):

```yaml
services:
  postgres:
    image: paradedb/paradedb:latest-pg17
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=lokyy_brain
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d lokyy_brain"]
      interval: 5s
      timeout: 5s
      retries: 12
    restart: unless-stopped
volumes:
  postgres_data:
```

> **Warum `latest-pg17` statt `latest`?** Ab Postgres 18 erwartet das offizielle
> Docker-Image den Mount auf `/var/lib/postgresql` (Major-Version-Subdir-
> Konvention, siehe [postgres/pull/1259](https://github.com/docker-library/postgres/pull/1259)).
> Mit der bisherigen `/data`-Mount-Konvention crash-loopt der Container.
> ParadeDB tagged seine Images pro Major (`latest-pg17`, `latest-pg16`) — pg17
> ist stabil, hat pgvector + pg_search, und vermeidet die Mount-Migration.
> Wenn du auf PG18+ willst: Image auf `paradedb/paradedb:latest` setzen UND
> Volume-Mount auf `/var/lib/postgresql` (ohne `/data`) UND Volume neu anlegen.

4. Environment → `POSTGRES_PASSWORD=$(openssl rand -hex 32)`
5. Deploy.

**Interner Hostname (NICHT `postgres`!):**
Coolify belegt den DNS-Alias `postgres` im shared-Netz `coolify` für seine
**eigene** System-DB (`coolify-db`). Wenn du in deiner App `postgres:5432`
connectest, landest du dort, nicht bei deiner ParadeDB → permanente Auth-Fails.

Verwende stattdessen den **Container-Namen** der ParadeDB-Resource. Den findest
du via Host-Shell:

```bash
docker ps --format "{{.Names}}" | grep -i postgres
# → postgres-<RESOURCE-UUID>     (das ist deine ParadeDB)
# → coolify-db                   (Coolifys System-DB, NICHT verwenden)
```

**App-URL:** `postgres://postgres:<password>@postgres-<RESOURCE-UUID>:5432/lokyy_brain`

Die `<RESOURCE-UUID>` ist stabil über Redeploys — sie ist die Coolify-Resource-
ID, nicht die Container-Instance-ID.

### 1.2 Ollama (nur Embeddings)

1. Project → **+ New Resource** → **Service** → **Ollama** → deploy.
2. Sobald healthy: Embedding-Modell pullen (Coolify-Terminal des Ollama-
   Containers oder per SSH):

   ```bash
   docker exec -it <ollama-container> ollama pull nomic-embed-text
   ```

   ~270 MB Download. Kein Chat-Modell — Chat läuft über Cloud-Provider (siehe
   Phase 2.3).

**Interner Hostname:** `ollama` · **App-URL:** `http://ollama:11434`

---

## Phase 2 — Lokyy-Application anlegen

### 2.1 Application erstellen

1. Project → **+ New Resource** → **Application** → **Public Repository**
2. Repository: `https://github.com/oliverhees/lokyy-brain` · Branch: `main`
3. Build-Pack: **Docker Compose**
4. **Compose File Path:** `docker-compose.coolify-app.yml`

### 2.2 Domains setzen

Application → **Domains** → für jeden Service "Add Domain":

| Service | Domain |
|---------|--------|
| `lokyy-brain` | `https://api.lokyy.example.tld` |
| `lokyy-pwa` | `https://lokyy.example.tld` |
| `lokyy-mcp` | `https://mcp.lokyy.example.tld` |

Coolify injiziert daraufhin `SERVICE_FQDN_LOKYYBRAIN_8787`,
`SERVICE_FQDN_LOKYYPWA_80`, `SERVICE_FQDN_LOKYYMCP_8788` und schreibt die
Traefik-Labels automatisch.

### 2.3 Environment-Variablen

Application → **Environment**:

```bash
# Connections zu den Resources.
# WICHTIG: NICHT `@postgres:5432` verwenden — das ist Coolifys interne System-DB.
# Stattdessen den Container-Namen der ParadeDB-Resource: postgres-<RESOURCE-UUID>.
# UUID findest du via: docker ps --format "{{.Names}}" | grep -i postgres
DATABASE_URL=postgres://postgres:<postgres-password>@postgres-<PARADEDB-UUID>:5432/lokyy_brain
OLLAMA_HOST=http://ollama:11434
OLLAMA_EMBED_MODEL=nomic-embed-text

# Externes Forgejo — Auth per Token im URL.
# Token: Forgejo → User Settings → Applications → Generate New Token
#        Scope: repo:write. Den Token im URL URL-encoden, falls Sonderzeichen.
GIT_REMOTE=https://<forgejo-user>:<forgejo-token>@vault.example.tld/oliver/lokyy-vault
GIT_BRANCH=main
GIT_AUTHOR_NAME=lokyy-brain
GIT_AUTHOR_EMAIL=lokyy-brain@example.tld

# MCP — Bearer-Token, mit dem claude.ai sich authentifiziert
LOKYY_MCP_TOKEN=<openssl rand -hex 32>
LOKYY_AGENT_ID=claude-code

# Vault-ID: leer beim First-Deploy, wird in Phase 4 gefüllt.
LOKYY_VAULT_ID=

# Optional (auch per-Vault in Settings-UI)
SUPADATA_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
COHERE_API_KEY=
```

### 2.4 Deploy

Click **Deploy**. Coolify klont den Repo, baut die drei Lokyy-Images (~3–5 min)
und startet sie. `lokyy-brain` + `lokyy-pwa` werden healthy. `lokyy-mcp`
crash-loopt, weil `LOKYY_VAULT_ID` noch leer ist — erwartet, kommt in Phase 4.

---

## Phase 3 — Cross-Resource-Verbindung verifizieren

Aus dem `lokyy-brain` Application-Container (Coolify → Terminal):

```bash
nc -zv postgres 5432                       # → postgres (10.x.x.x:5432) open
curl -sS http://ollama:11434/api/version   # → {"version":"..."}
curl -sS https://vault.example.tld/api/v1/version  # externes Forgejo erreichbar?
```

Wenn "Cannot resolve postgres / ollama": Resource und App liegen nicht im
selben Coolify-Project → Coolify → Server → **Networks** prüfen.

---

## Phase 4 — Setup-Wizard + MCP wiring

Da der externe Vault **bereits existiert**, geht's nur um die DB-Records und
den Vault-Pull:

1. Öffne `https://lokyy.example.tld` — Setup-Wizard erscheint
   (`setup_complete=false` in DB).
2. **Schritt 1:** Admin-User anlegen (email + Passwort).
3. **Schritt 2:** Forgejo-Verbindung — gib `GIT_REMOTE` ein (denselben Wert
   wie in Phase 2.3, inkl. Token). Der Wizard ruft `git ls-remote` auf — wenn
   das grün ist, ist die Auth okay.
4. **Schritt 3:** Vault-Init — der Server klont den existierenden Vault nach
   `/var/lokyy/vault` (`ensureRepo()` in `packages/core/src/git/gitService.ts`).
   Bestehende Inhalte werden **nicht** überschrieben; der Wizard scaffold nur
   die DB-Row.
5. Finish → `setup_complete=true`.

### Vault-ULID auslesen + MCP aktivieren

```bash
# Coolify → Postgres-Resource → Terminal:
psql -U postgres -d lokyy_brain -c "SELECT id FROM vaults;"
```

→ Coolify → Application → Environment → `LOKYY_VAULT_ID=<ulid>` →
"Redeploy only `lokyy-mcp`".

Health-Check:

```bash
curl https://mcp.lokyy.example.tld/mcp/health
# → {"ok":true,"sessions":0}
```

---

## Phase 5 — claude.ai Custom Connector

- URL: `https://mcp.lokyy.example.tld/mcp`
- Auth-Header: `Authorization: Bearer <LOKYY_MCP_TOKEN>`

claude.ai → Settings → Connectors → "+ Add custom connector".

---

## Troubleshooting

**`git clone` schlägt mit `Authentication failed` fehl** — Token hat nicht den
`repo:write`-Scope, oder Sonderzeichen im Token sind nicht URL-encoded.
Test: `git ls-remote $GIT_REMOTE` aus dem `lokyy-brain` Terminal.

**`pg_search` extension missing** — die Postgres-Resource nutzt nicht das
`paradedb/paradedb`-Image. Die Migration `0004_pg_search` braucht es. Resource
mit dem Compose aus 1.1 neu anlegen.

**Wizard sagt "Postgres connection failed"** — `DATABASE_URL` löst auf
`localhost` auf statt `postgres`. Im Container muss der Hostname der
Compose-Service-Name sein (`postgres`).

**Ollama "model not found"** — `nomic-embed-text` wurde nicht gepullt.
`docker exec -it <ollama-container> ollama pull nomic-embed-text`.

**`lokyy-mcp` crash-loopt nach Vault-ID-Set** — meist Token-Whitespace im
`LOKYY_MCP_TOKEN`. Coolifys Env-Editor paste-t gelegentlich Newlines.
Neu setzen, one-liner, kein Trailing-Newline.

---

## Update-Workflow

- **App-Code-Change:** Coolify → Application → Redeploy. Postgres + Ollama
  bleiben unangetastet.
- **Postgres-Major-Upgrade:** Resource → Settings → Image-Tag ändern. Vorher
  Volume-Snapshot in Coolify aktivieren.
- **Externes Forgejo umgezogen:** `GIT_REMOTE` updaten, `lokyy-brain` redeployen.
  Beim nächsten Start macht der Service `git remote set-url` implizit über den
  neuen Clone (nur falls `VAULT_DIR` leer ist — sonst manuell im Container).
