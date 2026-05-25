# Story 1.8: Drizzle Schema + Auto-Migrations at Startup

Status: done

## Story

As an admin,
I want the server to apply the database schema automatically when it boots against a fresh Postgres,
so that there is no manual migration step in the installation path.

## Acceptance Criteria

1. Drizzle schema files in `packages/core/src/db/schema/` define: `users`, `vaults`, `vault_memberships`, `sessions`, `note_embeddings`, `system_config`.
2. `note_embeddings.embedding` is `vector(768)` with an HNSW index using `vector_cosine_ops`, `m=16`, `ef_construction=64`.
3. ULID columns are stored as `TEXT`.
4. SQL migrations live in `packages/core/src/db/migrations/`, generated via `drizzle-kit generate`.
5. `runMigrations(databaseUrl)` exported from `@lokyy/core` applies pending migrations and logs each.
6. Server `main()` calls `runMigrations(config.databaseUrl)` before `serve()`.
7. A second start with same DB is a no-op (Drizzle's migration journal handles idempotency).
8. Server start fails fast with a clear error if the DB is unreachable.
9. `pnpm -r build` exits 0; against `postgresql://postgres:lokyy@localhost:5439/lokyy_brain` (pgvector-enabled), boot creates the 6 tables.
10. Playwright PWA still loads, no new console errors.

## Tasks

- [ ] Add deps: drizzle-orm, drizzle-kit, postgres-js.
- [ ] Schema files (1 per table).
- [ ] drizzle.config.ts at workspace root or core.
- [ ] Generate initial migration SQL.
- [ ] runMigrations + db client wrapper.
- [ ] Server config gains `databaseUrl` from env.
- [ ] Server main() applies migrations.
- [ ] Verify against running pgvector DB.

## Dev Notes

- Use `postgres-js` (postgres) over `pg` — better Drizzle integration, smaller dep.
- pgvector column type: Drizzle 0.30+ has `vector` helper via `pgvector`-aware imports OR custom-define via `customType`. Custom-define is safer/portable.
- HNSW index: Drizzle doesn't have first-class HNSW yet. Emit raw SQL via `sql.raw` in the migration's manual portion, OR write the migration SQL by hand. For Story 1.8, generate the base migration with drizzle-kit then hand-edit to add the HNSW + extension creation.
- Add `CREATE EXTENSION IF NOT EXISTS vector;` to the first migration so a fresh DB self-extends.

## Dev Agent Record
