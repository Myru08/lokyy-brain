# lokyy-vault — SPEC

**Version:** 1.1 · **Status:** aktiv

Dieses Dokument ist das Grundgesetz des Vaults. Jede Änderung am Schema ist ein
ADR in `50_decisions/`.

> Die Ordner- und Typ-Tabellen unten werden beim Anlegen des Vaults aus dem Code
> generiert (`@lokyy/core`: `notes/folderMap.ts` + `conventions/index.ts`) — sie
> sind eine Kopie des Stands zum Scaffold-Zeitpunkt, nicht die Quelle. Die
> jederzeit aktuelle Fassung liefert das MCP-Tool `get_vault_conventions`.

## 1. Prinzipien

- **Markdown ist die Wahrheit.** Alles außer Binärdaten lebt als `.md`.
- **Git ist die Datenbank.** Versionierung, History, Audit-Trail.
- **Default Deny.** Schema durchsetzen, Inkonsistenz verhindern.
- **Module schreiben in ihre Ordner.** Keine Cross-Module-Writes ohne MCP-Scope.

## 2. Ordner-Schema

<!-- lokyy:folders -->

Numerische 10er-Präfixe: stabile Sortierung + Platz für Einschübe.

## 3. Frontmatter

### 3.1 Pflichtfelder (alle Types)

```yaml
id: 01HPXY9Z0000000000000000AB          # ULID, 26 Zeichen, stabil bei Rename
type: task                              # siehe 3.2
title: "..."                            # human-readable, nicht leer
created: 2026-04-09T14:32:00.000Z       # immutable
updated: 2026-04-09T15:01:00.000Z       # von der Anwendung beim Speichern gesetzt
```

Optional in jedem Typ: `tags: []` und `privacy: default | local-only`
(`local-only` erzwingt ein lokales LLM).

### 3.2 Doc-Types (geschlossene Liste)

<!-- lokyy:types -->

### 3.3 Type-spezifische Felder

Maschinenlesbar in `00_meta/schemas/<type>.json` (plus `base.json` für den
gemeinsamen Vertrag). Diese Schemas sind exakt die, gegen die die Anwendung
validiert (`validateFrontmatter` in `@lokyy/core`) — sie werden beim Scaffold
aus dem Code kopiert.

Stand heute verlangt **kein** Typ zusätzliche Pflichtfelder über 3.1 hinaus; die
typ-spezifischen Felder (`status`, `due`, `source`, `date`, …) sind optional,
aber wertgebunden (Enums). Ein unbekannter Wert ist ein Schema-Fehler.

## 4. Validierung — zwei Ebenen

1. **Anwendung (primär):** `@lokyy/core` validiert jedes Frontmatter gegen das
   JSON-Schema, bevor überhaupt geschrieben wird. Ein Verstoß ist ein
   `FrontmatterValidationError`, kein Git-Fehler.
2. **Pre-commit-Hook (letzte Instanz):** `.githooks/pre-commit` prüft jede
   gestagte `.md` auf Frontmatter-Fence, die fünf Pflichtfelder, ULID-Form und
   einen Typ, für den `00_meta/schemas/<type>.json` existiert. Der Hook ist
   dependency-frei (POSIX sh) und kennt keine hartkodierte Typ-Liste.

Aktiviert wird der Hook über `git config core.hooksPath .githooks` — Git führt
Hooks nur von dort (oder aus `.git/hooks`) aus. Der Setup-Wizard von
lokyy-brain setzt das beim Anlegen des Vaults automatisch; in einem
mitgebrachten Repo einmal von Hand setzen.

Ausgenommen vom Hook: `00_meta/`, `docs/`, `README*` und alles, was keine `.md`
ist.

## 5. Module-Konvention

Neues Modul = neuer Top-Level-Ordner mit der nächsten freien 10er-Nummer, dazu
Schema-Datei, Template und MCP-Scope-Eintrag. ADR in `50_decisions/`.

## 6. MCP-Scoping

`00_meta/mcp-scopes.yaml` definiert Read/Write pro Agent. Default Deny.
Commit-Prefix in jeder Git-Message für den Audit-Trail.

## 7. Binärdateien

Nur wenn klein (< 100 KB) und zum Markdown gehörig. Große Medien in Object
Storage, per URL referenziert.

## 8. ID-Generierung

ULID (26 Zeichen, Crockford-Base32 ohne I/L/O/U, lexikografisch sortierbar).
Wird beim Anlegen erzeugt und bleibt bei Umbenennung/Verschieben stabil — die
ULID, nicht der Pfad, ist die Identität einer Notiz.

## 9. Naming

- Ordner/Dateien: kebab-case.
- Datierte Ordner (`30_captures/`, `40_tasks/`): `YYYY-MM-DD-slug.md`.
- Decisions: `YYYY-MM-DD-slug.md`.
- Daily Notes: `YYYY-MM-DD.md`.
- Tags: lowercase, ein Wort.

## 10. Zeitstempel

- `created:` — immutable, beim Anlegen gesetzt.
- `updated:` — von der Anwendung bei jedem Speichern gesetzt. Der Hook prüft nur
  die Anwesenheit des Feldes; er schreibt nichts in deine Dateien.

## 11. Index-Layer

Volltext- und Semantik-Index (BM25, Embeddings) werden aus dem Vault abgeleitet
und sind **nicht** die Wahrheit. Sie können jederzeit vollständig neu gebaut
werden; der Vault bleibt Source of Truth.

---

*Dieses Dokument wird versioniert. Jede Änderung ist ein Commit.
Schema-Migrationen werden in `50_decisions/` dokumentiert.*
