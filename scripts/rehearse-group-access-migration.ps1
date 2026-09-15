param(
  [string]$TestDatabaseUrl = $env:TEST_DATABASE_URL,
  [Parameter(Mandatory = $true)][string]$OrganizationId,
  [string]$ActorId,
  [string]$MappingPath,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not $TestDatabaseUrl) { throw 'Explicit local TEST_DATABASE_URL is required' }
$arguments = @('--import', 'tsx', (Join-Path $PSScriptRoot 'rehearse-group-access-migration.ts'), '--organization', $OrganizationId)
if ($ActorId) { $arguments += @('--actor', $ActorId) }
if ($MappingPath) { $arguments += @('--mapping', (Resolve-Path -LiteralPath $MappingPath).Path) }
if ($Apply) { $arguments += '--apply' }
$previousTestUrl = $env:TEST_DATABASE_URL
try {
  $env:TEST_DATABASE_URL = $TestDatabaseUrl
  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Group access rehearsal failed; no automatic retry or production fallback' }
} finally { $env:TEST_DATABASE_URL = $previousTestUrl }
