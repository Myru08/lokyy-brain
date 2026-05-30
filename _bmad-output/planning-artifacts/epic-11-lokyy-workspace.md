# Epic 11 — Lokyy-Workspace

Status: backlog

> **Quelle:** Vault-Ideen aus dem Brainstorm 2026-05-30:
> - `90_ideas/dynamische-seitenleisten-menuepunkte` (ULID `01KSW7SYGZQ0G9XAPHY1EVR1ME`) — Kern
> - `90_ideas/share-to-inbox-pipeline` (ULID `01KSW6SESJJ87M3J9ZQH7QK9VV`) — Share-Front-Tür (Brücke zu Epic 6)
> - `90_ideas/prompt-bibliothek` (ULID `01KSW6TQG2WXZVSMBK6NE1M0X9`) — **❌ verworfen**, Entscheidung: Prompt = Skill ohne Ausführungsbefehl, keine separate Bibliothek.
> - `90_ideas/workspace-shell-ux` (ULID `01KSW8DAN19ZDFNSW5ZR44ZSBG`) — Shell-UX: Aufklapp-Fähnchen, klickbares Logo→Home, Dashboard-Landing (Welle 5).
>
> **Scope-Abgrenzung (wichtig):** Die typabhängigen Verarbeitungs-Pipelines (YouTube-Transkript,
> Web-Capture, Bild-Beschreibung, Inbox-Panel) sind **bereits Epic 6 (Content Import / Pipes)** —
> Stories 6-2/6-3/6-6 + `story-kurator-panel`. Epic 11 dupliziert das **nicht**. Aus dem Share-Thema
> wandert nur die *neue* PWA-**Share-Target-Front-Tür** (inkl. YouTube-JSON-Bugfix) als **eine**
> Brücken-Story (11.8) hierher; die Verarbeitung dahinter bleibt Epic 6.

## Ziel

Lokyy-Brain vom Notiz-Editor zum **anpassbaren, modell-agnostischen Workspace** machen — dem zentralen
Ort für Informationen **und** Skills. Drei Cluster:
**(A)** benutzerdefinierte, ordner-gemappte Seitenleisten-Navigation mit View-Typen;
**(B)** Skill-UX (Skill-Library-View wie Claude Desktop, Skill-Creator-Skill, Open-Skill/MCP);
**(C)** eine Brücken-Story für die PWA-Share-Front-Tür Richtung Epic 6.

**Leitprinzip:** *Ein generischer Mechanismus* — Menüpunkt = (Ordner-Mapping) + (View-Typ). Die
Skill-Bibliothek ist nur die erste **fixe (System-)Instanz** davon, kein Sonderbau.

## Offene Architektur-Entscheidungen (Architect-Sign-off VOR Welle 1)

> BMAD: Diese Punkte ändern das Datenmodell/die PWA-Struktur — **nicht still entscheiden**. Architect
> (Winston) bestätigt oder korrigiert, bevor 11.1/11.4 in Dev gehen.
>
> **✅ Geklärt 2026-05-30 — Details in [`epic-11-architecture-addendum.md`](epic-11-architecture-addendum.md).**
> Querschnitts-Befund: `architecture.md` ist aspirativ; der echte Code ist **flach + single-vault**
> (Routen ohne `:vaultId`), PWA flach/PascalCase mit `useState`+Refs, UI-State in localStorage. Die PWA
> hat **keinen MCP-Client** → das Dashboard ruft **HTTP-Routen**, nicht MCP-Tools (Server + MCP teilen den Core).

1. **Menü-Config-Persistenz** — Vorschlag: `00_meta/sidebar-menu.yaml` im Vault (synct geräteübergreifend,
   passt zum „alles im Vault"-Prinzip), **nicht** localStorage. Schema: geordnete Liste von Menüpunkten
   `{ id, label, icon, folder, viewType, shortcut?, kind: system|custom }`.
2. **View-Typ-Registry** — Frontend-Registry `viewType → Renderer`. Initial nur `tree` (Default) + `skills`.
   Bewusst **klein** halten (kein Plugin-System in v1).
3. **System- vs. Custom-Menüpunkte** — `kind: system` ist unveränderlich (z.B. Skill-Bibliothek, fix auf
   `70_pai/skills/` + `viewType: skills`) und wird beim Boot gemerged, nicht aus der User-Config gelesen.
4. **Shortcut-Kollision** — Menü-Shortcuts sind **in v1** (Entscheidung 30.05.) und dürfen bestehende
   Keybindings (Command-Palette/CM6) nicht überschreiben → zentrale Keybinding-Registry + Kollisionsprüfung im Editor.

## Wellen / Reihenfolge

### Welle 1 — Fundament (Config-Modell + Rendering)

| Story | Titel | Files (konfliktfrei) |
|-------|-------|----------------------|
| **11.1** | Menü-Config-Modell + Vault-Persistenz (`00_meta/sidebar-menu.yaml`), Core-Service lesen/schreiben/validieren, System-Defaults-Merge | `packages/core/src/workspace/menuConfig.ts` (neu), `server/src/routes/workspace.ts` (neu) (+ tests) |
| **11.4** | View-Typ-Registry im Frontend (`tree` Default + Platzhalter `skills`), Routing Menüpunkt→Renderer | `pwa/src/sidebar/views/registry.ts` (neu), `pwa/src/sidebar/views/TreeView.tsx` (neu) |

### Welle 2 — Sidebar-UI & Editor

| Story | Titel | Files (konfliktfrei) |
|-------|-------|----------------------|
| **11.3** | Seitenleisten-Rendering der Menüpunkte (System fix + Custom), aktiver Menüpunkt, ein-/ausklappbar | `pwa/src/sidebar/Sidebar.tsx` (neu) |
| **11.2** | Zahnrad-Editor: Menüpunkt anlegen/bearbeiten/löschen — Name, Icon-Picker, Ordner-Picker, View-Typ **+ Shortcut** (in v1, mit Kollisionsauflösung ggü. Command-Palette/CM6) | `pwa/src/sidebar/MenuEditor.tsx` (neu), `pwa/src/sidebar/IconPicker.tsx` (neu) |

### Welle 3 — Skill-UX

| Story | Titel | Files (konfliktfrei) |
|-------|-------|----------------------|
| **11.5** | Skill-Library-View (`viewType: skills`): Karten + Markdown-Vorschau + Verschachtelung, gemappt auf `70_pai/skills/`, als fixer System-Menüpunkt (Claude-Desktop-Stil) | `pwa/src/sidebar/views/SkillsView.tsx` (neu) |
| **11.6** | Skill-Creator-Skill: geführter Flow (Titel, Ausführungsbefehl/Name, Prompt) → SPEC-valide `type: skill`-Note nach `70_pai/skills/`; Seed ins Vault-Repo | Vault-Seed `70_pai/skills/skill-creator.md` (nutzt `00_meta/templates/skill.md` aus 10.5) |
| **11.7** | Open-Skill: Skill-Format-Doku + Bestätigung der modell-agnostischen MCP-Exposition (`list_skills`/`run_skill` aus Epic 9/7), optionaler Export | Doku `_bmad-output/` / README, `mcp/` (nur Verifikation, kein Schema-Bruch) |

### Welle 4 — Brücke zu Epic 6

| Story | Titel | Files (konfliktfrei) | Abhängigkeit |
|-------|-------|----------------------|--------------|
| **11.8** | PWA-**Share-Target**: nur **Frontend** nötig — Server ist ~80% da (`POST /api/pipes/share` + `SharePayload`/`enqueue`/`detectType` existieren, **kein** neuer Endpoint, K-4). Gap = `share_target`-Manifest + `ShareTarget.tsx`-Quittungsscreen + **YouTube-JSON-Bugfix** (Quittung „In Inbox aufgenommen" statt Roh-JSON) | `pwa` Manifest (`vite.config`/PWA-Plugin), `pwa/src/ShareTarget.tsx` (neu) | **Epic 6** Pipe-Handler (6-2/6-3); Verarbeitung bleibt dort |

### Welle 5 — Workspace-Shell UX (Quelle: `workspace-shell-ux`)

| Story | Titel | Files (konfliktfrei) |
|-------|-------|----------------------|
| **11.9** | Einheitliches **Aufklapp-Fähnchen-/Collapse-Pattern**: alle Panels default geschlossen, Fähnchen an der Kante, Klick → volle Fläche, scroll-/suchbar; Zustand pro Panel in **localStorage** (gerätespezifisch, Präzedenz `useResizableWidth` — **nicht** Vault, K-2). Vereinheitlicht bestehende Panels (TagPane, Outline, Backlinks), ersetzt keine Logik. | `pwa/src/panels/CollapsiblePanel.tsx` (neu); Anwendung pro Panel = Orchestrator-Wireup |
| **11.10** | **Klickbares Logo → Home-Menüpunkt** (System): Logo navigiert zur Home-Ansicht; Home ist ein fixer System-Menüpunkt (analog Skill-Lib) | `pwa/src/sidebar/Sidebar.tsx` (mit 11.3) + Shell-Header-Wireup (Orchestrator) |
| **11.11** | **Dashboard-View-Typ** (`viewType: dashboard`) als Home-Landing, Bento-Grid. **Ausrichtung: Vault-Wissens-Cockpit + Entdeckung** (kein Life-OS → Lokyy OS, s.u.). **Kacheln v1:** Hero-Zahlen (`queryNotes`/`get_tags`), Vault-Gesundheit (`find_broken_links`), Git-Activity-Heatmap (`get_history`), Zuletzt bearbeitet (`list_notes`), Sync/System (`get_health`), Quick-Actions, **Quick-Capture-Feld** (→ Epic 6), **Streak**, **Heutiges Journal** (`40_daily`), **Serendipity-Notiz**, **Lose Enden** (vault-weite offene `- [ ]`-Checkboxen **und** `#todo`), **Unverarbeitet + Konsolidierungs-Vorschläge** (→ Epic 8). | `pwa/src/sidebar/views/DashboardView.tsx` (neu); **gebündeltes** `GET /api/dashboard` (billige Kacheln: counts/health/recent/today/serendipity aus vorhandenem `queryNotes`/`findBrokenLinks`/`getHealth`) **+ 2 lazy Routen** `GET /api/dashboard/activity` (Streak+Heatmap → **neuer** vault-weiter git-log-Helper `vaultActivity`, da `noteHistory` nur per-Note, K-3) und `GET /api/dashboard/loose-ends` (neuer fs-Walk); Konsolidierungs-Kachel reused `/api/agent-review/queue` (⟂ Epic 8) |

> **Synergie:** 11.10/11.11 sind keine Sonderfälle — das Dashboard ist nur ein weiterer **View-Typ** (11.4-Registry), der Home-Menüpunkt eine weitere **System-Instanz** (11.3). Kein neuer Mechanismus.

## Abgrenzung / nicht in Epic 11

- **Verarbeitungs-Pipelines** (Transkription, Web-Descrape, Bild-Beschreibung, Inbox-Panel) → **Epic 6**.
- **Separate Prompt-Bibliothek** → verworfen (siehe Quelle).
- Weitere View-Typen, Drag-Reorder im Editor → Later-Items nach v1. (**Shortcuts: in v1**, inkl. Kollisionsauflösung — Entscheidung 30.05.)
- **Life-OS-Cockpit** (Projekte/Tasks/Ziele/Telos) → **nicht hier**. Separates Produkt **Lokyy OS** = Hermes-basiertes Dashboard, an Lokyy Brain angebunden (Lokyy Brain + Hermes-Dashboard = Lokyy OS). Das Epic-11-Dashboard bleibt Vault-/Wissens-fokussiert.

## Reihenfolge-Empfehlung

`11.1` → (`11.4` ∥ Architect-Sign-off) → `11.3` → `11.2` → (`11.5` ∥ `11.6` ∥ `11.7`) → `11.8`.
Shell-UX (Welle 5): `11.9` nach `11.3` parallel möglich; **`11.10`+`11.11` als ein Paket** ausliefern (Home + Dashboard zusammen — Entscheidung 30.05.).
Parallelisierbar: Welle-3-Stories (disjunkte Files), und `11.6` (reiner Vault-Seed) jederzeit.

## Definition of Done (Epic)

`pnpm -r build` grün · pro Story AC erfüllt + QA-Sign-off · Architektur-Entscheidungen oben vom Architect
bestätigt · `.env.example` aktualisiert wo nötig · UI-Stories mit Interceptor-Screenshot verifiziert ·
Menü-Config überlebt Reload + Geräte-Sync (liegt im Vault) · Skill-Creator erzeugt eine `list_skills`-sichtbare,
SPEC-valide Skill-Note · Share-Target nimmt ein geteiltes YouTube-Video als Inbox-Item auf (kein Roh-JSON).
