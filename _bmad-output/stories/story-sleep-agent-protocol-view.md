# Story: Nacht-Protokoll-Ansicht (Sleep-Agent-Runs) in der PWA

> **Tracking issue:** https://github.com/oliverhees/lokyy-brain-dev/issues/22

## Kontext

Der nächtliche Sleep-Agent protokolliert jeden Lauf vollständig (`/api/sleep-agent/runs`, server/src/routes/sleep-agent.ts — fertig). Es gibt aber keine Anzeige: „Bei dir läuft nachts ein Roboter über deinen Vault. Du erfährst nie davon." Reine Anzeige-Story.

## Scope / File-Set (dieser Agent besitzt exklusiv)

- `pwa/src/SleepAgentProtocol.tsx` (NEU) + Unterkomponenten in NEUEN Dateien
- `pwa/src/api.ts`: NUR additive Funktion `fetchSleepAgentRuns()` ans Dateiende (kollisionsarm; falls Konfliktgefahr, eigene Datei `pwa/src/api.sleepAgent.ts`)
- Tests (vitest) für Datenaufbereitung
- NICHT editieren: `App.tsx`, View-Registry-Wiring (als WIRING-TODO ausweisen), keine Server-Änderungen

## Acceptance Criteria

1. **AC1:** View listet Läufe (neueste zuerst): Zeitpunkt, Dauer, was getan wurde (Aktionen/Kategorien), Anzahl + Liste berührter Notizen (Klick = Notiz öffnen via bestehendem Öffnen-Mechanismus als Callback-Prop).
2. **AC2:** Leerzustand („Noch kein Lauf protokolliert") und Fehlerzustand (API down) sind gestaltet, kein weißer Screen.
3. **AC3:** Nicht-technische Sprache im UI (Zielgruppe ohne Programmierhintergrund), Deutsch.
4. **AC4:** `pnpm --filter pwa build` + `tsc --noEmit` + Tests grün.
5. **AC5:** WIRING-TODO im Abschlussbericht: exakte Registrierungszeile für die View-Registry (Epic 11 View-Type-Registry existiert).

## Nicht-Ziele

Keine Änderungen am Sleep-Agent selbst, keine neuen API-Endpunkte.
