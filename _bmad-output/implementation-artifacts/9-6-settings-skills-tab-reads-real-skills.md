# Story 9.6: Settings → Skills-Tab liest echte Vault-Skills

Status: backlog

> Abhängigkeit: **9-2** (`listSkillNotes` in core).

## Story

Als User
möchte ich, dass der Settings → Skills-Tab die Skills zeigt, die tatsächlich in meinem Vault liegen (mit Link zum Bearbeiten),
damit der Tab die Realität widerspiegelt statt einer hardcoded Liste und ich Skills als Daten verwalten kann.

## Acceptance Criteria

1. `GET /api/admin/skills` (aktuell hardcoded Array bei `server/src/routes/admin.ts:505`) wird durch einen Read der `type: skill`-Notes aus dem Vault via `@lokyy/core` `listSkillNotes` ersetzt.
2. Jeder zurückgegebene Skill enthält: `skill_name`, `title`, `description`, `allowed_tools` und den Note-Pfad (für den Editor-Link).
3. Der Settings-Skills-Tab (`pwa/src/Settings.tsx`, `tab === "skills"`) rendert eine Karte pro echtem Skill: Title, Description, `skill_name`, `allowed_tools`, einen "im Editor öffnen"-Link (öffnet die Note im CM6-Editor) und einen "wie aufrufen"-Hinweis (z.B. `Sag zu Claude: run_skill wochenrueckblick`).
4. Eine Skill-Note im Editor bearbeiten und den Settings-Tab neu laden → die Änderung erscheint (kein Redeploy).
5. Das alte hardcoded PAI/Claude-Code-Skill-Array ist entfernt (es zeigte auf fremde Built-ins — Architektur "Problem").
6. Verifiziert via Interceptor: Settings → Skills zeigt die 4 Seed-Skills; "im Editor öffnen" navigiert zur Note; nach Bearbeiten der `description` eines Skills + Speichern zeigt der Tab den neuen Text.
7. `pnpm -r build` grün; keine neuen Console-Errors.
8. **Anti:** die bestehende `bonus-skills-howto-section`-Copy-Button-UX wird bewahrt/adaptiert, nicht komplett gelöscht — Karten-Layout wo passend wiederverwenden.

## Tasks / Subtasks

- [ ] Admin-Route auf `listSkillNotes` umstellen, hardcoded Array entfernen
- [ ] `Settings.tsx` Skills-Karten + Editor-Link + howto-Hinweis
- [ ] Editor-Open-Mechanismus anbinden (per Pfad/id)
- [ ] Interceptor-Verifikation gemäß AC#6
- [ ] Build grün, keine neuen Console-Errors

## Dev Notes

- `bonus-skills-howto-section` (sprint-status) hat bereits eine Per-Skill howTo/examplePrompt/worksWith-Karte mit Copy-Buttons gebaut — diese Komponente auf echte Skills adaptieren statt neu bauen (AC#8).
- Der "im Editor öffnen"-Link sollte den bestehenden Note-Open-Mechanismus nutzen (Tabs/Command-Palette open by path/id).
- Server-Route: bestehende `/api/admin/*`-Handler in `admin.ts` für Response-Pattern + Auth ansehen.

### References

- [Source: skills-prd-phase1.md — Story S6]
- [Source: skills-architecture.md — "Verweise" (admin.ts:505, Settings.tsx)]
- [Source: sprint-status.yaml — `bonus-skills-howto-section`]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

### Change Log
