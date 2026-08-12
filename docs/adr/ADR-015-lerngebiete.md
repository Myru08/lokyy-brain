# ADR-015 — Lerngebiete als eigener Vault-Bereich `15_lerngebiete`

**Status:** accepted · **Datum:** 2026-08-12 · **Betrifft:** Vault-SPEC §2, §3.2, §5

> Die Vault-SPEC (§5) verlangt für jedes neue Modul eine dokumentierte
> Architekturentscheidung in `50_decisions/`. Dieses Dokument ist diese
> Entscheidung. Es liegt bewusst im Repository und **nicht** im produktiven
> Nutzer-Vault — die Übernahme dorthin geschieht per
> `create_managed_note(type: "decision", …)`, damit ULID, Zeitstempel und
> Frontmatter wie bei jeder anderen Notiz vom Server erzeugt werden.

## Kontext

Lokyy-Brain soll persönliche und berufliche **Lerngebiete** verwalten: langlebige
Lernvorhaben mit eigenem Lernstand, Lektionen, Lernnachweisen und Referenzen.
Bis heute gibt es dafür keinen Ort. Naheliegend wäre `10_projects` — der Vergleich
trägt aber nicht (siehe unten).

Die bestehende Architektur ist streng ableitungsbasiert: `DOC_TYPES`
(`frontmatter/types.ts`) ist die geschlossene Typliste, `TYPE_FOLDER`
(`notes/folderMap.ts`) die einzige `type → Ordner`-Quelle, und Conventions,
Scaffold, SPEC-Tabellen, MCP-Tool-Enums und Index leiten sich daraus ab.
Drift-Guard-Tests lassen den Build scheitern, sobald zwei Quellen auseinanderlaufen.

## Entscheidung

1. **Neuer Top-Level-Bereich `15_lerngebiete`** — zwischen `10_projects` und
   `20_notes`, gemäß der 10er-Präfix-Konvention der SPEC (§2: "Platz für
   Einschübe"). Die 15 ordnet Lerngebiete bewusst neben Projekte ein.
2. **Neuer Doc-Type `learning-area`** in der geschlossenen PARA-Typliste, mit
   eigenem JSON-Schema und dem Status-Enum
   `draft | active | paused | completed | archived`.
3. **Pfadstruktur (Variante A):** Die Hub-Notiz eines Lerngebiets ist die flache
   Datei `15_lerngebiete/<slug>.md`. Die Unterstruktur liegt darunter:

   ```
   15_lerngebiete/
   ├── rust-lernen.md          ← Hub-Notiz (type: learning-area)
   └── rust-lernen/
       ├── lektionen/
       ├── referenzen/
       ├── lernnachweise/
       └── dateien/
   ```

### Warum Lerngebiete nicht unter `10_projects` liegen

Ein Projekt ist auf ein **Lieferergebnis mit Abschluss** ausgerichtet; sein
Status-Enum (`active | paused | done | archived`) endet folgerichtig in `done`.
Ein Lerngebiet zielt auf **fortlaufenden Kompetenzaufbau ohne festen Endtermin**
und braucht Zustände, die ein Projekt nicht kennt (`draft` für „angelegt, noch
nicht begonnen", `completed` für „Erfolgskriterien erreicht", wobei das Gebiet
weiter gepflegt wird). Die beiden Lebenszyklen in ein Enum zu pressen hätte
entweder `project` aufgeweicht oder Lerngebiete falsch beschrieben.

Hinzu kommt das Retrieval: `ORIGIN_SCORES` und `HALF_LIFE_DAYS`
(`scoring/importance.ts`) sind pro Typ gestimmt. Ein Lerngebiet altert langsamer
als ein Projekt (720 statt 540 Tage Halbwertszeit) — ein pausiertes Lerngebiet
soll nach Monaten noch auffindbar sein. Als `project` getarnt wäre das nicht
abbildbar gewesen, ohne die Projekt-Gewichte zu verfälschen.

### Warum `15_lerngebiete` ein eigener Bereich ist

Der Ordner ist die Einheit, über die MCP-Scopes vergeben werden
(`00_meta/mcp-scopes.yaml`, Glob-basiert). Nur ein eigener Top-Level-Ordner
erlaubt es, einem Lern-Agenten `15_lerngebiete/**` zu geben, **ohne** ihm damit
Zugriff auf Projekte zu öffnen. Läge das Modul unter `10_projects/lernen/`, wäre
jede Scope-Trennung eine Sonderregel.

### Warum `learning-area` ein eigener Doc-Type ist

Der Typ trägt das eigene Status-Enum (Schema-Validierung), die eigene
Retrieval-Gewichtung, die eigene Vorlage und die Typfilterung in `list_notes`.
Alle vier hängen in dieser Architektur am Typ, nicht am Ordner.

### Warum Variante A (flache Hub-Datei)

`derivePathForType()` kennt genau zwei Regeln: datiert
(`{folder}/{YYYY-MM-DD}-{slug}`) und flach (`{folder}/{slug}`); das Blatt ist
**immer** der aus dem Titel erzeugte Slug. Variante A fügt sich ohne jede
Änderung an dieser Pfad-Maschinerie ein — `learning-area` verhält sich exakt wie
`project`. Zusätzlich bleibt der Basename je Lerngebiet eindeutig, sodass
`[[rust-lernen]]` auflöst.

Die gewünschte Unterstruktur ist trotzdem vollständig da: `checkPathMatchesType()`
lässt Unterordner unterhalb des kanonischen Ordners ohnehin zu, und
`create_folder` legt sie an — genau wie bei Projekten.

## Verworfene Alternativen

| Variante | Warum verworfen |
|---|---|
| **B — `15_lerngebiete/<slug>/lerngebiet.md`** | Hätte ein drittes Pfad-Konzept gebraucht („Hub-Typ mit konstantem Dateinamen") in `derivePathForType()` + `pathPatternForFolder()`. Zusätzlich teilen sich dann **alle** Hub-Notizen den Basename `lerngebiet`, was Basename-Wikilinks unbrauchbar macht. |
| **C — `15_lerngebiete/<slug>/README.md`** | Nutzt zwar die bestehende Hub-Konvention der Projekte (`10_projects/<slug>/README`) und liefert die Ordnerbeschreibung im Index gratis über `readmePurpose()` — kostet aber denselben Sonderfall wie B und macht den Basename ebenfalls mehrdeutig (`README` überall). |
| **Lerngebiete als `project` mit Tag** | Kein eigenes Status-Enum, keine eigene Retrieval-Gewichtung, keine Scope-Trennung. |
| **`next_action` / `stage` als Frontmatter-Felder** | SPEC §3.3 verlangt für typ-spezifische Felder Wertbindung (Enums); ein freitextliches `next_action` wäre eine Parallelkonvention zum Body. „Nächster Schritt" und „Aktueller Lernstand" sind deshalb **Markdown-Abschnitte** der Vorlage — wie „Meilensteine" bei `project`. `stage` wurde zurückgestellt, weil sich dafür keine belastbare, wertgebundene Taxonomie festlegen ließ, ohne Fachsemantik zu erfinden. |

## Konsequenzen

**Frontmatter.** `status` ist — wie bei `project` — **optional**, aber
wertgebunden: ein unbekannter Wert ist ein Schema-Fehler. Damit kommen keine
neuen Pflichtfelder über den SPEC-Basisvertrag hinaus dazu. Die Vorlage setzt
`status: draft` als Startwert.

**Scopes.** Keine Code-Änderung nötig. Das Scope-Modell ist Glob-basiert
(`mcp/src/scopes.ts`) und kennt keine Ordner-Allowlist im Code. Ein Vault ohne
`00_meta/mcp-scopes.yaml` fällt weiterhin auf `**/*.md` zurück; wer den Bereich
trennen will, trägt `15_lerngebiete/**` explizit ein. Der Prefix-Nachbar
`15_lerngebiete_privat` matcht dabei **nicht** (segmentweiser Glob-Match).

**Index.** Keine Sonderliste. `collectIndexFolders()` läuft über den Vault-Baum;
Bereich, Hub-Notizen und verschachtelte Lektionen erscheinen automatisch, jede
Ebene als eigener Abschnitt.

**Suche.** Der Typ ist über `list_notes` (`filter.type: "learning-area"`)
filterbar und über den Ordner-Prefix eingrenzbar. Volltext (Tier 1 BM25) und
Semantik (Tier 2 Embeddings) indexieren Lerngebiete wie jede andere Notiz — sie
kennen keine Typliste, die zu erweitern wäre. Die MCP-Tool-Enums leiten sich aus
`getProfileSpec(profile).docTypes` ab und führen den Typ ohne Zutun.

**Graph.** Wikilinks aus einem Lerngebiet auf Projekte, Captures, Referenzen und
Decisions laufen über die bestehende Backlink-Logik. Es wird **keine**
automatische Verlinkung anhand von Wortähnlichkeit erzeugt.

**Bestehende Vaults.** Additiv. Keine Datei wird bewegt, kein Typ umbenannt,
keine bestehende Notiz wird invalide — `learning-area` ist ein zusätzlicher
Eintrag in einer geschlossenen Liste. Der Ordner `15_lerngebiete` entsteht in
neuen Vaults durch das Scaffold; in bestehenden Vaults legt ihn die erste
Lerngebiets-Notiz (oder `create_folder`) an. **Eine Migration ist nicht
erforderlich.**

**karpathy-Profil.** Unberührt. Der Typ gehört ausschließlich zum PARA-Profil;
`scaffoldFolders("karpathy")` enthält `15_lerngebiete` nicht.

## Rückwärtskompatibilität und Rollback

Ältere Lokyy-Brain-Versionen kennen `learning-area` nicht. Ein Vault, in dem
bereits Lerngebiete liegen, würde von einer älteren Version beim Schreiben dieser
Notizen einen `frontmatter-validation-failed`-Fehler liefern (unbekannter Typ);
**lesen** bleibt möglich, und alle übrigen Notizen sind unberührt.

Rollback des Moduls, solange **keine** Lerngebiete angelegt wurden: die Änderung
zurücknehmen — es bleiben keine Spuren im Vault außer einem leeren Ordner
`15_lerngebiete/` (mit `.gitkeep`), der gefahrlos gelöscht werden kann.

Rollback, **nachdem** Lerngebiete existieren: die betroffenen Notizen vorher auf
einen bestehenden Typ umschreiben (z. B. `type: project` nach `10_projects/`,
per `move_note` + `update_note`), sonst validieren sie nach dem Rückbau nicht
mehr. Der Vault ist Git — der Stand vor dem Rückbau bleibt über die History
wiederherstellbar.
