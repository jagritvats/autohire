#!/usr/bin/env pwsh
# Local (no-Docker) dev: install, migrate if a DB is configured, then run the
# control plane (web) + cloud worker together. Ctrl-C stops the web process.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path .env)) { Write-Host "creating .env from .env.example"; Copy-Item .env.example .env }
pnpm install

if (Select-String -Path .env -Pattern '^DATABASE_URL=.+' -Quiet) {
  Write-Host "applying migrations..."
  pnpm --filter @jobflow/db migrate
  if ($LASTEXITCODE -ne 0) { Write-Host "migrate failed (is the DB up?) - continuing" }
} else {
  Write-Host "no DATABASE_URL set - running with the in-memory repo (not durable)"
}

Write-Host "starting worker (background) + web..."
$worker = Start-Process pnpm -ArgumentList "--filter","@jobflow/worker","runner" -PassThru -NoNewWindow
try { pnpm --filter @jobflow/web dev } finally { Stop-Process -Id $worker.Id -ErrorAction SilentlyContinue }
