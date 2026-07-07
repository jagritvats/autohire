#!/usr/bin/env pwsh
# Stop the stack. Pass --volumes to also drop the database volume.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
docker compose down @args
Write-Host "Stopped."
