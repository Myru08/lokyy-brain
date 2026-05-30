# Epic 11 — Architektur-Addendum (Lokyy-Workspace)

> **Autor:** Winston (Architect) · **Datum:** 2026-05-30 · **Status:** Sign-off für Welle 1
> **Geltung:** Verbindlich für Stories 11.1–11.11. Klärt die im Epic offenen Architektur-Entscheidungen.
> **Bezug:** `epic-11-lokyy-workspace.md`, `architecture.md`.

## 0. Codebase-Realität vs. architecture.md (lies das zuerst)

Die `architecture.md` beschreibt einen **angestrebten** Zustand (vault-scoped Routes `/api/vaults/:vaultId/...`,
`features/`-Ordner in der PWA, kebab-case-Files, React Query + Zustand). Der **tatsächliche** Code weicht ab,
und Epic 11 muss gegen die Realität gebaut werden, nicht gegen das Ideal:

| Aspekt | architecture.md (Ideal) | **Tatsächlicher Code (verbindlich für Epic 11)** |
|--------|--------------------------|---------------------------------------------------|
| Routes | `/api/vaults/:vaultId/notes` | **flach + single-vault**: `/api/notes`, `/api/vault/tree`, `/api/graph/tags`, `/api/dataview`, `/api/search` |
| PWA-Struktur | `pwa/src/features/{editor,…}` | **flach**: `pwa/src/App.tsx`, `FileTree.tsx`, `TagPane.tsx`, `Outline.tsx`, `BacklinksPanel.tsx`, `editor/` |
| File-Naming PWA | kebab-case | **PascalCase** Komponenten (`Resizable.tsx`, `CommandPalette.tsx`) |
| State | React Query + Zustand | **plain `useState` + Refs** in `App.tsx`; dünner `api`-Objekt-Wrapper in `pwa/src/api.ts`; UI-State (Panel-Breiten) in **localStorage** via `useResizableWidth` |
| `@lokyy/core` im Browser | verboten | korrekt — die PWA inlined Typen (z.B. `DataviewQuery`), weil core node-only ist |

**Konsequenz:** Die Epic-File-Pfade `pwa/src/sidebar/...` und `server/src/routes/workspace.ts` sind **neue, disjunkte**
Files — das passt. Aber alle Server-Routen sind **flach** (`/api/workspace`, `/api/dashboard`, `/api/share`), **nicht**
vault-scoped. Das Dashboard ruft **HTTP-Server-Routen** auf, **nicht** MCP-Tools (MCP läuft über stdio/HTTP für externe
Agents; die PWA hat keinen MCP-Client). Die MCP-Tools (`get_health`, `find_broken_links`, …) und die Server-Routen
teilen sich denselben **Core**-Code — genau dort setzen wir an (Code-vor-Prompts, eine Wahrheit).

---

## 1. Menü-Config-Persistenz & -Schema

### Entscheidung
- **Datei:** `00_meta/sidebar-menu.yaml` im Vault. Bestätigt (synct geräteübergreifend via gitService, „alles im Vault").
- **Frontmatter-Zwang:** Greift **nicht** — der pre-commit-Hook der lokyy-vault validiert ausschließlich `.md`-Dateien
  (Vault Contract: „Every `.md` file requires frontmatter"). `.yaml` in `00_meta/` ist analog zu den bereits gelebten
  `00_meta/schemas/*.json` und `00_meta/mcp-scopes.yaml` — diese liegen unkommentiert im Repo und werden nicht vom
  Frontmatter-Hook angefasst. **Verifikation vor Welle-1-Merge** (Open Point O-1): kurz testen, ob der konkrete
  pre-commit-Hook der vault `.yaml` im Pfad `00_meta/` durchlässt. Falls er **doch** blockt → Fallback `*.json`
  (`00_meta/sidebar-menu.json`); JSON kostet uns nichts (kein Kommentar-Bedarf, Schema bleibt identisch).
- **Lese-/Schreibweg:** Neuer Core-Service `packages/core/src/workspace/menuConfig.ts` + neue **flache** Server-Route
  `server/src/routes/workspace.ts` (gemountet als `app.route("/api/workspace", workspaceRoutes)`).
  - **Lesen:** `menuConfig.read()` → liest Datei über `coreConfig().vaultDir` + `git.pull()` zuerst (gleiches Muster wie
    `queryNotes`/`dataview`), parst YAML/JSON, validiert, merged System-Defaults (s. §3), gibt `MenuConfig` zurück.
  - **Schreiben:** `menuConfig.write(items)` → serialisiert **nur die `custom`-Items** (System-Items werden nie
    persistiert, s. §3), schreibt via **`gitService.save()`** (kein direkter fs-Write — harte Vault-Regel, Forgejo first).
    Commit-Message-Prefix `workspace:` (analog zu den `commit_prefix`-Konventionen der mcp-scopes).
- **Validierung:** In core, vor jedem Write **und** nach jedem Read (defensiv gegen handgepfuschte YAML). Bei
  invalidem Read → System-Defaults zurückgeben + Warnung loggen (`console.error`, Zone-2-Muster), **nie** crashen.
  Empfohlen: `ajv` (ist bereits Core-Dependency, `ajv@8.20.0`) mit einem JSON-Schema, das neben den `.md`-Schemas in
  `00_meta/schemas/sidebar-menu.schema.json` liegt — so ist die Menü-Config selbst SPEC-konform dokumentiert.

### Schema
```yaml
# 00_meta/sidebar-menu.yaml
version: 1                 # Schema-Version für spätere Migrationen
items:
  - id: "01J…"             # ULID, stabil; generiert via core `ulid` beim Anlegen
    label: "Projekte"
    icon: "folder"          # lucide-react Icon-Name (closed list, s. IconPicker §2)
    folder: "20_projects"   # Vault-relativer Ordnerpfad ("" = Vault-Root)
    viewType: "tree"        # Key aus der View-Registry (§2): "tree" | "skills" | "dashboard"
    shortcut: null          # v1 immer null (deferred, s. Epic Punkt 4 + O-3)
    kind: "custom"          # "custom" persistiert; "system" wird NIE in diese Datei geschrieben
```
```typescript
// packages/core/src/workspace/menuConfig.ts
export type ViewType = "tree" | "skills" | "dashboard";  // closed list v1
export interface MenuItem {
  id: string;            // ULID
  label: string;
  icon: string;          // lucide icon name
  folder: string;        // vault-relative path, "" = root
  viewType: ViewType;
  shortcut: string | null;
  kind: "system" | "custom";
}
export interface MenuConfig { version: number; items: MenuItem[]; }

export async function read(): Promise<MenuConfig>;            // pull → parse → validate → merge defaults
export async function write(customItems: MenuItem[]): Promise<MenuConfig>; // validate → save() custom only
```
HTTP (flach, single-vault, camelCase JSON — Hauskonvention):
```
GET  /api/workspace/menu     → { version, items: MenuItem[] }   (System + Custom gemerged)
PUT  /api/workspace/menu     ← { items: MenuItem[] }  (Server filtert kind:system raus, persistiert nur custom)
```

### Betroffene Files
- **NEU** `packages/core/src/workspace/menuConfig.ts` (+ `menuConfig.test.ts`)
- **NEU** `server/src/routes/workspace.ts`
- **EDIT (Orchestrator-Wireup)** `server/src/index.ts` → `app.route("/api/workspace", workspaceRoutes)`
- **EDIT (Orchestrator-Wireup)** `pwa/src/api.ts` → `api.getMenu()`, `api.putMenu(items)`
- **NEU (Seed)** `00_meta/schemas/sidebar-menu.schema.json` im Vault-Repo

---

## 2. View-Typ-Registry (Frontend)

### Entscheidung
Eine **statische, geschlossene** Registry — explizit **kein** Plugin-System v1. Ein Record `viewType → Renderer-Komponente`.
Renderer bekommen ein einheitliches, minimales Props-Interface, damit ein Menüpunkt sie generisch mounten kann
(„Menüpunkt = (Ordner) + (View-Typ)"-Leitprinzip). Der Renderer entscheidet selbst, ob er `folder` braucht
(`tree` ja, `dashboard`/`skills` ignorieren ihn bzw. haben fixen Ordner).

### Interface
```typescript
// pwa/src/sidebar/views/registry.ts
import type { ComponentType } from "react";

export interface ViewProps {
  item: MenuItem;                 // der aktive Menüpunkt (label/folder/icon/viewType)
  onOpenNote: (noteId: string) => void;  // delegiert ins App.tsx open() — kein eigener State
}
export type ViewRenderer = ComponentType<ViewProps>;

// Bewusst statisch: kein dynamisches register() zur Laufzeit (KISS, v1).
export const VIEW_REGISTRY: Record<ViewType, ViewRenderer> = {
  tree: TreeView,
  skills: SkillsView,        // Platzhalter in Welle 1, echte Impl in 11.5
  dashboard: DashboardView,  // Platzhalter in Welle 1, echte Impl in 11.11
};

export function resolveView(viewType: ViewType): ViewRenderer {
  return VIEW_REGISTRY[viewType] ?? TreeView;  // unbekannt → Default tree (defensiv)
}
```
**Welle-1-Scope (11.4):** Registry-Datei + `TreeView.tsx` (echt) + die beiden anderen als **Lazy-Import-Stubs**
(„Coming soon"), damit die Registry typvollständig ist, ohne auf 11.5/11.11 zu blockieren. `DashboardView`/`SkillsView`
sollten **lazy** geladen werden (gleiche `lazy()`-Praxis wie `GraphView` in `App.tsx` — der Dashboard-Chunk ist nicht
auf dem kritischen Boot-Pfad).

### Betroffene Files
- **NEU** `pwa/src/sidebar/views/registry.ts`
- **NEU** `pwa/src/sidebar/views/TreeView.tsx` (umhüllt die bestehende `FileTree.tsx`-Logik mit `folder`-Scope —
  ersetzt sie nicht; reicht `onOpenNote` an `App.open()` durch)
- Stub-Verweise auf `SkillsView.tsx` (11.5) / `DashboardView.tsx` (11.11) — als `React.lazy`-Importe, Datei wird in
  jeweiliger Story angelegt → **keine Kollision**, solange 11.4 nur die Registry + Stub-Wrapper anlegt und die echten
  Dateien erst in 11.5/11.11 entstehen. **Flag:** 11.4 darf `SkillsView.tsx`/`DashboardView.tsx` **nicht** schon
  schreiben (sonst Kollision mit 11.5/11.11). 11.4 referenziert sie nur per Lazy-Pfad und liefert solange einen
  Inline-„Coming soon"-Fallback, bis die Datei existiert. → siehe Korrektur K-1.

---

## 3. System- vs. Custom-Menüpunkte (Merge-/Schutz-Strategie)

### Entscheidung
System-Items sind **Code-Konstanten** in der PWA (bzw. in core gespiegelt für die Reihenfolge), **nicht** in der
Vault-YAML. Beim Boot merged `menuConfig.read()`:

1. **System-Items** (hardcoded, `kind:"system"`) zuerst, in fixer Reihenfolge:
   - `Home` → `viewType:"dashboard"`, `folder:""` (Welle 5 / 11.10–11.11)
   - `Skill-Bibliothek` → `viewType:"skills"`, `folder:"70_pai/skills"` (Welle 3 / 11.5)
2. **Custom-Items** (aus YAML) danach.

Schutz-Invarianten (in core erzwungen, nicht nur UI):
- `PUT /api/workspace/menu` **verwirft** jedes eingehende Item mit `kind:"system"` serverseitig, bevor geschrieben wird
  (Client kann System-Items nicht überschreiben/löschen/umsortieren-persistieren).
- System-`id`s sind reservierte Konstanten (z.B. `"system:home"`, `"system:skills"`) — kollidieren nie mit ULIDs.
- Der MenuEditor (11.2) zeigt System-Items als **read-only** (kein Löschen/Editieren), Custom-Items voll editierbar.
- v1: **keine** Umsortierung der System-Items relativ zu Custom (Drag-Reorder ist ohnehin Later-Item). System immer oben.

### Schema/Interface
```typescript
// packages/core/src/workspace/menuConfig.ts — Defaults sind die einzige Wahrheit für System-Items
export const SYSTEM_ITEMS: MenuItem[] = [
  { id: "system:home",   label: "Home",            icon: "home",   folder: "",              viewType: "dashboard", shortcut: null, kind: "system" },
  { id: "system:skills", label: "Skill-Bibliothek", icon: "wand-2", folder: "70_pai/skills", viewType: "skills",    shortcut: null, kind: "system" },
];
// merge: [...SYSTEM_ITEMS, ...customFromYaml]
```

### Betroffene Files
- In `packages/core/src/workspace/menuConfig.ts` (Teil von 11.1) — kein zusätzliches File.

---

## 4. Collapsible-Panel-State (Story 11.9)

### Entscheidung — **Hybrid, mit klarer Regel:**
- **Open/zu pro Panel = reiner Ephemeral-UI-State → `localStorage`**, **nicht** Vault. Begründung:
  1. Es ist gerätespezifisch (Phone will andere Panels offen als Desktop — Vault-Sync wäre hier schädlich).
  2. Es ist der **etablierte Pfad** im Code: Panel-Breiten liegen bereits in `localStorage` (`useResizableWidth`,
     Key `lokyy:resize:*`). Konsistenz schlägt das „alles im Vault"-Prinzip dort, wo der State weder Wissen noch
     Inhalt ist (er ist Fenster-Zustand). Der Epic-Text („Zustand pro Panel im Vault gemerkt, konsistent zu 11.1")
     wird hier **bewusst korrigiert** → siehe Korrektur K-2.
  3. Kein Forgejo-Commit-Lärm für jeden Panel-Toggle.
- **Menü-Config (11.1) bleibt im Vault** — das ist Konfiguration, kein Fenster-Zustand. Die beiden Regime sind sauber
  getrennt: *Was es gibt* (Menüpunkte) → Vault; *wie es gerade aussieht* (offen/zu, Breite) → localStorage.
- Optionaler späterer Pfad: ein Default-Open-Set in der Menü-/Workspace-Config (Vault), das localStorage nur
  initialisiert. **Nicht** v1.

### Komponentenschnitt — `CollapsiblePanel` umhüllt, ersetzt nicht
```typescript
// pwa/src/panels/CollapsiblePanel.tsx
export function CollapsiblePanel(props: {
  id: string;                      // localStorage-Key-Suffix: "lokyy:panel:<id>"
  title: string;
  icon?: ReactNode;               // lucide icon, optional
  side: "left" | "right";         // bestimmt, an welcher Kante das Fähnchen sitzt
  defaultOpen?: boolean;          // Default false (Epic: "alle Panels default geschlossen")
  children: ReactNode;            // das bestehende Panel (TagPane/Outline/BacklinksPanel) UNVERÄNDERT
}): JSX.Element;
```
- Liest/schreibt `localStorage["lokyy:panel:<id>"]` ("1"/"0"), gleiches try/catch-Muster wie `useResizableWidth`.
- Rendert das Aufklapp-Fähnchen an der Kante (`side`) wenn zu; Klick → volle, scroll-/suchbare Fläche.
- **Wireup ist Orchestrator-Job** (Epic sagt das korrekt): die bestehenden `TagPane`/`Outline`/`BacklinksPanel`
  werden in `App.tsx` mit `<CollapsiblePanel>` umwickelt. 11.9 liefert **nur** die Wrapper-Komponente + Tests; die
  Verdrahtung in `App.tsx` macht ein separater Wireup-Schritt **nach** dem parallelen Batch (sonst kollidiert 11.9
  mit jeder anderen `App.tsx`-berührenden Story).

### Betroffene Files
- **NEU** `pwa/src/panels/CollapsiblePanel.tsx` (+ ggf. `useCollapsiblePanel`-Hook inline)
- **EDIT (Orchestrator-Wireup, NACH Batch)** `pwa/src/App.tsx` (umhüllt vorhandene Panels)

---

## 5. Dashboard-Datenbeschaffung (Story 11.11)

### Entscheidung — **gebündelter `GET /api/dashboard` JA, aber als Komposit aus 2 Latenz-Klassen.**
Ein einzelner Aggregat-Endpunkt (`server/src/routes/dashboard.ts`, gemountet `app.route("/api/dashboard", …)`) ist
sinnvoll: 1 Call statt N, eine Latenz-Budget-Stelle, leichter zu cachen. **Aber** zwei Kacheln sind teuer
(vault-weiter Voll-Scan): **Streak/Heatmap** (git-log über das ganze Repo) und **Lose Enden** (Volltext-`#todo`-Scan).
Damit das Dashboard nicht auf den langsamsten Teil wartet:

- `GET /api/dashboard` liefert die **billigen** Kacheln synchron (counts, recent, health).
- **Teure** Kacheln (`streak`, `looseEnds`) bekommen **eigene** Endpunkte und werden vom `DashboardView` separat/lazy
  nachgeladen (skeleton zuerst). Optional als `?include=streak,looseEnds` an denselben Endpunkt — aber getrennte
  Routes sind einfacher zu testen und parallelisierbar in der Dev.

| Kachel | Quelle | Vorhanden? | Endpoint/Feld |
|--------|--------|-----------|----------------|
| Hero-Zahlen / Counts | core `queryNotes` (Gruppierung nach `type`) + `listTags` | **vorhanden** (dataview, graph/tags) | `GET /api/dashboard` → `counts: { notes, byType: {…}, tags }` |
| Vault-Gesundheit | core `findBrokenLinks` | **vorhanden** (MCP `find_broken_links` nutzt dieselbe core-Fn) | `GET /api/dashboard` → `health.brokenLinks: number` (+ Top-N Liste) |
| Zuletzt bearbeitet | core `queryNotes` `{ sort:"updated", order:"desc", limit:N }` | **vorhanden** | `GET /api/dashboard` → `recent: { id, title, updated }[]` |
| Sync/System | core `getHealth(...)` | **vorhanden** | `GET /api/dashboard` → `system: HealthSnapshot` (oder Reuse `/api/diagnostics`) |
| Heutiges Journal | core `queryNotes` `{ from:"40_daily", … }` / Datums-Konvention | **vorhanden** | `GET /api/dashboard` → `today: { id, title } \| null` |
| Serendipity | core `queryNotes` → zufällige Auswahl (serverseitig 1 ziehen) | **vorhanden** | `GET /api/dashboard` → `serendipity: { id, title }` |
| Quick-Actions / Quick-Capture | reine UI; Quick-Capture postet an **bestehende** `/api/pipes` bzw. `/api/vault/note` | **vorhanden** | kein neues Backend |
| **Git-Activity-Heatmap** | **NEU**: vault-weites `git log --format=%cI` Aggregat | **NEU** — `noteHistory` ist **per-Note** (`git log -- <path>`), es gibt **kein** Repo-weites Log | `GET /api/dashboard/activity` → `{ days: { date, commits }[] }` (letzte 365 Tage) |
| **Streak** | **NEU**: leitet sich aus demselben vault-weiten git-log ab (aufeinanderfolgende Tage mit ≥1 Commit) | **NEU** | gleicher Endpoint `GET /api/dashboard/activity` → `{ currentStreak, longestStreak }` |
| **Lose Enden** (offene `#todo`/Checkboxen) | **NEU**: vault-weiter Body-Scan nach `- [ ]` / `#todo` | **teilweise** — kein fertiges Aggregat; core-Walk-Muster (wie `dataview.walk`) existiert, Volltext-Index (`note_search`/BM25) **könnte** genutzt werden, aber Checkbox-Syntax ist kein gutes BM25-Token | `GET /api/dashboard/loose-ends` → `{ items: { noteId, title, line, text }[], total }` |
| **Unverarbeitet + Konsolidierungs-Vorschläge** | Epic 8 (Sleep-Agent/Kurator) + Agent-Review-Queue | **vorhanden, aber Epic-8-abhängig** — `/api/agent-review/queue` existiert bereits (mem0/lint/topicNotes) | Reuse `GET /api/agent-review/queue`; **markiert als Epic-8-Abhängigkeit** |

**Performance für die zwei teuren Routen:**
- **Activity/Streak:** EIN `git log --format=%cI` über das ganze Repo (HEAD), im gitService-`serialize`-Lock, dann
  in-memory zu Tagesbuckets aggregieren. Das ist ein einziger git-Aufruf — günstig selbst bei 10k Notes. **Neuer
  core-Helper** `vaultActivity(sinceDays)` in `packages/core/src/git/gitService.ts` (read-only, gleiches
  `serialize`+`git()`-Muster wie `noteHistory`). Empfohlen: in-process Memo-Cache (60 s TTL), da das Dashboard ggf.
  häufig geöffnet wird.
- **Lose Enden:** vault-weiter fs-Walk (wie `dataview.walk`) + Zeilen-Regex `^\s*[-*] \[ \]` und `#todo`. Bei großen
  Vaults teuer → **eigener Endpoint, lazy geladen, mit `limit`** (Default 50) und in-process Memo-Cache (z.B. 60 s).
  **Nicht** in den synchronen `/api/dashboard`-Call ziehen. (Re-evaluieren ob `note_search` hier später hilft —
  v1 reicht der Walk; Vaults sind single-user, NFR-Budget ist großzügig.)

### Schema (Aggregat)
```typescript
// GET /api/dashboard  (billige Kacheln, synchron)
interface DashboardSummary {
  counts: { notes: number; byType: Record<string, number>; tags: number };
  health: { brokenLinks: number; brokenTop: { sourceId: string; target: string }[] };
  recent: { id: string; title: string; updated: string }[];     // updated = ISO
  today: { id: string; title: string } | null;
  serendipity: { id: string; title: string } | null;
  system: { syncState: string; vaultId: string };               // aus getHealth()
}
// GET /api/dashboard/activity?days=365   (teuer, lazy)
interface DashboardActivity {
  days: { date: string; commits: number }[];
  currentStreak: number;
  longestStreak: number;
}
// GET /api/dashboard/loose-ends?limit=50  (teuer, lazy)
interface DashboardLooseEnds {
  items: { noteId: string; title: string; line: number; text: string }[];
  total: number;
}
```

### Betroffene Files
- **NEU** `server/src/routes/dashboard.ts` (3 Routen)
- **NEU/EDIT** `packages/core/src/git/gitService.ts` → `vaultActivity(sinceDays)` (read-only Helper) — **Flag K-3:**
  das ist eine **gemeinsame** Datei (gitService). Der Helper muss in **11.11** liegen, nicht parallel zu einer anderen
  gitService-berührenden Story. Aktuell berührt keine andere Welle-5-Story gitService → konfliktfrei, aber im
  Sprint-Plan markieren.
- **NEU** `packages/core/src/workspace/looseEnds.ts` (vault-Walk + Checkbox/#todo-Scan, eigener File → konfliktfrei)
- **NEU** `pwa/src/sidebar/views/DashboardView.tsx`
- **EDIT (Orchestrator-Wireup)** `server/src/index.ts`, `pwa/src/api.ts`

---

## 6. Share-Target (Story 11.8)

### Entscheidung — **Server-Seite ist zu ~80 % bereits gebaut.** Der echte Gap ist PWA-Manifest + Quittungs-UX.
Befund im Code:
- `server/src/routes/pipes.ts` hat **bereits** `POST /api/pipes/share`, das `multipart/form-data`
  (`title`/`text`/`url`/`file`) **und** JSON akzeptiert und `enqueue(payload)` aufruft.
- `packages/core/src/pipes/pipeQueue.ts` hat `SharePayload`, `PipeType`, `detectType()`, `enqueue()`, `registerHandler()`.

Daraus folgt eine **Umschneidung** von 11.8 (→ Korrektur K-4): 11.8 ist **keine** neue `server/src/routes/share.ts`,
sondern (a) das **PWA-Manifest** `share_target` + (b) ein **Empfangs-/Quittungs-Screen** in der PWA + (c) der
**YouTube-JSON-Bugfix**. Die Verarbeitung bleibt — wie im Epic abgegrenzt — in Epic 6.

- **Manifest:** In `pwa/vite.config.ts` (`vite-plugin-pwa` → `manifest`) ein `share_target`-Block ergänzen, der per
  `POST` (enctype `multipart/form-data`) auf eine **PWA-Route** zielt (z.B. `/share`). Der Service Worker / die
  PWA-Route nimmt den Share entgegen und posted an das **bestehende** `POST /api/pipes/share`.
```jsonc
// vite.config.ts → VitePWA({ manifest: { ... share_target ... } })
"share_target": {
  "action": "/share",
  "method": "POST",
  "enctype": "multipart/form-data",
  "params": {
    "title": "title",
    "text": "text",
    "url": "url",
    "files": [{ "name": "file", "accept": ["image/*", "application/pdf"] }]
  }
}
```
- **Empfangs-Route (PWA):** eine schlanke Route/Komponente `pwa/src/share/ShareTarget.tsx`, die den geteilten Inhalt
  einsammelt, an `api.share(...)` (neuer dünner Wrapper auf `POST /api/pipes/share`) gibt und eine **Quittung** zeigt.
- **YouTube-JSON-Bug:** Ursache ist die Anzeige der **Roh-JSON-Antwort** des enqueue/Pipe-Calls. Fix:
  `POST /api/pipes/share` gibt ohnehin ein `PipeJob` zurück — der ShareTarget-Screen zeigt **nie** das JSON, sondern
  eine fixe Bestätigung „In Inbox aufgenommen — {title|url}" + Link „Inbox öffnen" (Import-Panel). Quittung lebt rein
  in der PWA; der bestehende Endpoint bleibt unverändert. (Falls der Roh-JSON-Bug aus einem bestehenden Pfad in
  `ImportPanel.tsx`/`api.ts` stammt: dort die Job-Antwort in eine Statusmeldung mappen, nicht stringify-en.)

### Betroffene Files
- **EDIT** `pwa/vite.config.ts` (Manifest `share_target`) — **Flag:** gemeinsame Config-Datei; sollte allein in 11.8
  liegen (keine andere Welle-4-Story berührt vite.config) → konfliktfrei.
- **NEU** `pwa/src/share/ShareTarget.tsx`
- **EDIT (Orchestrator-Wireup)** `pwa/src/main.tsx` (Route `/share`) + `pwa/src/api.ts` (`api.share()`)
- **KEIN** neues `server/src/routes/share.ts` nötig — `POST /api/pipes/share` existiert. Falls 11.8 dennoch eine
  dedizierte Route will (sauberere URL `/api/share`), darf sie als dünner Alias auf denselben `enqueue`-Pfad angelegt
  werden — aber das ist optionaler Zucker, nicht der Kern.

---

## 7. Risiken, Abhängigkeiten & Wellen-Reihenfolge

### Hält die Reihenfolge? — **Im Wesentlichen ja, mit drei Korrekturen.**
Die vorgeschlagene Sequenz `11.1 → (11.4 ∥ Sign-off) → 11.3 → 11.2 → (11.5 ∥ 11.6 ∥ 11.7) → 11.8` ist tragfähig.

**Vor Welle 1 zu entscheiden (jetzt erledigt bzw. an Oliver eskaliert):**
- §1 YAML-vs-JSON-Persistenz (Default YAML, Fallback JSON) — Verifikation O-1 vor Merge.
- §2 Registry ist statisch, geschlossene `ViewType`-Union — fixiert.
- §3 System-Items sind Code-Konstanten, serverseitig vor Persistenz gefiltert — fixiert.

**Abhängigkeiten / Risiken:**
- **R-1 (Epic 8 ⟂ 11.11-Konsolidierungskachel):** Die „Unverarbeitet + Konsolidierungs-Vorschläge"-Kachel hängt am
  Sleep-Agent/Agent-Review (Epic 8). `/api/agent-review/queue` existiert bereits → Kachel kann gegen das bestehende
  Endpoint gebaut werden, **degradiert leer** wenn Epic 8 noch keine Vorschläge produziert. **Kein Blocker**, aber im
  Story-AC als „graceful empty state" festhalten.
- **R-2 (Welle 1 vor Welle 5):** `viewType:"dashboard"` und der Home-System-Menüpunkt sind in §3/§2 schon im Datenmodell
  vorgesehen. Dadurch kann Welle 1 das Modell vollständig fixieren, ohne auf Welle 5 zu warten — gut. Der Epic-Hinweis
  „11.11 erst nach eigenem Brainstorm" bleibt gültig; 11.10 (Logo→Home) kann früher.
- **R-3 (`App.tsx`-Kollisionsgefahr):** `App.tsx` ist die zentrale Datei und wird von 11.3 (Sidebar-Mount), 11.9
  (Panel-Wrapping) und 11.10 (Logo-Header) berührt. **Diese drei dürfen nicht parallel `App.tsx` schreiben.** Regel:
  parallele Stories liefern nur ihre **neuen** Files; alle `App.tsx`-Edits laufen über **einen** Orchestrator-Wireup-
  Schritt nach dem Batch (steht im Epic für 11.9/11.10 schon so, gilt auch für 11.3).
- **R-4 (gitService geteilt):** `vaultActivity` (§5) liegt in `gitService.ts`. Nur 11.11 berührt das → ok, aber nicht
  parallel zu einer anderen gitService-Story schedulen.

### Korrekturen am Epic
- **K-1:** 11.4 legt `SkillsView.tsx`/`DashboardView.tsx` **nicht** an (nur Registry + `TreeView.tsx` + Lazy-Stubs).
  Die echten View-Dateien entstehen in 11.5 bzw. 11.11 — sonst Datei-Kollision.
- **K-2:** Story 11.9 — Panel-Open/zu-State liegt in **localStorage**, **nicht** im Vault (begründet in §4). Epic-Text
  „im Vault gemerkt, konsistent zu 11.1" entsprechend anpassen.
- **K-3:** Story 11.11 — Streak/Heatmap brauchen einen **neuen vault-weiten git-log-Helper** (`vaultActivity`), weil
  `noteHistory` per-Note ist. Im AC + Files explizit aufnehmen (`gitService.ts` + `dashboard/activity`-Route).
- **K-4:** Story 11.8 — die Server-Empfangs-Route existiert bereits (`POST /api/pipes/share` + `SharePayload`/
  `enqueue`/`detectType` in core). 11.8 reduziert sich auf **PWA-Manifest `share_target` + ShareTarget-Quittungs-Screen
  + YouTube-JSON-Anzeige-Fix**. Keine neue `server/src/routes/share.ts` nötig (optionaler Alias erlaubt). Files-Spalte
  des Epics entsprechend korrigieren.

---

## Offene Punkte für Oliver (echte Entscheidungen)

- **O-1 — `.yaml` vs `.json` in `00_meta/`:** Lässt der konkrete pre-commit-Hook der lokyy-vault eine `.yaml`-Datei in
  `00_meta/` ohne Frontmatter durch? Wenn ja → `sidebar-menu.yaml`. Wenn nein → `sidebar-menu.json`. (Architekt-Default:
  YAML; Fallback kostet nichts.) Bitte am echten Vault verifizieren bzw. bestätigen, dass `00_meta/mcp-scopes.yaml`
  heute schon committet wird (dann ist die Frage beantwortet → YAML).
- **O-2 — Home/Dashboard-Scope v1:** Soll die Skill-Bibliothek der **einzige** System-Menüpunkt in den frühen Wellen
  sein und Home/Dashboard erst mit Welle 5 dazukommen? (Das Datenmodell trägt beides; es geht um die Reihenfolge der
  sichtbaren Auslieferung.)
- **O-3 — Shortcuts pro Menüpunkt:** v1 ohne (Feld `shortcut` bleibt `null`)? Der Epic neigt schon dazu (Later-Item).
  Bitte bestätigen, damit der MenuEditor (11.2) das Feld gar nicht erst anzeigt.
- **O-4 — „Lose Enden"-Definition:** Zählt als loses Ende nur die GFM-Checkbox `- [ ]`, oder auch das Tag `#todo`,
  oder beides? Und sollen `30_captures`/Archiv-Ordner ausgeschlossen werden? (Beeinflusst Scan-Regex + Rauschen.)
- **O-5 — Lokyy-OS-Grenze bestätigt:** Das Epic-11-Dashboard bleibt Vault-/Wissens-fokussiert; Projekte/Tasks/Ziele
  (Life-OS) gehören in das separate Hermes-basierte Lokyy OS. Bitte bestätigen, dass keine Telos-/Task-Kachel in
  Epic 11 rutscht (ich habe sie konsequent draußen gehalten).
