# Story 11.7: Open-Skill — Format-Doku + modell-agnostische MCP-Exposition

Status: ready-for-dev

> **Welle 3 — parallel.** **Agent H** (Doku + `mcp/`-Verifikation, kein Schema-Bruch).
> Read-/Verify-lastig; bestätigt das bereits Gebaute (Epic 9/7).

## Story

Als Nutzer möchte ich, dass meine Skills modell-agnostisch von jeder MCP-fähigen KI (Claude, ChatGPT, Gemini)
ausführbar sind, damit Lokyy ein offener, zentraler Skill-Store ist — kein proprietäres Format.

## Acceptance Criteria

1. **Doku** (Markdown unter `_bmad-output/` bzw. README-Abschnitt): beschreibt das offene Skill-Format
   (SKILL-artiges Markdown + Frontmatter) und wie eine externe MCP-fähige KI Skills über `list_skills`/`run_skill` zieht
   und feuert.
2. **Verifikation (kein Neu-Bau):** belegt, dass `list_skills`/`run_skill` (Epic 9) und der MCP-HTTP-Transport
   (`bonus-mcp-http-transport`) Skills bereits modell-agnostisch ausliefern; `{{var}}`-Rendering + `input_schema`-Validierung
   funktionieren. Lücken werden als Findings dokumentiert, nicht stillschweigend „gefixt".
3. **Format bleibt offen:** keine Einführung eines proprietären Schemas; bestätigt, dass das vorhandene Frontmatter-Format
   portabel ist.
4. Optionaler Export (Skill als portable Datei) nur als dokumentierter Vorschlag, nicht v1-Pflicht.
5. **Anti:** kein Schema-Bruch an `mcp/`; keine Produktionscode-Änderung ohne separate Story.

## Dev Notes
- MCP ist der gemeinsame Nenner (PWA hat keinen MCP-Client; externe KIs schon — Addendum §0). `run_skill`-Rendering
  existiert (Story 10.5/Epic 9). HTTP-Transport: `bonus-mcp-http-transport` (Settings: stdio/npx/HTTP).

### References
- [Source: epic-11-lokyy-workspace.md Story 11.7; Epic 9, Epic 7; 90_ideas/dynamische-seitenleisten-menuepunkte (Open-Skill)]

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### File List
### Change Log
