param([Parameter(Mandatory=$true)][string]$BackupFile)
$ErrorActionPreference = 'Stop'
$resolved = Resolve-Path -LiteralPath $BackupFile
Get-Content -LiteralPath $resolved -AsByteStream | docker compose exec -T postgres pg_restore -U ucli -d ucli --clean --if-exists
Write-Output "Backup restored: $resolved"
