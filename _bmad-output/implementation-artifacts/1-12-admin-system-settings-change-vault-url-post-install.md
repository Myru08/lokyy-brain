# Story 1.12: Admin System Settings (extended per user)

Status: done

## ACs (extended) — all met
1. ✅ Settings page at `/settings` (modal-style via SettingsIcon button in header).
2. ✅ Vault URL change with backend connection-test before save.
3. ✅ MCP-Anbindung section with Copy-buttons for binary path + Claude Desktop JSON snippet (forward-looking template — Epic 7 will fill the real binary).
4. ✅ Skills section listing 4 PAI integrations (Knowledge, Telos, ZK Steward, Research) with install hints.
5. ✅ Live system status — Forgejo / Postgres+pgvector / Ollama indicators (green/red dot + detail text + Reload button).
6. ✅ Build green; Playwright screenshot confirms all 4 sections render correctly.
7. ✅ Backend endpoints: GET /api/admin/system-settings, PUT /api/admin/system-settings/vault-url, GET /api/admin/status, GET /api/admin/mcp-info, GET /api/admin/skills.

## Files
**New:** `server/src/routes/admin.ts`, `pwa/src/Settings.tsx`
**Modified:** `server/src/index.ts` (mount adminRoutes), `server/package.json` (+drizzle-orm), `pwa/src/App.tsx` (Settings icon + state + conditional render)
