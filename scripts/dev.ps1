#!/usr/bin/env pwsh
# Local (no-Docker) dev: install, migrate ONLY if a database is configured AND
# reachable, then run the control plane (web) + cloud worker together. Ctrl-C stops the web process.
# No Postgres needed: with DATABASE_URL blank the default store is used (see .env.example).
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path .env)) { Write-Host "creating .env from .env.example"; Copy-Item .env.example .env }
pnpm install

$dbState = node scripts/db-reachable.mjs
$dbCode = $LASTEXITCODE
if ($dbCode -eq 0) {
  Write-Host "database $dbState - applying migrations..."
  pnpm --filter @jobflow/db migrate
  if ($LASTEXITCODE -ne 0) { Write-Host "migrate failed - check DATABASE_URL; continuing" }
} elseif ($dbCode -eq 1) {
  Write-Host "no DATABASE_URL - using your local store (~/.jobflow, shared with the jobflow CLI; saved across restarts)"
} else {
  Write-Host "DATABASE_URL is set but $dbState."
  Write-Host "  Start it (Docker's Postgres: 'docker compose up -d db' -> localhost:5433) or blank DATABASE_URL in .env."
  Write-Host "  Skipping migrations; the app will fail to reach the DB until it is up."
}

if ($dbCode -eq 1) {
  # the local store takes one writer at a time - the web app runs the sync schedule itself
  Write-Host "starting web (it keeps your feed synced while open)..."
  pnpm --filter @jobflow/web dev
  exit $LASTEXITCODE
}
Write-Host "starting worker (background) + web..."
$worker = Start-Process pnpm -ArgumentList "--filter","@jobflow/worker","runner" -PassThru -NoNewWindow
try { pnpm --filter @jobflow/web dev } finally { Stop-Process -Id $worker.Id -ErrorAction SilentlyContinue }
