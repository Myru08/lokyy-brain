# Story S2 — Schichten-Typen + Schemas (RAW / Wiki / Outputs) inkl. Status-Trias

> **Epic:** Karpathy-Konversion (PARA → RAW/Wiki/Outputs). Siehe ADR in Brain `50_decisions/adr-lokyy-brain-wird-das-kimiboca-kursprodukt-…`.
> **Status:** PROPOSED — wartet auf Approval + BMAD-Story-Nummer.
> **Prereq:** S1 (DOC_TYPES = einzige Quelle) ✅ erledigt.
> **BMAD-Phase:** SM-Story; benötigt eine Architect-Mini-Entscheidung (siehe §2) vor Dev.

## Ziel
Die drei Karpathy-Schichten als erststellige, schema-erzwungene Doc-Typen im Vault-Contract verankern:
- **RAW** — verbatim eingelesene Quelle, nie umgeschrieben.
- **Wiki** — atomarer destillierter Artikel; Status-Trias `gesichert | im Aufbau | These` (Pflicht); Quellenpflicht.
- **Outputs** — Frage-Report (Frage + Quellen + Antwort).

S2 liefert **nur Typen + JSON-Schemas + Validierung**. NICHT in S2: Ordner-Routing (S3), RAW-Immutabilität (S4), Verweis-Doktrin/Graph (S5), Pipes→RAW (S6), MCP-Tools (S7), PWA (S8), Migration/Seed (S9).

## §1 Neue Frontmatter-Contracts
Pflichtfelder bleiben `id, type, title, created, updated` (Basis-Contract unverändert). Zusätzlich pro Schicht:

| Schicht | type-Wert (Vorschlag) | Zusatz-Pflichtfelder | Optional |
|---|---|---|---|
| RAW | `raw-source` | `source` (Origin/URL), `captured` (ISO) | `source_type`, `tags` |
| Wiki | `wiki-article` | `status` ∈ {`gesichert`,`im Aufbau`,`These`}; `sources` (≥1, Liste von `[[Slug]]`/URLs) | `aliases`, `tags` |
| Outputs | `frage-report` | `question`, `sources` (≥1) | `tags` |

`status`-Enum + `sources`-min-1 werden als **harte ajv-Constraints** in den per-type-Schemas verankert (heute existiert `status` nur als freier Pass-through-String, nirgends validiert).

## §2 Architect-Mini-Entscheidung (vor Dev klären)
Zwei Sub-Fragen, die das Schema-Design forken — Empfehlung jeweils markiert:

**A. Modellierung — neue Typen vs. `layer`-Feld**
- **(A1, empfohlen)** Drei neue Doc-Typen `raw-source`/`wiki-article`/`frage-report` in `DOC_TYPES`. Sauberste 1:1-Deckung mit dem Gelehrten (Entscheidung 1 = „reine RAW/Wiki/Outputs-SPEC"), nutzt die bestehende type→Schema→Ordner-Maschinerie direkt.
- (A2) Ein orthogonales Pflichtfeld `layer: raw|wiki|outputs` über schlankem Typ-Set. Flexibler, aber weicht vom „reine SPEC"-Beschluss ab und verkompliziert Routing/Validierung.

**B. Geltungsbereich — eine SPEC vs. per-Vault-Profil**
Brain bedient zwei Vaults (`personal-msgwxnqa`, `mein-vault`). Eine harte Umstellung auf RAW/Wiki/Outputs macht Olivers persönliche PARA-Notizen (project/decision/customer/…) **invalide**.
- **(B1, empfohlen)** Vault-SPEC-Profil pro Vault: der **Produkt-/Seed-Vault** läuft auf dem RAW/Wiki/Outputs-Profil; Olivers persönlicher Vault bleibt vorerst auf dem PARA-Profil (oder migriert separat in S9). Verhindert, dass die Konversion Olivers Lebens-OS zerlegt.
- (B2) Eine globale SPEC, alle Vaults migrieren zwingend mit (großer Migrationsdruck, hohes Risiko).
→ B1 impliziert: die Typ-/Schema-/Ordner-Definition wird **vault-profil-abhängig** ladbar statt global hartkodiert. Das ist die eigentliche Architektur-Arbeit von S2.

## §3 Akzeptanzkriterien
1. Die drei Schicht-Typen (A1) sind in `DOC_TYPES` (`packages/core/src/frontmatter/types.ts`) ergänzt; der S1-Drift-Guard bleibt grün.
2. Je ein per-type JSON-Schema (`packages/core/src/frontmatter/schemas/`) mit den Pflichtfeldern aus §1; `status`-Enum + `sources`-min-1 als ajv-Constraint.
3. `validateFrontmatter` akzeptiert valide Schicht-Notes und **lehnt** ab: Wiki ohne `status`, Wiki/Output ohne `sources`, ungültigen `status`-Wert.
4. Vault-Profil-Lader (B1): das aktive SPEC-Profil ist pro Vault wählbar; das Default-/Legacy-Profil (PARA, 15 Typen) bleibt unverändert gültig, sodass **keine bestehende Notiz invalide wird**.
5. `get_vault_conventions` (MCP) gibt für ein RAW/Wiki/Outputs-Profil die korrekten Ordner/Typen/Frontmatter-Regeln zurück.
6. Tests: Validierungs-Tests für alle drei Typen (positiv + die Negativfälle aus AK 3); `pnpm -r build` grün; `@lokyy/core`-Suite grün.
7. KEINE Ordner-Umbenennung, KEIN Pipe-/Graph-/MCP-Tool-Umbau, KEINE Migration ausgeführt (Folge-Stories).

## §4 Externer `lokyy-vault`-Repo-Synchronschritt (GEGENSTANDSLOS — Option-Y-Korrektur)
> **GEGENSTANDSLOS (Korrektur).** Dieser Schritt setzt einen `00_meta/schemas/`-Ordner + Pre-commit-Hook im Vault-Repo voraus. Der maßgebliche Kurs-Vault (`lokyy-kb-starter`) hat **weder** `00_meta/schemas` **noch** einen Pre-commit-Hook. Die harte Schreibgrenze ist der **MCP im Schreibpfad** (gehört zu S7), nicht ein Git-Hook im Vault. Es gibt also keinen Hook-Enum/Validator zu spiegeln; App-Schema und Kurs-Vertrag werden über die per-type-Schemas + `get_vault_conventions` konsistent gehalten, nicht über einen Vault-Hook.
>
> Ursprünglicher (nicht mehr zutreffender) Text:
> Der Pre-commit-Hook + die `00_meta/schemas/` liegen im separaten `lokyy-vault`-Git-Repo, nicht in diesem App-Repo. Wenn das App-Profil die neuen Schemas erzwingt, der Hook aber die alten, lehnt der Hook valide App-Writes ab (oder umgekehrt). → Teil-Aufgabe von S2: die neuen Schicht-Schemas im Gleichschritt ins `lokyy-vault`-Repo des Produkt-/Seed-Vaults spiegeln und den Hook-Enum/Validator aktualisieren.

## §5 Risiken
- **Auseinanderlaufen App-Schema ↔ Vault-Hook** (wahrscheinlichste Fehlerquelle) → AK + §4 erzwingen Gleichschritt.
- **`sources`-Pflicht (min 1)** kann legitime Zwischenstände blockieren (Artikel im Entstehen ohne Quelle) — ggf. nur für `status: gesichert` erzwingen, für `These`/`im Aufbau` lockern. **Im Dev zu entscheiden.**
- **Vault-Profil-Lader** ist neue Architektur; muss `MemoryProvider`/Index/`get_health` nicht brechen.

## §6 Definition of Done
`pnpm -r build` grün · Validierungstests grün · `get_vault_conventions` korrekt fürs neue Profil · Legacy-PARA-Vault unverändert valide · `lokyy-vault`-Schemas+Hook des Ziel-Vaults synchron · QA-Sign-off Oliver.
