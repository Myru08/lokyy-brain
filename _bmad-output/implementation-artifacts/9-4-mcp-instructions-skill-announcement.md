# Story 9.4: MCP-`instructions` Skill-Ankündigung

Status: backlog

> Abhängigkeit: **9-3** (Tools müssen existieren, bevor man sie ankündigt).

## Story

Als KI-Agent, der die MCP-Verbindung initialisiert,
möchte ich, dass die Server-`instructions` mir mitteilen, dass Skills existieren und wie ich sie nutze,
damit ich Skills entdecke und ausführe, ohne dass der User den Mechanismus erklären muss.

## Acceptance Criteria

1. Der `instructions`-String des MCP-Servers (zur initialize-Zeit) erhält einen Skills-Absatz: Skills sind wiederverwendbare Workflows; rufe `list_skills` um sie zu sehen, dann `run_skill`, dann führe den zurückgegebenen Prompt mit den gelisteten Tools aus.
2. Der Text nennt die zwei Tools wörtlich (`list_skills`, `run_skill`) und stellt klar, dass die KI selbst den zurückgegebenen Prompt ausführt (client-Execution).
3. Verifiziert: das `initialize`-Response-Feld `instructions` enthält die Skill-Anleitung (stdio-Capture).
4. `pnpm --filter @lokyy/mcp build` grün.
5. **Anti:** keine Verhaltens-/Tool-Änderung — reine Text-Ergänzung an bestehenden `instructions`.

## Tasks / Subtasks

- [ ] `instructions`-String lokalisieren (in Story 7.1 Bootstrap gesetzt)
- [ ] Skills-Absatz ergänzen (bestehenden Inhalt behalten)
- [ ] via initialize-Capture verifizieren
- [ ] Build grün

## Dev Notes

- Das `instructions`-Feld wird dort gesetzt, wo der MCP-Server konstruiert wird (Story 7.1 `@lokyy/mcp`-Bootstrap). Bestehenden Inhalt behalten; anhängen.
- Sprache an den Ton der bestehenden `instructions` anpassen — prüfen, was 7.1 verwendet hat, und konsistent bleiben.

### References

- [Source: skills-prd-phase1.md — Story S4]
- [Source: skills-architecture.md — "Discoverability"]
- [Source: Story 7.1 — `@lokyy/mcp`-Workspace-Bootstrap]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

### Change Log
