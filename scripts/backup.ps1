param([string]$OutputDirectory = ".\backups")
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
docker compose exec -T postgres pg_dump -U ucli -Fc ucli > (Join-Path $OutputDirectory "ucli-$stamp.dump")
Write-Output "Backup created: $(Join-Path $OutputDirectory "ucli-$stamp.dump")"
