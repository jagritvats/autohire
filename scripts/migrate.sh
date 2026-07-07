#!/usr/bin/env bash
# Apply DB migrations against DATABASE_URL in your .env (forward-only, idempotent).
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm --filter @jobflow/db migrate
