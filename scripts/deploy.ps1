param(
  [int]$GrafanaPort = 3004,
  [string]$ProjectName = 'ucli-prod',
  [switch]$BuildOnly,
  [switch]$UpOnly
)
<#
UCLI Server 私有化部署脚本
用法:
  powershell -File scripts/deploy.ps1                     # 构建 + 启动
  powershell -File scripts/deploy.ps1 -UpOnly             # 跳过构建直接启动
  powershell -File scripts/deploy.ps1 -BuildOnly          # 只构建镜像
默认 GRAFANA_PORT=3004（避开本地 dev 的 3002），可用 -GrafanaPort 覆盖。
#>
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

# 1) 校验 .env 与必需变量
if (-not (Test-Path .env)) { throw '缺少 .env —— 请先 Copy-Item .env.example .env 并填写' }
$required = @('JWT_SECRET', 'SETUP_SECRET', 'MASTER_KEY')
$missing = @()
foreach ($name in $required) {
  $line = Get-Content .env | Where-Object { $_ -match "^$name=.+" }
  if (-not $line) { $missing += $name }
}
if ($missing.Count) { throw "缺少必需环境变量: $($missing -join ', ')（.env 中）" }
Write-Host "[1/4] .env 检查通过" -ForegroundColor Green

# 2) 端口 80 检查
$port80 = Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue
if ($port80) { Write-Warning "端口 80 已被占用(PID $($port80[0].OwningProcess))，管理后台可能无法通过 http://localhost 访问" }
Write-Host "[2/4] 构建镜像" -ForegroundColor Green
if (-not $UpOnly) {
  docker compose -p $ProjectName build
  if ($LASTEXITCODE -ne 0) { throw '镜像构建失败' }
} else { Write-Host "  跳过构建（-UpOnly）" -ForegroundColor Yellow }

# 3) 启动生产栈
if (-not $BuildOnly) {
  Write-Host "[3/4] 启动生产栈 ($ProjectName，Grafana 端口 $GrafanaPort)" -ForegroundColor Green
  $env:GRAFANA_PORT = "$GrafanaPort"
  docker compose -p $ProjectName up -d
  Remove-Item Env:GRAFANA_PORT -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) { throw '启动失败' }

  # 4) 等待 api/gateway 健康
  Write-Host "[4/4] 等待 api/gateway 健康…" -ForegroundColor Green
  $deadline = (Get-Date).AddSeconds(120)
  $healthy = $false
  while ((Get-Date) -lt $deadline) {
    $ps = docker compose -p $ProjectName ps --format '{{.Name}}\t{{.Status}}' 2>$null
    if ($ps -match "$ProjectName-api-1.*\(healthy\)" -and $ps -match "$ProjectName-gateway-1.*\(healthy\)") { $healthy = $true; break }
    Start-Sleep -Seconds 5
  }
  if ($healthy) {
    Write-Host "  api/gateway 已健康 ✓" -ForegroundColor Green
  } else {
    Write-Warning 'api/gateway 未在 120s 内 healthy，请 docker compose -p ucli-prod ps 检查'
  }

  # 初始化状态检测（查生产库账号数）
  $accounts = docker exec "$ProjectName-postgres-1" psql -U ucli -d ucli -tAc 'SELECT COUNT(*) FROM accounts' 2>$null
  $count = 0
  if ($accounts) { [void][int]::TryParse(($accounts -split "`n" | Select-Object -First 1).Trim(), [ref]$count) }
  if ($count -gt 0) {
    Write-Host "  平台已初始化（$count 个账号）✓" -ForegroundColor Green
  } else {
    Write-Host "  平台未初始化 → 请调用 POST /api/v1/auth/setup（带 X-UCLI-Setup-Secret 头）创建管理员" -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "部署完成：管理后台 http://localhost  |  Grafana http://localhost:$GrafanaPort" -ForegroundColor Green
} else {
  Write-Host "[3/4] 仅构建（-BuildOnly），跳过启动" -ForegroundColor Yellow
}
