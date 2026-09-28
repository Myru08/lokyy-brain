#!/usr/bin/env bash
# scripts/test-fresh-db.sh — smoke-test the full migration chain on a fresh DB.
#
# Spins up a throwaway ParadeDB container, runs every migration via
# packages/core's runMigrations(), then asserts that every migration in the
# registry appears in the _lokyy_migrations tracking table.
#
# The expectation is DERIVED from the registry (MIGRATIONS in
# packages/core/src/db/migrations/index.ts), never hardcoded — issue #68: the
# hardcoded `EXPECTED=15` / `0014_note_search_forgotten` had been failing since
# migration 0015 without anyone noticing, and a check that is always red checks
# nothing. Same idea as the DOC_TYPES ↔ base.json drift guard: the one truth is
# the code, not a number next to it.
#
# Why the registry and not the filenames under migrations/: a file that exists
# but was never wired into MIGRATIONS is not a migration — it never runs. The
# registry is what runMigrations() executes, so it is the only expectation that
# can actually be violated. Reading it requires a build, and that is not a new
# precondition: the script already builds @lokyy/core below, before migrating,
# so the dist it reads cannot be stale. If the read fails or comes back empty,
# the script exits 2 (setup failed) rather than silently comparing against a
# stale or absent number.
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

# Derive the expectation from the registry we just built. MIGRATIONS is not
# re-exported from packages/core's index, so we read the module directly.
REGISTRY_JS="./packages/core/dist/db/migrations/index.js"
if [ ! -f "${REGISTRY_JS}" ]; then
  echo "[smoketest] SETUP FAIL — ${REGISTRY_JS} missing after the core build."
  echo "[smoketest]   Cannot derive the expected migration count. Refusing to"
  echo "[smoketest]   compare against a guessed number."
  exit 2
fi

DERIVED=$(node --input-type=module -e "
import { MIGRATIONS } from '${REGISTRY_JS}';
if (!Array.isArray(MIGRATIONS) || MIGRATIONS.length === 0) {
  console.error('MIGRATIONS is not a non-empty array');
  process.exit(1);
}
console.log(MIGRATIONS.length);
console.log(MIGRATIONS[MIGRATIONS.length - 1].name);
") || {
  echo "[smoketest] SETUP FAIL — could not read MIGRATIONS from ${REGISTRY_JS}"
  exit 2
}

EXPECTED=$(printf '%s\n' "${DERIVED}" | sed -n '1p')
EXPECTED_LAST=$(printf '%s\n' "${DERIVED}" | sed -n '2p')

case "${EXPECTED}" in
  ''|*[!0-9]*)
    echo "[smoketest] SETUP FAIL — derived count is not a number: '${EXPECTED}'"
    exit 2
    ;;
esac
if [ -z "${EXPECTED_LAST}" ]; then
  echo "[smoketest] SETUP FAIL — derived last migration name is empty"
  exit 2
fi

echo "[smoketest] expectation from registry: ${EXPECTED} migrations, last = ${EXPECTED_LAST}"

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

if [ "${COUNT}" != "${EXPECTED}" ]; then
  echo "[smoketest] FAIL — expected ${EXPECTED} migrations (registry), found ${COUNT}"
  exit 1
fi

# The registry's last entry and the DB's lexicographically-highest name have to
# agree. They do as long as the registry stays in numeric-prefix order, which is
# also the order runMigrations() applies. A mismatch here therefore means either
# a missing migration or a registry that fell out of order — both worth failing.
if [ "${LAST}" != "${EXPECTED_LAST}" ]; then
  echo "[smoketest] FAIL — expected last migration ${EXPECTED_LAST} (registry), got ${LAST}"
  exit 1
fi

echo "[smoketest] OK — ${COUNT} migrations applied, last = ${LAST}"
