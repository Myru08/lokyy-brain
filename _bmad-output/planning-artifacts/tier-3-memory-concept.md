# Tier 3 Memory — Konzept: temporaler Knowledge Graph (cognee-Kandidat)

> **Status: Konzept, keine Entscheidung.** Dies ist eine Zwischenablage für den lokyy-vault. Die kanonische ADR gehört gemäß SSOT-Disziplin (CLAUDE.md) nach `50_decisions/` im externen lokyy-vault — dorthin verschieben/spiegeln, sobald der Vault-MCP-Server wieder erreichbar ist. Bis dahin ist dieses Dokument die verbindliche Quelle für diese Idee.
>
> Kein Code, keine Dependency in diesem Deploy. Reine Konzeptdokumentation.

## Ausgangspunkt

`CLAUDE.md`s Memory Model definiert bereits drei Tiers hinter einem gemeinsamen `MemoryProvider`-Interface (`packages/core/src/memory/MemoryProvider.ts`):

- **Tier 1** (fertig, `sprint-status.yaml`: `7-4-mcp-tool-search-vault-tier-1-tier-2: done`) — strukturell: Wikilinks, Tags, Volltext.
- **Tier 2** (fertig, `5-3-tier-2-implementation-ollama-pgvector-embeddings: done`) — semantisch: `nomic-embed-text` + pgvector HNSW.
- **Tier 3** (offen, Open Question 5 in `CLAUDE.md`: "deliberately deferred until Tier 1+2 are in production") — temporaler Knowledge Graph. Graphiti war bislang der einzig genannte Kandidat.

Tier 1+2 sind laut Sprint-Status in Produktion — die in `CLAUDE.md` genannte Voraussetzung für Tier 3 ist damit erfüllt.

## Warum Tier 3 mehr ist als der native Wikilink-Graph

Video-Referenz: ["Warum dein Obsidian Graph nutzlos ist – und was du stattdessen brauchst"](https://www.youtube.com/watch?v=O-KNlOXwemI) (Maximaler Überblick). Kernaussage: ein flacher, ungerichteter Link-Graph (= lokyy-brains heutiger Tier 1, aus `graphService`) zeigt *dass* zwei Notizen verbunden sind, aber nicht *wie* oder *warum*, und degradiert bei wachsender Notizzahl zu visuellem Rauschen. Das deckt sich mit der Tier-1-Beschränkung, die `CLAUDE.md` selbst benennt ("largely exists in graphService" — reine Struktur, keine Semantik, keine Zeitachse).

Ein temporaler Knowledge Graph ergänzt das um: benannte Beziehungstypen zwischen Entitäten (nicht nur "Note A linkt Note B"), Zeitachse (wann galt eine Aussage, wann wurde sie widerrufen/aktualisiert), und Entity-Resolution über Notizen hinweg.

## Kandidat: cognee

[topoteretes/cognee](https://github.com/topoteretes/cognee) — Open-Source-Memory-Engine für AI-Agenten. Self-hosted, kombiniert Vektorsuche + Graph-DB, baut kontinuierlich einen Knowledge Graph aus eingespeisten Daten auf, gibt Agenten persistentes Langzeitgedächtnis über Sessions hinweg. Passt in den bestehenden `MemoryProvider`-Seam ohne Interface-Umbau:

```ts
// packages/core/src/memory/MemoryProvider.ts — heute:
tier: "t1" | "t2"
// für Tier 3: tier: "t1" | "t2" | "t3", ein CogneeProvider implementiert
// dieselben vier Methoden (search, relatedNotes, indexNote, removeNote).
```

Alternative/Vergleichskandidat weiterhin: Graphiti (bereits in `CLAUDE.md` genannt). Beide sind selbst-hostbare, Python-basierte Knowledge-Graph-Engines für Agenten-Memory — eine echte Bewertung (Betriebsaufwand, Graph-DB-Unterbau, Reifegrad) ist erst Teil der Tier-3-Story (Epic 6), nicht dieses Konzepts.

## Randnotiz: OKF (GCP `knowledge-catalog/okf`)

[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) ist ein vendor-neutrales Format für Wissen als Markdown + YAML-Frontmatter, git-versioniert, graph-browsbar über eine HTML-Visualisierung. Strukturell deckt sich das mit dem, was der lokyy-vault bereits ist (SPEC-valide Frontmatter, git als Wahrheit, Wikilink-Graph). Kein Handlungsbedarf jetzt — als externe Validierung des bestehenden Formats vermerkt, und als möglicher Interop-/Export-Zielpunkt für eine spätere Story, falls lokyy-brain-Vaults außerhalb des eigenen Ökosystems lesbar sein sollen.

## Einordnung ins bestehende Programm

- Epic Sequence (`CLAUDE.md`): "6. Tier 3 Graph — optional, deferrable" — genau der Slot für diese Idee.
- Architektur-Constraint aus `CLAUDE.md` gilt unverändert: Tier 3 "must never block server start or writes — Forgejo commit goes first, Tier 3 sync is fire-and-forget."
- `MemoryProvider`-Interface braucht laut `architecture.md` (Zeile 1003) für Tier 3 keinen Rebuild — nur eine weitere Implementierung hinter demselben Seam.

## Explizit nicht Teil dieses Deploys

Keine neue Dependency, kein Docker-Service, kein Code. Dies ist die dokumentierte Begründung, warum die Tier-3-Slot-Entscheidung ansteht und welche zwei Kandidaten (Graphiti, cognee) zur Wahl stehen — für die Bootcamp-Abgabe als Nachweis, dass das Gesamtkonzept (inkl. der noch offenen Memory-Stufe) durchdacht ist.

## Nächste Schritte (spätere Story, nicht jetzt)

1. Diese Notiz nach `50_decisions/` im lokyy-vault spiegeln, sobald Vault-Zugriff besteht.
2. Epic 6 als BMAD-Story ausformulieren: Betriebskosten-Vergleich Graphiti vs. cognee, Graph-DB-Wahl, Fire-and-forget-Sync-Design.
3. `CLAUDE.md` Open Question 5 aktualisieren, sobald eine Wahl getroffen ist.
