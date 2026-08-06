# Story: Suchleiter + 8-Stufen-Pipeline an MCP anschließen (Paket A)

> **Tracking issue:** https://github.com/oliverhees/lokyy-brain-dev/issues/20

## Kontext

Befund (Web-Chat-Analyse 2026-08-05, im Code verifiziert): Das MCP-Tool `search_vault` ruft `getMemoryProvider().search()` (einfache Suche). Die 8-Stufen-Pipeline (`buildSearchPipeline`, `packages/core/src/pipeline/search.ts`) ist nur über `/api/search/pipeline` erreichbar — kein Client nutzt sie. Außerdem fehlt eine Kosten-Leiter für KI-Clients (erst Index, dann Suche, dann genau EINE Datei) und ein deterministischer Vault-Index.

## Scope / File-Set (dieser Agent besitzt exklusiv)

- `mcp/src/server.ts` (+ ggf. neue Dateien unter `mcp/src/`)
- `packages/core/src/pipeline/**`
- NEU: `packages/core/src/index/indexGenerator.ts` (+ Test)
- MCP-Tests unter `mcp/src/**`
- NICHT: `packages/core/src/git/gitService.ts` (gehört parallelem Agenten). Der INDEX.md-Write geht über die bestehende exportierte Save-API (`saveVaultFile`/`save`) — nur aufrufen, nicht ändern.

## Acceptance Criteria

1. **AC1 — A1 INDEX.md-Generator:** Deterministische Funktion (kein LLM): erzeugt `00_meta/INDEX.md` aus dem Vault-Baum — pro Ordner Zweck (aus README/erster Notiz ableitbar oder Ordnername), Notiz-Titel mit Pfaden, kompakt (< ~500 Zeilen bei großem Vault durch Ordner-Zusammenfassung). Idempotent: unveränderter Vault ⇒ identischer Output. Schreiben über gitService-Save-API, SPEC-Frontmatter beachten (type: reference).
2. **AC2 — A2 Suchleiter:** MCP-Server-Instructions enthalten die verbindliche Brain-First-Leiter: (1) `get_index`, (2) `search_vault` fast, (3) bei Bedarf `search_vault` deep, (4) genau EINE Datei per `read_note` öffnen — mit Begründung „Token-Kosten". Bestehende Instructions-Struktur beibehalten.
3. **AC3 — A3 Pipeline-Schalter:** `search_vault` bekommt optionalen Parameter `mode: "fast" | "deep"` (Default fast = heutiges Verhalten, byte-identisch). `deep` ruft `buildSearchPipeline`. Tool-Name bleibt `search_vault` (MCP-Namensregel: ^[a-zA-Z0-9_-]{1,64}$, keine Punkte — Guard-Test existiert).
4. **AC4 — A4 get_index:** Neues MCP-Tool `get_index`: liefert `00_meta/INDEX.md`-Inhalt; wenn nicht vorhanden/älter als 24h → on-the-fly regenerieren (deterministisch, schnell). Tool-Beschreibung erklärt die Leiter.
5. **AC5:** `mode`-Fehlverhalten abgesichert: unbekannter mode ⇒ sauberer Tool-Error mit isError (Bestand: Story 7-9).
6. **AC6:** Bestehende 87+ MCP-Tests bleiben grün; neue Tests für mode-Routing, get_index (vorhanden/fehlend), Index-Determinismus.
7. **AC7:** `MCP-INTEGRATION.md` dokumentiert Leiter, `mode`-Parameter und `get_index` (Definition of Done: Doku im selben Arbeitsblock).
8. **AC8:** `pnpm -r build` + volle Testsuite grün.

## Nicht-Ziele

Kein Umbau der Pipeline-Stufen selbst, kein LLM-Zwang im fast-Pfad (Default bleibt kostenlos/sofort), keine Änderung an `search_vault`-Rückgabeform im fast-Modus.
