# Lokyy Brain — Mandanten-/Team-Vault-Design (M3) — 2026-06-19

> Bau-Spezifikation **und** Kursmaterial. Ziel: pro Kunde ein **isolierter** Vault,
> ein **eigener MCP-Token** mit **eigenen Rechten**, **angelegt & verwaltet im
> Lokyy-Brain-Dashboard**. Entscheidung (Oliver, 2026-06-19): eigenes Forgejo-Repo
> pro Kunde; Dashboard-Verwaltung Pflicht; „tragfähiger Kern zuerst".

## 1. Zielbild
- **Ein** öffentlicher MCP-Endpoint: `https://lokyy-brain.kimiboca.de/mcp`.
- Der **Bearer-Token** bestimmt **Vault + Rolle** (jeder Kunde = eigener Token).
- **Ein Vault = ein Forgejo-Repo** = eine eigene Working-Copy → physische Isolation
  (Kunde A kann Kunde B technisch nie sehen — der „kein-Leak"-Garant).
- **Rechte** pro Token (read / write) + optional Ordner-Scope; Kunde schreibt in
  seinen Bereich, Owner sieht/schreibt alles in DIESEM Kundenvault.
- **Dashboard**: Kundenvaults + MCP-Tokens + Rechte anlegen, sehen, verwalten, widerrufen.

## 2. Warum so (statt Alternativen)
- **Ein Container pro Kunde**: ❌ Box-RAM-Limit (bewiesen: Zweitcontainer killt den Brain per OOM). Token-Routing skaliert auf einer Instanz.
- **Ein Repo, Unterordner pro Kunde**: ❌ Isolation nur per Scope-Logik (Software) — ein Bug = Leak. Eigenes Repo = physisch getrennt.

## 3. Datenmodell
- **`mcp_tokens`** (NEU): `id`, `token_hash` (SHA-256 des Bearer; Klartext nie at-rest), `vault_id`, `agent_id`, `role` (`read` | `write`), `label`, `created_at`, `last_used_at`, `revoked_at`. Lookup je Request über den Hash.
- **`vaults`** (vorhanden): + `kind` nutzen (`personal` | `customer`), `gitRemote`/`gitBranch` pro Vault. Optional `customer_label`.
- **`vaultMemberships`** (vorhanden): Owner = admin-Mitglied jedes Kundenvaults; der Kunde wird NICHT als Brain-User angelegt (er hat nur den MCP-Token). Sein Schreib-Agent-Id (z. B. `kunde-<slug>`) wird in der Vault-`mcp-scopes.yaml` deklariert.

## 4. Architektur-Kernänderung: single-vault → multi-vault
Heute ist der Brain **fest auf einen Vault** verdrahtet. Nötig:
- **Working-Copy pro Vault:** statt `config.vaultDir` (eine Working-Copy) →
  `<root>/vaults/<vaultId>/`. `gitService` von „Singleton auf einem Dir" auf
  „pro-Vault-Instanz (eigener Pfad + eigener Serialize-Lock)" umbauen.
- **Per-Request-Auflösung im MCP:** Bearer → `mcp_tokens` → `{vaultId, agentId, role}`.
  Die per-Session-`serverFactory()` (im StreamableHTTP-Transport) bekommt diesen
  Kontext → Tools werden an **diesen** Vault (Working-Copy + Memory-Provider +
  Scope) gebunden. (Der Memory-Provider ist bereits vault-id-gekeyt; die
  Working-Copy + Scopes müssen mitziehen.)
- **Scope-Durchsetzung serverseitig:** `role=read` → nur Lese-Tools; `role=write`
  → Schreib-Tools, begrenzt durch die Vault-`mcp-scopes.yaml`-Globs.

## 5. Dashboard-Verwaltung (Owner)
- **API** (admin-gated, Session des Owners): 
  `GET /api/tenants` (Liste Kundenvaults + Token-Metadaten + Rollen),
  `POST /api/tenants` (Kunde anlegen: Forgejo-Repo erstellen via Owner-Token →
  Working-Copy klonen → Token generieren → Scope schreiben → Membership),
  `POST /api/tenants/:vaultId/tokens` (weiteren Token/ Rolle), 
  `DELETE /api/tenants/:vaultId/tokens/:id` (widerrufen),
  `PATCH …/role`.
  Token wird bei Erstellung **einmalig** im Klartext zurückgegeben (danach nur Hash).
- **UI:** Dashboard-Bereich „Kunden / Mandanten" → Tabelle (Vault, Repo, Tokens,
  Rollen, letzter Zugriff), Buttons „Kunde anlegen", „Token erzeugen/kopieren",
  „widerrufen". Connector-URL + Token zum Kopieren für den Kunden.

## 6. Isolation-Garantien (Akzeptanzkriterien)
- Token A → nur Vault A erreichbar; jeder Zugriff auf Vault B mit Token A → 403, NIE Daten.
- Getrennte Working-Copies + getrennte Repos → kein gemeinsamer Pfad.
- Widerrufener Token → sofort 401.
- Owner sieht/verwaltet alle Kundenvaults im Dashboard; Kunden sehen nur ihren.

## 7. Phasenplan
**Phase 1 — tragfähiger Kern (sichere Isolation + minimale Verwaltung):**
1. `mcp_tokens`-Migration + Token-Hash-Lookup.
2. `gitService` multi-vault-fähig (Working-Copy pro vaultId).
3. MCP: Bearer → Token-Row → Vault+Rolle; `serverFactory` bindet pro Request den Vault; read/write-Rolle durchsetzen.
4. Provisionierung: `POST /api/tenants` (Repo anlegen + klonen + Token + Scope).
5. Minimaler Dashboard-Bereich: Kunde anlegen, Tokens sehen/kopieren/widerrufen.
→ Test nach jeder Teilstufe (Isolation: Token A darf Vault B nie lesen/schreiben).

**Phase 2 — Feinschliff:** Ordner-Scopes pro Schreiber (Kunde→`Kunde/**`, Owner→eigene),
Provisionierungs-UX, Audit/last_used, Rotation, Backup pro Vault.

## 8. Kursbezug
Genau dieser Mechanismus (geteilte, isolierte Vaults pro Kunde via MCP-Token) ist
der Modul-3-„team"-Inhalt: Mandantenfähigkeit als verkaufbares Feature lehren.

## 9. Sicherheit/Aufräumen (sofort, vor Kundenbetrieb)
Die temporären **unauth Debug-Routen** entfernen: `/api/setup/_reset`,
`/api/setup/_reclone`, `/api/forgejo/_probe`. (Risiko: jemand setzt Setup zurück.)
