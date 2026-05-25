# Lokyy-Brain — Coolify Resources + App Deploy

> **Empfohlenes Deploy-Pattern (Architektur B):** Postgres + Ollama + Forgejo
> als separate Coolify-**Resources**, lokyy-brain + lokyy-pwa + lokyy-mcp als
> einzige Coolify-**Application**.
>
> Vorteile:
> - kleinere Build-Container (nur 3 Lokyy-Images bauen statt 3 + 3 Vendor-Pulls
>   parallel — vermeidet OOM-Kills Exit 255 auf Build-Servern <6 GB RAM)
> - saubere Resource-Lifecycles (Ollama-Update unabhängig vom App-Deploy)
> - separate Backups pro Service
> - kein Domain-Picker-Confusion mehr (Postgres/Ollama brauchen keine Domain)

Alternative: das All-in-One-Pattern in [`DEPLOY.md`](DEPLOY.md) auf Basis von
`docker-compose.coolify.yml` — einfacher, aber RAM-intensiver beim Build.

---

## Voraussetzungen

- Coolify v4 auf einem VPS mit mindestens **8 GB RAM** (Postgres + Ollama +
  Forgejo + 3 Lokyy-Services ≈ 6 GB Steady-State; Build-Container braucht
  zusätzlich ~3 GB temporär — bei <4 GB Build-RAM gibt es OOM).
- Mindestens **30 GB freier Disk** (Ollama-Modelle ~3 GB, Postgres + Vault
  wachsen mit der Nutzung).
- Eine Domain mit DNS-Kontrolle und vier A-Records:

| Subdomain | Zweck |
|-----------|-------|
| `api.lokyy.example.tld` | lokyy-brain (REST API) |
| `lokyy.example.tld` | lokyy-pwa (Browser-UI) |
| `mcp.lokyy.example.tld` | lokyy-mcp (claude.ai Custom Connector) |
| `vault.lokyy.example.tld` | Forgejo (Vault Git UI) |

Warte auf DNS-Propagation (`dig +short lokyy.example.tld`) bevor du startest —
Coolifys Traefik braucht funktionierendes DNS für Let's-Encrypt-Zertifikate.

---

## Phase 1: Resources anlegen

Alle drei Resources gehören ins **selbe Coolify-Project** wie die spätere App.
Coolify packt Resources eines Projects automatisch in ein gemeinsames Docker-
Netzwerk, sodass die App sie unter ihrem Service-Namen erreicht (`postgres`,
`ollama`, `forgejo`).

### 1.1 Postgres-Resource (ParadeDB)

Wichtig: das Standard-Postgres-Template von Coolify hat **kein `pg_search`**.
lokyy-brain braucht ParadeDB (bringt `pgvector` + `pg_search` mit) für die
Tier-2-Hybrid-Suche.

1. Project → **+ New Resource** → **Service** → **Docker Compose** (Custom).
2. Name: `postgres-paradedb`
3. Compose:

   ```yaml
   services:
     postgres:
       image: paradedb/paradedb:latest
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

4. Environment → setze `POSTGRES_PASSWORD` (mindestens 24 Zeichen, z. B.
   `openssl rand -hex 32`).
5. Deploy.

**Interner Hostname:** `postgres` (= Compose-Service-Name).
**Connection-URL für die App:** `postgres://postgres:<password>@postgres:5432/lokyy_brain`

### 1.2 Ollama-Resource

Coolify hat ein One-Click-Template für Ollama.

1. Project → **+ New Resource** → **Service** → suche **Ollama** → deploy.
2. Coolify deployed Ollama in <30 s.
3. **Pull das Embedding-Modell (einmalig, nach Deploy):**

   ```bash
   # In Coolifys Web-Terminal des Ollama-Containers ODER per SSH:
   docker exec -it <ollama-container> ollama pull nomic-embed-text
   # Optional, für lokales Privacy-Max-Profil (~5 GB Download):
   # docker exec -it <ollama-container> ollama pull llama3.1:8b
   ```

**Interner Hostname:** `ollama`.
**URL für die App:** `http://ollama:11434`

### 1.3 Forgejo-Resource

Coolify hat ein One-Click-Template für Forgejo.

1. Project → **+ New Resource** → **Service** → suche **Forgejo** → deploy.
2. **Domain setzen** (`vault.lokyy.example.tld`) — Forgejo braucht eine
   öffentliche URL, damit lokyy-brain's `git push` per HTTPS funktioniert.
3. Setup-Wizard im Browser durchlaufen:
   - Admin-User anlegen (z. B. `oliver`).
   - In den Settings → **Application Token** erstellen (Scope: `repo:write`)
     und den Token notieren — wird als `FORGEJO_TOKEN` in der App gesetzt.
   - Leeres Repo `lokyy-vault` anlegen (wird vom Setup-Wizard initialisiert).

**Interner Hostname:** `forgejo`.
**URL für die App (Container-intern, schneller als HTTPS-Roundtrip):**
`http://forgejo:3000/oliver/lokyy-vault`

---

## Phase 2: Lokyy-Brain Application anlegen

### 2.1 Application erstellen

1. Project → **+ New Resource** → **Application** → **Public Repository**.
2. Source:
   - Repository: `https://github.com/oliverhees/lokyy-brain`
   - Branch: `main`
3. Build-Pack: **Docker Compose**.
4. **Compose File Path: `docker-compose.coolify-app.yml`** (← der neue, nicht
   der All-in-One).

### 2.2 Domains setzen

Inside Application → **Domains** → für jeden Service "Add Domain":

| Service | Domain |
|---------|--------|
| `lokyy-brain` | `https://api.lokyy.example.tld` |
| `lokyy-pwa` | `https://lokyy.example.tld` |
| `lokyy-mcp` | `https://mcp.lokyy.example.tld` |

Coolify injiziert daraufhin automatisch `SERVICE_FQDN_LOKYYBRAIN_8787`,
`SERVICE_FQDN_LOKYYPWA_80`, `SERVICE_FQDN_LOKYYMCP_8788` und schreibt die
passenden Traefik-Labels.

### 2.3 Environment-Variablen setzen

Coolify → Application → **Environment**:

```bash
# Connections zu den Resources (Hostnames = Service-Namen aus Phase 1)
DATABASE_URL=postgres://postgres:<dein-postgres-pw>@postgres:5432/lokyy_brain
OLLAMA_HOST=http://ollama:11434
OLLAMA_EMBED_MODEL=nomic-embed-text

# Forgejo
GIT_REMOTE=http://forgejo:3000/oliver/lokyy-vault
GIT_BRANCH=main
GIT_AUTHOR_NAME=lokyy-brain
GIT_AUTHOR_EMAIL=lokyy-brain@lokyy.example.tld

# MCP — Bearer-Token, mit dem claude.ai sich authentifiziert
LOKYY_MCP_TOKEN=<openssl rand -hex 32>
LOKYY_AGENT_ID=claude-code

# Vault-ID: leer beim First-Deploy, wird nach dem Setup-Wizard gefüllt (Phase 4).
LOKYY_VAULT_ID=

# Optional (auch in der Settings-UI pro Vault einstellbar):
SUPADATA_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
COHERE_API_KEY=
```

### 2.4 Deploy

Click **Deploy**. Coolify klont den Repo und baut die drei Lokyy-Images
(~3–5 min). Wenn `lokyy-brain` und `lokyy-pwa` healthy sind, weiter zu Phase 3.

`lokyy-mcp` wird crash-loopen, weil `LOKYY_VAULT_ID` noch leer ist — das ist
erwartet, der Rest der App läuft trotzdem.

---

## Phase 3: Cross-Resource-Verbindungen testen

Aus dem `lokyy-brain` Application-Container (Coolify → Terminal):

```bash
# Postgres erreichbar? (TCP-Check; Postgres spricht kein HTTP, aber der Name
# muss resolven und der Port offen sein.)
nc -zv postgres 5432         # → "postgres (10.x.x.x:5432) open"

# Ollama liefert JSON?
curl -sS http://ollama:11434/api/version   # → {"version":"..."}

# Forgejo liefert JSON?
curl -sS http://forgejo:3000/api/v1/version  # → {"version":"..."}
```

Wenn **"Cannot resolve postgres / ollama / forgejo"** kommt: Resources und
Application liegen nicht im selben Coolify-Project oder nicht im selben
Docker-Netzwerk. Prüfen:

- Coolify → Server → **Networks**: alle Resources + die App sollten im
  `coolify` Default-Network sein.
- Notfalls: Coolify → Resource → Settings → "Connect to Network" → das
  Application-Network manuell verbinden.

---

## Phase 4: Setup-Wizard + MCP wiring

1. **Setup-Wizard:** Öffne `https://lokyy.example.tld`, durchlaufe die drei
   Schritte (Admin-User → Forgejo-Verbindung → Vault-Init). Detaillierte
   Anleitung in [`DEPLOY.md`](DEPLOY.md#6-run-the-setup-wizard).
2. **Vault-ULID auslesen:**

   ```bash
   # Coolify → Postgres-Resource → Terminal:
   psql -U postgres -d lokyy_brain -c "SELECT id FROM vaults;"
   ```
3. **`LOKYY_VAULT_ID` setzen:** Coolify → Application → Environment →
   `LOKYY_VAULT_ID=<ulid>` → "Redeploy only `lokyy-mcp`".
4. **MCP-Health prüfen:**

   ```bash
   curl https://mcp.lokyy.example.tld/mcp/health
   # → {"ok":true,"sessions":0}
   ```

---

## Phase 5: claude.ai Custom Connector

- URL: `https://mcp.lokyy.example.tld/mcp`
- Auth-Header: `Authorization: Bearer <LOKYY_MCP_TOKEN>`

Verbindung in claude.ai → Settings → Connectors → "+ Add custom connector".

---

## Troubleshooting

**Build OOM-killed (Exit 255):** sehr unwahrscheinlich mit diesem Pattern —
es bauen nur 3 Node-Images. Falls trotzdem: Coolify → Server → Settings →
"Build-Container RAM Limit" auf 4 GB+ setzen, oder Build auf einem stärkeren
Host machen und das Image per `ghcr.io` pushen.

**Resources nicht erreichbar (DNS-Fehler beim App-Start):** Resources und App
müssen im **selben Coolify-Project** sein. Coolify packt nur projektinterne
Ressourcen ins gleiche Default-Netzwerk.

**`postgres connect refused` / `pg_search` fehlt:** Die Postgres-Resource
nutzt nicht das `paradedb/paradedb`-Image. Coolifys Standard-Postgres reicht
nicht aus. Resource neu anlegen mit dem Custom-Compose aus 1.1.

**`lokyy-mcp` crash-loopt nach Vault-ID-Set:** Token-Whitespace ist die
häufigste Ursache. Coolifys Env-Editor pasted gelegentlich Newlines.
`LOKYY_MCP_TOKEN` neu setzen (one-liner, kein Trailing-Newline).

**Forgejo nicht erreichbar von der App aus:** wenn du Forgejo via Domain
ansprechen willst (`https://vault.lokyy.example.tld/...`), muss DNS und TLS
schon funktionieren. Schneller und stabiler: container-internen Hostnamen
verwenden (`http://forgejo:3000/...`) — der ist immer da und braucht kein
Zertifikat.

**Ollama "model not found":** `nomic-embed-text` wurde nicht gepullt. Aus
Phase 1.2: `docker exec -it <ollama-container> ollama pull nomic-embed-text`.

---

## Update-Workflow

- **App-Update (Code-Change):** Coolify → Application → Redeploy. Resources
  bleiben unangetastet, Daten bleiben in den Resource-Volumes.
- **Postgres-Major-Upgrade:** Resource → Settings → Image-Tag ändern,
  vorher Volume-Snapshot in Coolify aktivieren.
- **Ollama-Modell wechseln:** `ollama pull <new-model>` im Ollama-Container,
  dann `OLLAMA_EMBED_MODEL` in der App auf den neuen Namen setzen,
  `lokyy-brain` redeployen.
