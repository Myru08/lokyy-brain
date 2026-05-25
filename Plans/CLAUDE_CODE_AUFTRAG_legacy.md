# lokyy-brain — Projekt-Briefing für die BMAD-Planung

> **Was dieses Dokument ist:** Das **Briefing**, mit dem die BMAD-Planungskette
> gestartet wird — nicht ein direkter Umsetzungsauftrag. Es liefert Analyst,
> PM und Architect alles, was sie brauchen, um **PRD**, **Architecture-Doc**
> und daraus die **Stories** zu erzeugen. Code entsteht erst aus den Stories.

## Arbeitsweise — verbindlich, gilt für den gesamten Verlauf

- **Es wird ausschließlich mit BMAD gearbeitet.** Kein Ad-hoc-Coding, keine
  Abkürzungen am Workflow vorbei. BMAD ist im Repo bereits installiert.
- **Claude ist ausschließlich Orchestrator.** Claude plant, koordiniert,
  delegiert und prüft Ergebnisse — schreibt **selbst keinen Produktivcode**.
  Jede inhaltliche Arbeit geht an die zuständigen BMAD-Agenten.
- **Alles wird an Agent-Teams und Agent-Tasks delegiert.** Analyst, PM,
  Architect, Scrum Master, Dev, QA arbeiten in ihren Rollen. Claude ruft sie
  auf, gibt ihnen den Kontext, nimmt ihre Artefakte ab.
- **Kein Agent arbeitet ohne definierte Aufgabe.** Jede Agenten-Aktivität
  hängt an einer konkreten Story oder Task mit klarem Scope und
  Akzeptanzkriterien. Ein Agent ohne Story-Kontext wird nicht gestartet.
- **Die BMAD-Reihenfolge wird respektiert:** erst Planung (Analyst → PM:
  PRD → Architect: Architecture-Doc), dann Story-Schnitt (Scrum Master),
  dann Umsetzung Story für Story (Dev → QA). Keine Phase wird übersprungen.
- **`/goal` pro Dev-Story nutzen.** Claude Code hat seit v2.1.139 den
  `/goal`-Befehl: eine Abschlussbedingung, an der ein separater Evaluator
  nach jedem Turn prüft, ob fertig — der Abschluss wird also von einem
  frischen Modell entschieden, nicht vom arbeitenden. Bei der Umsetzung
  jeder Dev-Story setzt der Orchestrator ein `/goal`, dessen Bedingung die
  **Akzeptanzkriterien der Story plus `pnpm -r build` grün** ist, immer mit
  einer Bremse („oder stoppe nach N Turns") in der Bedingung selbst, weil es
  kein Budget-Cap gibt. Das macht die „Definition of Done" maschinell
  durchsetzbar. `/goal` ersetzt **nicht** BMAD — es ist nur das Mittel, mit
  dem eine einzelne Story zuverlässig bis zum verifizierten Endzustand
  getrieben wird.
- **Erste Orchestrator-Aufgabe:** dieses Briefing, das `README.md`, den
  bestehenden Code und den Referenz-Vault sichten, dann den Analyst/PM mit
  dem PRD beauftragen. Offene Fragen (s.u.) **vor** dem PRD klären, nicht
  raten lassen.

## Produktkontext

**Lokyy** ist ein self-hosted Second-Brain-System. Dieses Repo, **lokyy-brain**,
ist die menschliche Oberfläche **und** der Maschinen-Zugang dazu. Es besteht
am Ende aus einer Plattform (PWA) für den Menschen, einer HTTP-API und einem
MCP-Server für KIs — alle auf demselben Kern.

- **lokyy-brain** — dieses Repo: PWA-Plattform, HTTP-Server, MCP-Server,
  Vault-Integration. (Arbeitstitel war „Sternwarte" — wird durchgängig zu
  „lokyy-brain", kommt im Endzustand nirgends mehr vor.)
- **lokyy-vault** — der standardisierte Markdown-Vault als Daten-Fundament.
  Wird als frisches Repo aufgesetzt (Details unten).
- **Memory-Layer** — geschichtet, siehe eigenen Abschnitt „Memory-Modell".
  Stufe 1+2 sind Teil von lokyy-brain selbst; Stufe 3 (ein temporaler
  Knowledge-Graph) ist ein **optionales Plugin**, das danebensteht.
- **Forgejo ist die Wahrheit.** Der Server hält die einzige echte
  Git-Working-Copy; vor dem Lesen wird gepullt, beim Speichern committet
  und gepusht.

lokyy-brain, aufgesetzt auf den lokyy-vault, bildet das Second Brain „Lokyy"
ab — bedienbar vom Menschen über die PWA-Plattform, von jeder KI über MCP.
Der optionale Stufe-3-Graph macht es besser, ist aber für den Betrieb nicht
erforderlich.

## Tech-Stack (verbindlich — als Architektur-Vorgabe ins Architecture-Doc)

Der Stack ist bewusst gewählt und soll vom Architect übernommen, nicht neu
evaluiert werden:

- **Monorepo:** pnpm-Workspaces. Läuft auf Hetzner.
- **Plattform / Frontend:** eine **PWA mit Vite + React** — bewusst **nicht**
  Next.js (einfacher ist besser; die SPA ist gleichzeitig die installierbare
  PWA via `vite-plugin-pwa`). Das ist die „Plattform", die für den Menschen
  gebaut wird.
- **Editor:** **CodeMirror 6** — dieselbe Engine wie Obsidian. Die
  Obsidian-artige „Live Preview" ist nicht eingebaut und wird als eigene
  CM6-Extension gebaut (Decorations/Widgets). Bewusst kein WYSIWYG-Editor
  (TipTap/Milkdown/Lexical), weil das Datenmodell plain Markdown bleibt.
- **Graph:** im Frontend mit **react-force-graph**. Kanten kommen aus dem
  Wikilink-Parser; optional ergänzt um semantische/temporale Kanten aus dem
  Stufe-3-Graph, falls dieser angebunden ist.
- **Backend:** Node + **Hono**, ruft das echte `git`-CLI. Markdown-Dateien
  auf Disk als lokale Source of Truth, Forgejo als Remote-Wahrheit.
- **MCP-Server:** eigener Workspace, **importiert die Core-Services direkt**
  (kein HTTP zwischen Prozessen auf derselben Maschine). MCP-SDK:
  `@modelcontextprotocol/sdk`. Transport stdio als Default, HTTP/SSE optional.
- **Pipes / Import:** Job-Queue mit getypten Handlern. YouTube + Web-Scrape
  über **Supadata**. Voice später über self-hosted **Whisper**.
- **Memory-Layer:** geschichtetes Modell hinter einem `MemoryProvider`-
  Interface — siehe eigener Abschnitt „Memory-Modell". Stufe 2 (semantischer
  Index) als erste Implementierung; Stufe 3 (temporaler Knowledge-Graph,
  Kandidat: **Graphiti**) optional zuschaltbar.
- **Konsolidierungs-Agent:** geplanter Lauf (Cron/Scheduler), der den Vault
  anreichert — siehe „Memory-Modell".

## Memory-Modell — verbindlich, das Herzstück des Systems

Der eigentliche Zweck von Lokyy ist nicht „Notizen speichern", sondern dem
Menschen erlauben, **komplexe, spezifische Fragen** an sein gesammeltes
Wissen zu stellen — und ein System, das wie ein Gehirn arbeitet: das auch
dann verarbeitet, wenn der Mensch nicht arbeitet (neue Bezüge knüpft,
Verbindungen findet), sodass später fundierte Antworten möglich sind.

Das wird **nicht** durch ein einzelnes Tool gelöst, sondern durch ein
**geschichtetes Modell aus drei klar getrennten Teilen**. Wichtigste
Architektur-Vorgabe: alle drei sitzen hinter einem **`MemoryProvider`-
Interface** in `packages/core`, sodass jede Schicht austauschbar und Stufe 3
**optional** ist.

### Stufe 1 — Struktureller Index (Pflicht, kein Modell nötig)

Aus den Markdown-Dateien direkt abgeleitet: Wikilinks, Tags, Ordnerstruktur,
Volltext. Liefert den Wikilink-Graphen (Obsidian-Niveau), Filter, „was
verlinkt auf X", Volltextsuche. Existiert im bestehenden `graphService`
größtenteils schon. Braucht kein LLM, kein Embedding, läuft auf jedem
kleinen Server.

### Stufe 2 — Semantischer Index (Pflicht, kleines Embedding-Modell)

Jede Notiz wird über ein **kleines, self-hosted Embedding-Modell** in einen
Vektor gewandelt; Ablage in pgvector oder LanceDB. Ermöglicht semantische
Suche — „finde Notizen über X", auch ohne wörtliche Treffer und ohne
gesetzten `[[Link]]`. **Bewusst nur ein Embedding-Modell, kein großes LLM.**
Das ist die erste konkrete Implementierung des `MemoryProvider`-Interface
und der Sweet Spot aus Aufwand und Nutzen.

### Konsolidierungs-Agent (Pflicht — das „Gehirn im Schlaf")

Ein **geplanter Lauf** (Cron/Scheduler), der läuft, wenn der Mensch nicht
arbeitet. Er nimmt sich Notizen vor, die seit dem letzten Lauf neu oder
geändert sind, liest sie, und **schreibt zurück in den Vault**:

- ergänzt fehlende Wikilinks zwischen offensichtlich verwandten Notizen,
- legt neue `topic`-Notizen für wiederkehrende Konzepte an,
- schreibt erkannte Bezüge, Widersprüche und Vorschläge nach
  `70_pai/interventions/`.

Verbindlich: Der Agent schreibt **durch den Git-Service**, hält das
SPEC/Schema ein (gültiges Frontmatter!), und jede maschinell erzeugte
Verknüpfung ist sichtbares, vom Menschen korrigierbares Markdown. Der Vault
bleibt die **einzige Wahrheit** — er wird durch die Konsolidierung nur
reicher, es entsteht keine parallele Datenhaltung. Das ist der Mechanismus,
der das „Second Brain arbeitet, wenn ich nicht arbeite" tatsächlich einlöst
— kein Index-System tut das von selbst.

Technisch: ein Agent-Lauf über den MCP-Server (nutzt also dieselben Tools
wie jede andere KI), angestoßen von einem Scheduler. Scope über
`mcp-scopes.yaml`. Die Loop-Architektur soll dem `/goal`-Muster nachempfunden
sein: nach jedem Durchlauf prüft ein Evaluator-Schritt, ob noch
unkonsolidierte Notizen offen sind, statt blind eine feste Anzahl Runden zu
drehen — mit einer harten Obergrenze als Bremse.

### Stufe 3 — Temporaler Knowledge-Graph (OPTIONAL, Plugin)

Ein dedizierter Graph-Dienst, der Entitäten und Beziehungen extrahiert und
— im Fall des bevorzugten Kandidaten **Graphiti** — eine **temporale**
Dimension mitführt: Fakten haben Gültigkeitsfenster, widersprüchliche Fakten
invalidieren alte statt sie zu löschen, volle Provenienz zur Quellnotiz.
Beantwortet beziehungstiefe und zeitbezogene Fragen, die Stufe 1+2 nicht
können („wie hingen X und Y im März zusammen", mehrstufiges Traversieren).

**Verbindliche Eigenschaften dieser Stufe:**

- **Strikt optional.** Ist Stufe 3 angebunden, läuft sie mit und macht das
  System besser. Ist sie nicht da, läuft lokyy-brain vollständig ohne sie —
  Stufe 1+2 + Konsolidierungs-Agent sind ein komplettes, nutzbares System.
  Kein Pflicht-Dependency, kein Blocker beim Start.
- **Hinter demselben `MemoryProvider`-Interface.** Das Anbinden von Stufe 3
  ist eine Konfigurationssache, kein Umbau. Die `search`/`related`-Aufrufe
  des MCP-Servers und der PWA bleiben gleich — sie bekommen nur bessere
  Ergebnisse, wenn Stufe 3 aktiv ist.
- **Braucht ein großes LLM (32B+).** Die Entity-/Relation-Extraktion ist
  anspruchsvoll; ein kleines Modell reicht dafür nicht. Das ist der Grund,
  warum Stufe 3 optional und nicht Fundament ist — sie zieht echte
  Hardware-Anforderungen nach sich.
- **Kandidat Graphiti** (getzep). Im Architecture-Doc als bevorzugte
  Stufe-3-Implementierung nennen, aber das Interface so schneiden, dass auch
  LightRAG oder Cognee dieselbe Schnittstelle bedienen könnten. Die finale
  Tool-Wahl ist bewusst **vertagt** — sie soll auf Basis echter Nutzung von
  Stufe 1+2 reifen, nicht jetzt unter Planungsdruck fallen.

### Konsequenzen für die Planung

- `70_pai/memory/` ist der vorgesehene Ort für den State von Stufe 2/3
  (Sync-Marker, Index-Metadaten) und den „letzter Lauf"-Marker des
  Konsolidierungs-Agenten.
- Der MCP-Server exponiert `search_vault` und `related_notes` **ab Tag eins**
  — sie werden zunächst von Stufe 1+2 bedient, später (falls angebunden) von
  Stufe 3, ohne dass sich die Tool-Signatur ändert.
- Das **Mehr-Agenten-Szenario** (z.B. ein Agent für Rechtsanwalts-, einer
  für Arztpraxis-Kontext, mit jeweils unterschiedlichem Informationszugriff)
  wird **nicht** über den Memory-Layer gelöst, sondern über das
  **MCP-Scoping** aus `00_meta/mcp-scopes.yaml` — jeder Agent bekommt seinen
  Scope auf die relevanten Ordner. Das ist orthogonal zum Memory-Modell.
- Stufe-3-Anbindung darf das Speichern oder den Serverstart **nie**
  blockieren. Schreibt eine Operation in den Vault, geht der Forgejo-Commit
  zuerst; die Stufe-3-Synchronisation läuft danach als Fire-and-forget mit
  Fehler-Logging.

## Visueller Entwurf — bereits vorhanden

Unter [`docs/mockup/`](./docs/mockup/) liegt ein **interaktiver Design-Entwurf**
der PWA (`lokyy-brain-mockup.jsx` + eigenes README). Er zeigt das geplante
Drei-Panel-Layout (Datei-Baum / Live-Preview-Editor / Wissensgraph), die
Pipes-Inbox, die Forgejo-Statusleiste und den visuellen Stil (warmes Dunkel,
Terrakotta-Akzent).

**Für die Planung:** Layout, UX-Verhalten und Stil aus dem Entwurf sind als
**Vorgabe** zu behandeln — PM und Architect leiten daraus UX-Anforderungen
und Komponenten-Schnitt ab, statt das Layout neu zu erfinden. Das Mockup
nutzt `d3-force`; die echte PWA verwendet `react-force-graph`. Abweichungen
sind erlaubt, müssen aber begründet in einer Story stehen.

## Bestehender Code (Ausgangslage — nicht neu bauen)

pnpm-Monorepo, drei Workspaces, typgeprüft, PWA baut sauber:

- `packages/shared` — Typen: `Note`, `NoteSummary`, `TreeNode`,
  `GraphNode/Edge/Data`, `SharePayload`, `ImportRequest`, `PipeType`,
  `PipeStatus`, `PipeJob`, `PipeResult`.
- `server` — Hono-API. Services unter `server/src/`:
  - `git/gitService.ts` — `ensureRepo`, `pull`, `save`, `remove`, `move`,
    `lastModified`. Serialisiert git-Operationen über einen Lock.
  - `notes/notesService.ts` — `listNotes`, `getNote`, `saveNote`, `getTree`,
    `createNote`, `createFolder`, `moveEntry`, `deleteEntry`.
  - `graph/graphService.ts` — `parseLinks`, `parseTags`, `parseTitle`,
    `buildGraph`.
  - `pipes/pipeQueue.ts` — `registerHandler`, `detectType`, `enqueue`,
    `listJobs`. Handler unter `pipes/handlers/` (`youtube.ts`, `scrape.ts`).
  - `routes/` — `notes.ts`, `vault.ts`, `graph.ts`, `pipes.ts`.
  - `index.ts` — Hono-Bootstrap.
- `pwa` — Vite-SPA + PWA. CM6-Editor (`src/editor/`), `FileTree.tsx`,
  `ImportPanel.tsx`, `App.tsx`, `api.ts`, `theme.ts`.

Dieser Code ist die Basis. Die Planung soll ihn **umziehen und erweitern**,
nicht wegwerfen.

## Der Standard-Vault: lokyy-vault

lokyy-brain arbeitet auf einem **standardisierten Vault** mit Schema,
Templates und einem Pre-commit-Hook — nicht auf einem beliebigen
Markdown-Ordner.

**Referenz-Vault** (Struktur & Konventionen übernehmen, **nicht** als Remote
verwenden): `https://github.com/oliverhees/paione-vault`

> **Namens-Hinweis:** Im Referenz-Vault steht überall noch „paione" — das ist
> **überholt**. lokyy-vault wird als **frisches Repo** aufgesetzt, dabei
> `paione` → `lokyy` durchgängig umbenannt (README, SPEC, BRAND.md,
> `brand`-Enum im project-Schema, URLs, Kommentare). lokyy-brain-Code darf
> sich **nie** auf einen Vault-Markennamen verlassen — er liest die
> *Konventionen* aus `00_meta/SPEC.md` und `00_meta/schemas/`, nicht den Namen.

### Vault-Struktur (10 Top-Level-Ordner, 10er-Präfixe)

```
00_meta/        SPEC.md, mcp-scopes.yaml, schemas/ (7), templates/ (5)
10_projects/    <slug>/README.md (project) + tasks/ meetings/ decisions/
20_notes/       daily/ topics/ fleeting/        — type: note
30_captures/    urls/ youtube/ voice/ pdfs/     — type: capture (Pipe-Ziel)
40_customers/   B2B-Kunden-Metadaten           — type: customer
50_decisions/   globale ADRs                   — type: decision
60_meetings/    Meetings ohne Projekt          — type: meeting
70_pai/         context/ workflows/ memory/ interventions/  — Agent-State
80_brand/       youtube/ newsletter/ social/   — type: content
99_archive/     read-only, Erledigtes
```

### `00_meta/SPEC.md` — das Grundgesetz, lokyy-brain MUSS es einhalten

Pflichtlektüre für Analyst und Architect. Bindend:

- **Markdown ist die Wahrheit, Git die Datenbank.** Deckt sich mit dem
  Forgejo-Prinzip.
- **Jede Datei hat Frontmatter mit Pflichtfeldern:** `id` (ULID, 26 Zeichen,
  beim Anlegen erzeugt, stabil bei Rename), `type`, `title`, `created`
  (immutable), `updated` (Hook setzt auto).
- **Doc-Types sind eine geschlossene Liste**, je Type ein Ordner und
  type-spezifische Pflichtfelder (Quelle: `00_meta/schemas/*.schema.json`):
  - `note` → `20_notes/**`, Pflicht: `note_type` ∈ {daily,topic,fleeting,permanent}
  - `capture` → `30_captures/**`, Pflicht: `source` ∈ {url,youtube,voice,pdf,manual},
    `captured_at`, `processed`
  - `project` → `10_projects/*/README.md`, Pflicht: `slug`, `status`, `brand`
  - `task` → `10_projects/*/tasks/**`, Pflicht: `status`, `project`,
    `assignee`, `priority`
  - `decision`, `meeting`, `customer`, `workflow`, `intervention`, `content`
    analog — Schemas lesen.
- **Naming:** kebab-case; Daily Notes `YYYY-MM-DD.md`; Decisions
  `YYYY-MM-DD-slug.md`; Tags lowercase single-word.
- **Index Layer:** Der Memory-Layer (Stufe 2, optional Stufe 3) indexiert
  den Vault, ist aber **nicht** die Wahrheit. `70_pai/memory/` ist der
  vorgesehene Ort für Index-/Sync-State und den „letzter Lauf"-Marker des
  Konsolidierungs-Agenten.

### Der Pre-commit-Hook — kritische Integrationsaufgabe für die Planung

`.githooks/pre-commit` validiert bei **jedem Commit** das Frontmatter aller
gestageten `.md`-Dateien. Schlägt es fehl, **bricht der Commit ab** — und
damit der `gitService.save()`-Pfad. Daraus ergeben sich Anforderungen, die
in PRD/Architecture müssen:

- `notesService` darf **nie** rohen Body ohne gültiges Frontmatter committen.
- `createNote` erzeugt vollständiges, schema-gültiges Frontmatter; `saveNote`
  erhält vorhandenes Frontmatter und aktualisiert `updated`.
- Pipe-Handler erzeugen `capture`-Frontmatter korrekt.
- Es braucht im Kern ein **Frontmatter-Utility** (parsen/serialisieren/gegen
  die JSON-Schemas validieren) und einen **ULID-Generator**.
- Ein Hook-Fehlschlag soll als eigener Fehlertyp gemeldet werden, nicht als
  generischer git-Fehler — damit PWA und MCP ihn sinnvoll anzeigen können.

### `30_captures/` ersetzt das generische `inbox/`

Die Pipe-Handler schreiben aktuell nach `inbox/`. Im lokyy-vault gehören
Importe nach `30_captures/{urls,youtube,voice,pdfs}/` je Quelle, mit
`type: capture`-Frontmatter.

### `_inbox/`-Setup-Pattern (Onboarding) — einplanen, nicht jetzt bauen

Aus der Praxis (siehe Newsletter-Screenshots im Projektmaterial): Beim
Erstaufbau eines Vaults kippt man Rohmaterial (Persona-Skizze,
Brain-Dump-Checkliste, vorhandene Briefings) in einen Staging-Ordner
`_inbox/`, und **ein Setup-Prompt** liest alles und baut daraus die
Vault-Struktur — keine Wizard-Phasen, eine geführte Übergabe. `_inbox/` ist
damit konzeptionell ein **zweiter Modus** des Capture-Gedankens
(Setup-Staging statt laufender Import). In PRD/Architecture **als künftigen
Onboarding-Flow berücksichtigen**, sodass nichts ihn verbaut — aber in diesem
Scope noch nicht umsetzen.

## Architektur-Leitplanken (in das Architecture-Doc übernehmen)

- **`packages/core` wird die Heimat der Services.** `git`, `notes`, `graph`,
  `pipes`, `memory`, `config`, Frontmatter-Utility und ULID-Generator ziehen
  dorthin. `server` behält nur Hono-Routes + Bootstrap. `mcp` (neu) importiert
  ebenfalls aus `@lokyy/core`. `packages/shared` bleibt für reine Typen.
- **MCP-Server importiert Core direkt**, läuft aber als eigener Workspace —
  MCP und HTTP haben unterschiedliche Lebenszyklen/Transports. Begründung
  gehört ins Architecture-Doc.
- **Der Memory-Layer sitzt hinter einem `MemoryProvider`-Interface in `core`**
  (siehe „Memory-Modell"). Stufe 2 ist die erste Implementierung; Stufe 3
  (Graphiti o.ä.) ist eine optionale zweite Implementierung desselben
  Interface, kein eigener Workspace und kein Pflicht-Dependency.
- **Forgejo bleibt die einzige Wahrheit für Notiz-Inhalte.** Jeder Index
  (Stufe 2/3) ist abgeleitet — geht er verloren, wird er aus dem Vault neu
  gebaut.
- **MCP-Scoping kommt aus dem Vault.** `00_meta/mcp-scopes.yaml` definiert
  Read/Write-Globs und einen `commit_prefix` pro Agent (Default Deny). Der
  MCP-Server **liest diese Datei** und setzt die Scopes durch — kein eigenes
  Berechtigungsmodell. Jeder schreibende MCP-Aufruf nutzt den `commit_prefix`
  in der Git-Message (Audit-Trail). Auch der Konsolidierungs-Agent läuft
  unter einem Scope.
- **Memory-Sync nie blockierend.** Forgejo-Commit zuerst, Index-Sync (Stufe
  2/3) danach als Fire-and-forget mit Fehler-Logging. Ein Ausfall des
  Index — besonders des optionalen Stufe-3-Graphen — darf das Speichern und
  den Serverstart nie verhindern.

## Inhaltlicher Scope — als Grundlage für Epics/Stories

Die folgenden Arbeitsblöcke sind der grobe Umfang. Der **genaue
Story-Schnitt ist Aufgabe des Scrum Masters** auf Basis von PRD und
Architecture — diese Liste ist Input, keine fertige Story-Struktur.

1. **Rename + lokyy-vault.** „Sternwarte"/„sternwarte" → „lokyy-brain" bzw.
   Paket-Scope `@lokyy/*` durchgängig (Package-Namen, README, PWA-Manifest,
   `index.html`, Kommentare). lokyy-vault als frisches Repo aufsetzen
   (Struktur/SPEC/Schemas/Hook/Templates vom Referenz-Vault, `paione` →
   `lokyy`).
2. **Core-Refactor + Vault-Compliance.** `packages/core` anlegen, Services
   dorthin ziehen. Frontmatter-Utility + ULID-Generator. `notesService`
   schema-konform machen. Hook-Fehlschlag als eigener Fehlertyp. Pipe-Ziel
   auf `30_captures/` umstellen.
3. **Memory-Layer Stufe 1+2.** `MemoryProvider`-Interface in `core`. Stufe 1
   (struktureller Index — Wikilinks/Tags/Volltext, größtenteils vorhanden)
   konsolidieren. Stufe 2 (semantischer Index) als erste Implementierung:
   kleines self-hosted Embedding-Modell, pgvector/LanceDB, `search` +
   `related`. Sync-Hooks in den schreibenden Operationen (fire-and-forget).
   State in `70_pai/memory/`. Server-Routes für Suche, Related, Reindex.
4. **Konsolidierungs-Agent.** Geplanter Lauf (Scheduler), der über den
   MCP-Server geänderte/neue Notizen seit dem letzten Lauf nimmt und den
   Vault anreichert (fehlende Wikilinks, `topic`-Notizen,
   `70_pai/interventions/`). Schreibt durch den Git-Service, SPEC-konform.
   „Letzter Lauf"-Marker in `70_pai/memory/`.
5. **MCP-Server-Workspace.** `@lokyy/mcp` mit MCP-SDK. Tools für Notizen,
   Struktur, Graph, Suche, Import/Pipes, Wartung. Scoping aus
   `00_meta/mcp-scopes.yaml`. Transport stdio default. `search_vault` und
   `related_notes` ab Tag eins (bedient von Stufe 1+2).
6. **Stufe-3-Graph (optional, Plugin).** Anbindung eines temporalen
   Knowledge-Graphen (Kandidat: Graphiti) als zweite `MemoryProvider`-
   Implementierung. Strikt optional — ist sie nicht konfiguriert, läuft alles
   ohne sie. Im Architecture-Doc als eigenes, abgrenzbares Epic, das **nach**
   1–5 kommt und auch ganz entfallen oder vertagt werden kann.
7. **Offene PWA-Bausteine.** Graph-Frontend mit `react-force-graph` (Layout
   gemäß Mockup). IndexedDB-Offline-Layer (Cache + Save-Queue, Replay beim
   Reconnect, Konflikt-/Hook-Fehler sauber behandeln).

## Querschnitt — in PRD/Architecture als nicht-funktionale Anforderungen

- **Stil:** knappe deutsche Code-Kommentare, die das *Warum* erklären; pure
  Funktionen wo möglich; Services dependency-arm.
- **Typen** in `@lokyy/shared`, wenn von mehr als einem Workspace gebraucht.
- **Forgejo-Prinzip:** jede schreibende Operation geht durch den Git-Service.
- **SPEC-Prinzip:** keine `.md` ohne gültiges, schema-konformes Frontmatter.
- **Definition of Done je Story:** `pnpm -r build` grün, Akzeptanzkriterien
  der Story erfüllt, QA-Abnahme. `.env.example` je Workspace aktuell
  (`GIT_REMOTE` → lokyy-vault, Embedding-Modell-Config für Stufe 2,
  MCP-Transport-Vars; Stufe-3-Vars nur falls das optionale Epic gezogen
  wird). `README.md` am Projektende auf den Endzustand aktualisiert.

## Offene Punkte — vom Orchestrator vor dem PRD zu klären

- **Embedding-Modell für Stufe 2:** welches kleine, self-hosted
  Embedding-Modell (Ollama o.ä.) und welche Vektor-Ablage (pgvector vs.
  LanceDB)? Bestimmt die konkrete Stufe-2-Implementierung.
- **lokyy-vault-Repo:** wo wird es gehostet (Forgejo-Instanz, Pfad) und unter
  welchem Namen?
- **ULID + Frontmatter:** bestehende Libraries nutzen oder schlank selbst
  implementieren? (Empfehlung: bestehende — `ulid`, `gray-matter`, `ajv` für
  Schema-Validierung.)
- **MCP-Client-Identität:** wie wird einem MCP-Client beim Connect sein
  Scope aus `mcp-scopes.yaml` zugeordnet? (Empfehlung: Scope pro
  Server-Instanz beim Start via Env/CLI-Arg, nicht dynamisch ausgehandelt.)
- **Stufe 3 — nur falls das optionale Epic gezogen wird:** finale Tool-Wahl
  (Graphiti/LightRAG/Cognee) und dessen API/Auth. Bewusst **vertagt** — soll
  auf Basis echter Nutzung von Stufe 1+2 entschieden werden, nicht jetzt.

## Endzustand

Ein Monorepo `lokyy-brain` mit fünf Workspaces — `packages/shared`,
`packages/core`, `server`, `pwa`, `mcp` — in dem `core` die Logik hält,
`server` sie als HTTP-API und `mcp` sie als gescopte MCP-Tools exponiert. Es
arbeitet auf dem standardisierten **lokyy-vault** (SPEC, Schemas,
Pre-commit-Hook eingehalten). Der Memory-Layer ist geschichtet: struktureller
Index (Stufe 1) und semantischer Index (Stufe 2) sind eingebaut, der
Konsolidierungs-Agent reichert den Vault über geplante Läufe an, und ein
temporaler Knowledge-Graph (Stufe 3, Kandidat Graphiti) lässt sich als
**optionales Plugin** hinter demselben `MemoryProvider`-Interface zuschalten
— ist er da, macht er das System besser, ist er nicht da, läuft alles ohne
ihn. Die PWA-Plattform ist mit Graph-Ansicht und Offline-Fähigkeit komplett.
Das Ganze auf dem lokyy-vault = das Second Brain „Lokyy" — bedienbar vom
Menschen über die PWA, von jeder KI über MCP.