#!/usr/bin/env bash
# Local (no-Docker) dev: install, migrate ONLY if a database is configured AND
# reachable, then run the control plane (web) + cloud worker together. Ctrl-C stops both.
# No Postgres needed: with DATABASE_URL blank the default store is used (see .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "• creating .env from .env.example"; cp .env.example .env; }
pnpm install

set +e
DB_STATE=$(node scripts/db-reachable.mjs)
DB_CODE=$?
set -e
case "$DB_CODE" in
  0)
    echo "▶ database ${DB_STATE} — applying migrations…"
    pnpm --filter @jobflow/db migrate || echo "⚠ migrate failed — check DATABASE_URL; continuing"
    ;;
  1)
    echo "• no DATABASE_URL — using the default local store (set JOBFLOW_STORE / DATABASE_URL in .env for durability)"
    ;;
  *)
    echo "⚠ DATABASE_URL is set but ${DB_STATE}."
    echo "  Start it (Docker's Postgres: \`docker compose up -d db\` → localhost:5433) or blank DATABASE_URL in .env."
    echo "  Skipping migrations; the app will fail to reach the DB until it is up."
    ;;
esac

echo "▶ starting worker + web (Ctrl-C to stop both)…"
pnpm --filter @jobflow/worker runner &
WORKER=$!
trap 'kill "$WORKER" 2>/dev/null || true' EXIT
pnpm --filter @jobflow/web dev
