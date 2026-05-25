# Story 1.10: Setup-Mode Boot + /api/setup Endpoints

Status: done

## Acceptance Criteria — all met
1. ✅ Setup state persisted in `system_config.setup_complete` (boolean key/value row).
2. ✅ `/api/setup/{status,test-forgejo,test-postgres,test-ollama,admin,vault,complete}` all live.
3. ✅ Each test-* endpoint performs real connection check (git ls-remote, postgres SELECT, GET /api/tags).
4. ✅ Data routes (/api/notes, /api/vault, /api/graph, /api/pipes) return 503 `{error:"setup-required"}` while setup incomplete.
5. ✅ `/api/setup/complete` requires ≥1 admin user + ≥1 vault; idempotent.
6. ✅ End-to-end smoke verified:
   - DELETE system_config row → status returns `false`
   - vault tree returns 503
   - test-postgres returns `{ok:true, pgvectorAvailable:true}`
   - test-forgejo against bare remote returns `{ok:true}`
   - test-ollama returns `{ok:false}` (no Ollama running locally — expected)
   - POST /admin creates user (ULID returned)
   - POST /vault creates vault for that user
   - POST /complete returns `{setupComplete:true}`
   - vault tree returns `[]` (200)
7. ✅ Playwright PWA regression: same baseline.

## Files

**New:**
- `packages/core/src/setup/setupState.ts` (read/write/reset setup_complete)
- `server/src/routes/setup.ts` (7 endpoints)
- `server/src/middleware/setupGate.ts`

**Modified:**
- `packages/core/src/index.ts` (export setupState)
- `server/src/index.ts` (register setupRoutes, apply setupGate to data routes)
- `server/package.json` (added `postgres` dep for test-postgres handler)
- `pnpm-lock.yaml`

## Notes
- Admin password hashed with scrypt as interim (Epic 3 / Story 3.1 hardens to bcrypt).
- Setup endpoints intentionally NOT gated — they need to be reachable while setup_complete is false.
- Test-ollama is a heuristic (`hasNomicEmbed` flag) — wizard UI uses this to remind admin to run `ollama pull nomic-embed-text`.
