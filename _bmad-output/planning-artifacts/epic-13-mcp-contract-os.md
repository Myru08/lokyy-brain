# Epic 13 — Brain MCP-Contract für OS-Integration

Status: in-progress

> **Quelle:** [[50_decisions/2026-05-31-brain-os-mcp-grenze]] (Vault) + OS-ADR-004 (`/mnt/projekte/eigene_projekte_neu/lokyy/docs/decisions/ADR-004-lokyy-brain-mcp-contract.md`, „Proposed"). Brain ist SSOT → **Brain definiert den kanonischen Contract**, OS (lokyy-mcp BrainAdapter) konsumiert ihn.

## Ziel
Brain liefert die von OS erwartete MCP-Oberfläche, sodass Hermes/lokyy-mcp als Brain-Backend andocken kann. 6 der 8 Contract-Tools existieren bereits (nur Rename); diese Lücken schließen — ohne Brains bestehende 25 Tools zu brechen.

## Design (verbindlich)
- **`notes.create_managed` ist der EINZIGE sanktionierte Schreibpfad** (OS-ADR-004/ISC-59): Intent `{title, body, type, tags?, folder_hint?}` → **Brain leitet den Pfad aus `type` ab** (Logik existiert: Type→Ordner aus Story 10.2), besitzt ULID/created/updated/Frontmatter. Agenten konstruieren NIE Pfade/Frontmatter.
- **Dotted-Aliase als dünne Fassade** über die bestehenden snake_case-Tools — Brains reiche Oberfläche bleibt, OS bekommt den vereinbarten Contract.
- Brains `NoteType`-Enum ist Superset (tool/resource/reference/peer/skill) → abwärtskompatibel; ADR-004-Enum wird erweitert.

## Stories
| Story | Titel | Kern-Files |
|-------|-------|-----------|
| **13.1** | **MCP-Contract-Oberfläche**: `notes.create_managed`-Fassade (intent→type-basierte Platzierung) + 3 fehlende MCP-Wrapper (`graph.get`, `pipes.import`, `pipes.status`) + 8 dotted-Aliase (`notes.read`/`notes.list_by_type`/`notes.search`/`notes.update_content`/`vault.tree` → bestehende Tools). Tests. | `mcp/src/server.ts`, ggf. `packages/core/src/notes/` (create_managed-Helper), `mcp/src/server.test.ts` |
| **13.2** | **Scope/Enum/Auth-Abgleich**: OS-ADR-004-Scope-Schema (conductor/researcher/writer/coder/curator/bridge) gegen Brains `00_meta/mcp-scopes.yaml`; NoteType-Enum-Doku; ADR-005-Auth (JWT) sichten. Liest OS-ADR-005 + scopes. | `00_meta/mcp-scopes.yaml` (Vault), Doku |
| **13.3** | **Contract-ADR finalisieren** (Brain-seitig kanonisch) als Vault-ADR — der dokumentierte Target für OS. | `50_decisions/…-brain-mcp-contract-final` (Vault) |

## DoD
`pnpm -r build` grün · `notes.create_managed` erzeugt SPEC-valide Notiz aus Intent (Pfad aus type, kein client-path) · alle 8 Contract-Tools über MCP aufrufbar · bestehende 25 Tools unverändert (Regression) · Tests grün.

## Reihenfolge
13.1 (Oberfläche, jetzt) → 13.3 (Contract-ADR aus gebautem Stand) → 13.2 (Scope/Auth, parallel zur OS-Verdrahtung).
