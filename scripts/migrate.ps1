#!/usr/bin/env pwsh
# Apply DB migrations against DATABASE_URL in your .env (forward-only, idempotent).
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
pnpm --filter @jobflow/db migrate
