#!/usr/bin/env bash
# scripts/test-fresh-db.sh — smoke-test the full migration chain on a fresh DB.
#
# Spins up a throwaway ParadeDB container, runs every migration via
# packages/core's runMigrations(), then asserts that all 15 expected names
# (0000…0014) appear in the _lokyy_migrations tracking table.
#
# Exit codes: 0 = green, 1 = migration failed, 2 = setup failed.
#
# Requires: docker, pnpm. Run from the repo root.

set -euo pipefail

CONTAINER="lokyy-migrations-smoketest"
DB_NAME="lokyy_brain_smoketest"
DB_PASS="smoketest_$(date +%s)"
DB_PORT="5499"

cleanup() {
  echo "[smoketest] cleaning up container ${CONTAINER}"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[smoketest] starting throwaway ParadeDB on :${DB_PORT}"
docker run -d --rm \
  --name "${CONTAINER}" \
  -e POSTGRES_PASSWORD="${DB_PASS}" \
  -e POSTGRES_DB="${DB_NAME}" \
  -p "${DB_PORT}:5432" \
  paradedb/paradedb:latest >/dev/null

echo "[smoketest] waiting for postgres ready (with auth probe)"
READY=0
for i in $(seq 1 60); do
  if docker exec "${CONTAINER}" pg_isready -U postgres -d "${DB_NAME}" >/dev/null 2>&1 && \
     docker exec -e PGPASSWORD="${DB_PASS}" "${CONTAINER}" \
        psql -U postgres -d "${DB_NAME}" -h 127.0.0.1 -c "SELECT 1" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [ "${READY}" != "1" ]; then
  echo "[smoketest] postgres failed to come up"
  exit 2
fi

# extra grace for paradedb extension preload to settle
sleep 2

DSN="postgres://postgres:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}"
export DATABASE_URL="${DSN}"

echo "[smoketest] running pnpm -r build (so packages/core/dist exists)"
pnpm --filter @lokyy/core build >/dev/null

echo "[smoketest] running migrations"
node --input-type=module -e "
import { runMigrations, closeDb } from './packages/core/dist/index.js';
const r = await runMigrations(process.env.DATABASE_URL);
console.log('applied =', r.applied.length, 'alreadyApplied =', r.alreadyApplied.length);
console.log('names    =', r.applied.join(', '));
await closeDb();
"

echo "[smoketest] verifying _lokyy_migrations table"
COUNT=$(docker exec "${CONTAINER}" psql -U postgres -d "${DB_NAME}" -At \
  -c "SELECT COUNT(*) FROM _lokyy_migrations;")
LAST=$(docker exec "${CONTAINER}" psql -U postgres -d "${DB_NAME}" -At \
  -c "SELECT name FROM _lokyy_migrations ORDER BY name DESC LIMIT 1;")

EXPECTED=15
if [ "${COUNT}" != "${EXPECTED}" ]; then
  echo "[smoketest] FAIL — expected ${EXPECTED} migrations, found ${COUNT}"
  exit 1
fi

if [ "${LAST}" != "0014_note_search_forgotten" ]; then
  echo "[smoketest] FAIL — expected last migration 0014_note_search_forgotten, got ${LAST}"
  exit 1
fi

echo "[smoketest] OK — ${COUNT} migrations applied, last = ${LAST}"
