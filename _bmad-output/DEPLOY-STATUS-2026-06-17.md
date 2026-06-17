# Lokyy-Brain — Coolify-Deploy-Status (2026-06-17)

> Stand-/Resume-Notiz nach langer Deploy-Session. **Die Software läuft** — offen ist nur
> die Coolify-/Box-Stabilität. Compose: `docker-compose.coolify.yml` (All-in-One),
> Coolify-Projekt-UUID `ep9uacbdwdmynwzylyr7rd3g`, Domain `…kimiboca.de`.

## Bewiesen funktionierend
Aus den `lokyy-brain`-Containerlogs (Server-Stage):
```
[db] migration skipped (already applied): 0000_initial … 0016_forgejo_oauth_tokens_encrypt
[lokyy-brain] LLM registry initialised — registered: [ollama], errors: 0
[lokyy-brain] sleep-agent scheduler armed
lokyy-brain Server laeuft auf :8787
```
Alle 16 Migrationen sind durch, Server bindet :8787. **Kein Code-/DB-Bug.**

## 7 gelöste Deploy-Probleme (alle committet auf main)
1. **DNS/Netz** (EAI_AGAIN auf Postgres-Resource) → All-in-One statt separater Resource (postgres im selben Compose).
2. **POSTGRES_PASSWORD fehlte** → bundled-Postgres braucht Passwort.
3. **PG18-Daten-Layout** (ParadeDB `:latest` = PG18) → Mount `/var/lib/postgresql` + frisches Volume `postgres-data-pg`.
4. **Eingebettete Coolify-Magic-Var** (`${SERVICE_PASSWORD_POSTGRES}` in URL wird NICHT expandiert) → festes internes DB-Passwort `lokyybraininternal` (DB ist compose-intern, kein `ports:`).
5. **Falsches Build-Target** — `lokyy-brain` baute Default-Stage (=`mcp`) → `[lokyy-mcp-http] missing LOKYY_DB_URL`. Fix: `build.target: server` (mcp: `target: mcp`).
6. **Healthcheck nutzte `curl`**, das im `node:22-bookworm-slim` fehlt → node-Port-Check; danach Diagnose `exit 0`.
7. **Coolify-Netzwerk** „declared as external, but could not be found" → `docker network create <uuid>` bzw. Stop→Deploy.

## OFFEN — der eine verbleibende Punkt
`lokyy-brain` startet sauber, läuft ~30 s, wird dann **gekillt** und endet mit Fehler
(Coolify-Restart-Policy: 10× dann gestoppt). **NICHT der Healthcheck** — bewiesen, weil
es auch mit `test: ["CMD-SHELL","exit 0"]` (immer gesund) weiter restartet.

### Leithypothesen (nach Wahrscheinlichkeit)
1. **cgroup-Memory-Limit → OOM-Kill (Exit 137).** Box: 7,6 GB RAM (+6 GB Swap nachträglich),
   schwerer Stack (ParadeDB + Ollama + 3 Node-Dienste). Host-`dmesg` zeigte kein OOM, aber
   ein Coolify-gesetztes Container-Mem-Limit würde per cgroup killen, ohne im Host-dmesg
   aufzutauchen.
2. Coolify-seitiger SIGKILL/SIGTERM aus anderer Logik.
3. Selbstbeendigung des Prozesses ~30 s nach Start (unhandled rejection o. Ä.).

### Nächster Schritt (jetzt vorbereitet)
`lokyy-brain` steht auf `restart: "no"` → nach **einem** Crash bleibt der Container als
„Exited" stehen (kein 10×-Loop, kein Cleanup-Rennen). **Einmal deployen, dann sofort:**
```bash
cid=$(docker ps -a --format '{{.Names}}' | grep lokyy-brain | head -1)
docker inspect "$cid" --format 'Exit={{.State.ExitCode}} OOM={{.State.OOMKilled}} Err={{.State.Error}}'
docker inspect "$cid" --format 'MemLimit={{.HostConfig.Memory}}'
```
- `Exit=137`/`OOM=true` o. `MemLimit` klein → Coolify-Resource-Memory-Limit hoch/aus.
- sonst → Coolify-Kill bzw. Prozess-Selbstbeendigung weiter eingrenzen.

## Nach erfolgreicher Stabilisierung (Aufräumen)
- `restart: "no"` → zurück auf `unless-stopped`.
- Healthcheck `exit 0` → zurück auf den node-Port-Check (`net.connect` 8787/8788).
- `depends_on … service_started` → zurück auf `service_healthy`.
- ParadeDB von `:latest` auf eine feste Version **pinnen** (PG18-Überraschung vermeiden).
- Dann erst: App-Domain → Setup-Wizard → Forgejo-OAuth → karpathy-Vault → Demo.
