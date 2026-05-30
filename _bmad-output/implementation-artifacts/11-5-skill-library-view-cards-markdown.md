# Story 11.5: Skill-Library-View (`viewType: skills`)

Status: ready-for-dev

> **Welle 3.** **Agent F** (`pwa/src/sidebar/views/SkillsView.tsx` — neu, erfüllt den 11.4-Lazy-Stub).
> Architektur: Addendum §2.

## Story

Als Nutzer möchte ich meine Skills (`70_pai/skills/`) als ansprechend gerenderte Bibliothek sehen —
Karten mit Markdown-Vorschau und Verschachtelung, ähnlich der Claude Desktop App — statt als nackte Dateiliste.

## Acceptance Criteria

1. `SkillsView.tsx` implementiert `ViewRenderer` (`ViewProps` aus 11.4) und ersetzt den „Coming soon"-Stub für `skills`.
2. Listet die Skills aus dem fixen System-Menüpunkt-Ordner (`70_pai/skills/`, `item.folder`): **Karten** mit Titel,
   Beschreibung, `allowed_tools`, Markdown-Vorschau; Verschachtelung/Gruppierung sichtbar.
3. Datenquelle: bestehende Skill-/Notes-Endpunkte (Skills sind `type: skill`-Notes; Reuse vorhandener `list_skills`-naher
   Server-/Notes-Pfade — **HTTP**, kein MCP-Client in der PWA, Addendum §0).
4. Klick auf eine Skill-Karte öffnet die Skill-Note (`onOpenNote`); „Ausführen/run"-Affordance optional v1.
5. Lazy geladen (kein Boot-Pfad). `pnpm -r build` grün; Interceptor-Screenshot der Kartenansicht.
6. **Anti:** keine Registry-Änderung (gehört 11.4); kein eigener Routing-/State-Wildwuchs — nutzt `ViewProps`.

## Dev Notes
- Skills = `type: skill`-Notes unter `70_pai/skills/` (Epic 9 / `list_skills`). PWA ruft die HTTP-Route, nicht MCP.
- Visuelles Vorbild: Claude Desktop Skill-Darstellung (Karten + Markdown). Addendum §2 (ViewProps).

### References
- [Source: epic-11-architecture-addendum.md §2; epic-11-lokyy-workspace.md Story 11.5; Epic 9 (Skills)]

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### File List
### Change Log
