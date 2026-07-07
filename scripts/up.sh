#!/usr/bin/env bash
# Build + start the whole stack (db + migrate + web + worker) in containers.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "▶ Building + starting JobFlow (db + migrate + web + worker)…"
docker compose up -d --build
echo "✓ Up.  web → http://localhost:3000   ·   db → localhost:5433"
echo "  logs:  docker compose logs -f web worker     stop:  ./scripts/down.sh"
echo "  local agent (Tier-3) stays on your machine:  pnpm agent"
