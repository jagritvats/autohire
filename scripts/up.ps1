#!/usr/bin/env pwsh
# Build + start the whole stack (db + migrate + web + worker) in containers.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
Write-Host "Building + starting JobFlow (db + migrate + web + worker)..."
docker compose up -d --build
Write-Host "Up.  web -> http://localhost:3000   .   db -> localhost:5433"
Write-Host "  logs:  docker compose logs -f web worker     stop:  ./scripts/down.ps1"
Write-Host "  local agent (Tier-3) stays on your machine:  pnpm agent"
