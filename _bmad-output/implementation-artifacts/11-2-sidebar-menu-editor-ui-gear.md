# Story 11.2: Zahnrad-Editor für Menüpunkte (inkl. Shortcuts)

Status: ready-for-dev

> **Welle 2.** **Agent E** (`pwa/src/sidebar/MenuEditor.tsx`, `pwa/src/sidebar/IconPicker.tsx` — beide neu).
> Persistiert über `api.putMenu()` (11.1). Architektur: Addendum §1, §3.

## Story

Als Nutzer möchte ich über ein Zahnrad-Steuerelement eigene Menüpunkte anlegen, bearbeiten und löschen,
damit ich meine Seitenleiste selbst zusammenstellen kann.

## Acceptance Criteria

1. Zahnrad oben in der Seitenleiste öffnet `MenuEditor`. Custom-Menüpunkt anlegen/bearbeiten/löschen mit Feldern:
   **Label, Icon (Picker), Ordner (Picker), View-Typ** (`tree`/`skills`/`dashboard`), **Shortcut**.
2. **Shortcuts in v1 (Entscheidung 30.05.):** Shortcut-Feld ist vorhanden; beim Vergeben wird gegen bestehende
   Keybindings (Command-Palette/CM6) **kollisionsgeprüft** — Konflikt wird klar angezeigt und blockiert das Speichern,
   bis aufgelöst. Empfehlung: zentrale Keybinding-Registry (Addendum §7 / Arch-Punkt 4).
3. `IconPicker.tsx` bietet eine **geschlossene Liste** von lucide-react-Icon-Namen (Name wird in `MenuItem.icon` gespeichert).
4. Ordner-Picker nutzt den vorhandenen Vault-Tree; gespeicherter Wert ist ein vault-relativer Pfad (`""` = Root).
5. **System-Items read-only:** im Editor nicht editier-/löschbar.
6. Speichern → `api.putMenu(items)` (Server verwirft `kind:"system"`, 11.1). Neue IDs sind ULIDs.
7. **Anti:** kein direktes Schreiben der YAML aus der PWA; nur über die Route. `pnpm -r build` grün; Interceptor-Screenshot.

## Dev Notes
- `putMenu` persistiert nur Custom (System wird serverseitig gefiltert, Addendum §3). ULID-Generierung serverseitig oder
  via vorhandenem Helper.
- Shortcut-Kollisionsprüfung: bestehende Keybindings einsammeln (Command-Palette, CM6-Keymap). Addendum §7 Arch-Punkt 4.

### References
- [Source: epic-11-architecture-addendum.md §1, §3, §7; epic-11-lokyy-workspace.md Story 11.2; Entscheidung 30.05. (Shortcuts in v1)]

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### File List
### Change Log
