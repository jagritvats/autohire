#!/usr/bin/env bash
# Local (no-Docker) dev: install, migrate if a DB is configured, then run the
# control plane (web) + cloud worker together. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "• creating .env from .env.example"; cp .env.example .env; }
pnpm install

if grep -Eq '^DATABASE_URL=.+' .env; then
  echo "▶ applying migrations…"
  pnpm --filter @jobflow/db migrate || echo "⚠ migrate failed (is the DB up?) — continuing in whatever mode"
else
  echo "• no DATABASE_URL set — running with the in-memory repo (not durable)"
fi

echo "▶ starting worker + web (Ctrl-C to stop both)…"
pnpm --filter @jobflow/worker runner &
WORKER=$!
trap 'kill "$WORKER" 2>/dev/null || true' EXIT
pnpm --filter @jobflow/web dev
