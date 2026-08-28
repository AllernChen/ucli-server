# UCLI 0.12 Client Live Integration Rerun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 UCLI 独立使用能力的前提下，使用一个新的单次设备授权完成 UCLI Client 0.12.0 与生产内网 UCLI Server 的 Preview、Redeem、Refresh、Bootstrap、模型流和 Skills 下载全链路联调。

**Architecture:** 服务端先通过无凭证探针和管理端检查建立联调硬门，再临时发布一个最小只读联调 Skill，并为上一轮 smoke 用户创建新的永久设备授权和 1 天有效的单次 URL。客户端只执行现有的隔离 smoke 测试；测试在临时数据库中完成同 installationId 幂等 Redeem、Refresh、模型代理和 Skill ZIP 哈希验证，最后由双方核对脱敏证据并禁用联调授权、撤销联调 Skill。

**Tech Stack:** UCLI Server（NestJS 11、Docker Compose、PostgreSQL、Vue 3 管理端）、UCLI Client 0.12.0（Node.js 22、Electron、安全存储抽象、Node test runner）、PowerShell 7。

## Global Constraints

- 服务端固定为公司内网单实例 `http://10.44.100.100`，本次允许 HTTP；不得把该信任扩展到公网、其他 IP 或重定向来源。
- 服务端基线固定为提交 `a65361df27d9566903a25120d16338f644d60608`，已部署 runtime 镜像固定为 `sha256:d351803a621daa5aa5ef77aab47d18b75402b8fa1e0b1b7405869a9b94cd405e`。
- 客户端目标版本固定为 `0.12.0`；UCLI 未注册服务端时必须继续独立可用，本方案不改变该行为。
- 协议固定为 Device Grant Link v1，不保留旧注册流程兼容。
- 一个设备授权只能绑定一个设备；一个用户可以拥有多个设备和多个设备授权。
- 设备授权有效期与 URL 有效期相互独立。本次设备授权选择“永久有效”，URL 选择“1 天”；客户端只持久化并提醒设备授权有效期，不使用 URL 有效期做授权提醒。
- URL 只允许首次绑定使用一次。首次 Redeem 后，仅同一 installationId 可在十分钟窗口内进行协议内幂等 Redeem；不同 installationId 不得复用已消费 URL。
- `test/server-integration-smoke.test.mjs` 每次启动都创建新的临时数据库和 installationId。因此一旦一次 smoke 已完成 Redeem，任何跨进程重跑都必须创建新的设备授权，不能复用已绑定授权或已消费 URL。
- Preview、Redeem、Refresh 的成功和错误 JSON 响应都必须带 `Cache-Control: no-store`；客户端继续 fail closed，不放宽校验。
- 服务端当前有 4 个可用公共模型，但没有已发布 Skill。完整 smoke 前必须发布本方案定义的联调 Skill。
- 联调 Skill 只用于 catalog、ZIP 下载和 SHA-256 边界验证；smoke 不把它安装到用户真实 Skill 目录，也不执行其内容。
- 完整 URL、URL fragment、link secret、access token、refresh token、本地代理 bearer、Authorization header、Cookie、登录密码和成功响应正文不得进入终端命令历史、日志、截图、工单、聊天群、提交或验收文档。
- 本方案生成阶段不创建 Skill、不创建授权、不访问管理员凭证、不修改生产数据。执行阶段的生产变更限于发布一个联调 Skill、创建一个新授权，以及联调结束后的撤销和禁用。

---

## Current Evidence

截至 2026-08-28（Asia/Shanghai）：

| 检查项 | 当前证据 |
| --- | --- |
| 服务端提交 | `a65361d` 已推送到 `origin/codex/device-grant-link-implementation` |
| 服务端部署 | API 与 Gateway healthy；`/healthz`、`/gateway/healthz`、`/connect` 均返回 HTTP 200 |
| Refresh 线上合同 | 无效占位 token 返回 HTTP 401、JSON、`Cache-Control: no-store`、稳定码 `invalid_grant` |
| 服务端回归 | 目标授权测试 64/64 通过；全量测试 555 通过，1 个环境 Nginx 测试跳过 |
| 客户端离线合同 | `server-contract-fixtures`、`server-device-grant-client`、`server-connection-manager`、`server-skills-catalog` 共 45/45 通过 |
| 上一轮真实 smoke | Preview、首次 Redeem、同 installationId 幂等 Redeem 通过；当时因 Refresh 缺少 `no-store` 被阻断，该服务端缺口现已修复并部署 |
| 上一轮授权 | 已绑定上一轮 smoke 设备，不能用于本次重跑 |
| 联调数据 | 公共模型可用；Skill catalog 为空，尚不能完成 Skills 下载验证 |

## File Structure

### UCLI Server repository: `F:\projects\ucli-server\.worktrees\device-grant-link-management`

- Create: `docs/superpowers/plans/2026-08-28-ucli-client-live-integration-rerun.md`：本次双方联调的唯一执行清单；生成后不再修改服务端源码。
- Verify: `apps/api/src/auth.controller.ts`：确认生产基线上的 Refresh `no-store` 合同来源。
- Operate: `apps/admin/src/views/Skills.vue`：创建、上传、发布和撤销联调 Skill。
- Operate: `apps/admin/src/views/UserDetail.vue`：为上一轮 smoke 用户创建新的永久设备授权和 1 天 URL。
- Operate: `apps/admin/src/components/DeviceGrantLinkActions.vue`：在 URL 仍可用或已过期时安全找回；本次不得为已绑定授权重建 URL。
- Temporary artifact: `%TEMP%\ucli-live-integration-smoke-20260828.zip`：仅包含根目录 `SKILL.md` 的无害联调包，联调后删除。

### UCLI Client repository: `F:\projects\ucli`

- Execute: `test/server-integration-smoke.test.mjs`：真实 Preview → Redeem → 幂等 Redeem → Refresh → Bootstrap → 模型 → Skills 联调入口；本方案不修改该测试。
- Verify: `test/server-contract-fixtures.test.mjs`：固定 JSON、SSE、MIME 和 `no-store` 合同。
- Verify: `test/server-device-grant-client.test.mjs`：固定敏感请求、来源和错误语义。
- Verify: `test/server-connection-manager.test.mjs`：固定 Refresh 轮换、持久化和授权到期提醒。
- Verify: `test/server-skills-catalog.test.mjs`：固定 catalog、download、SHA-256、生命周期和临时文件安全边界。
- Modify after success: `docs/release-acceptance.md`：把真实内网 smoke 从阻断更新为通过。
- Modify after success: `docs/ucli-client-protocol.md`：记录已部署修复和完整链路结果。
- Modify after success: `docs/ucli-client-registration-upgrade.md`：记录客户端升级交付的最终联调结论。

---

### Task 1: Establish the No-Secret Preflight Gate

**Owner:** UCLI Server / 运维

**Files:**

- Verify: `apps/api/src/auth.controller.ts`
- No source changes.

**Interfaces:**

- Consumes: 已部署的 `http://10.44.100.100` 和无效占位 refresh token。
- Produces: 健康状态、部署镜像和 Refresh 错误合同的 PASS 证据；不创建或读取任何真实凭证。

- [ ] **Step 1: 在服务端仓库确认基线提交和干净目标文件**

Run:

```powershell
git merge-base --is-ancestor a65361df27d9566903a25120d16338f644d60608 HEAD
git rev-parse HEAD
git status --short
git diff -- apps/api/src/auth.controller.ts
```

Expected: 第一条命令退出码为 0，证明当前 HEAD 包含服务端基线 `a65361df27d9566903a25120d16338f644d60608`；HEAD 可以额外包含本方案文档提交。`auth.controller.ts` 无未提交差异；其他非重叠用户文件即使存在也不得还原或覆盖。

- [ ] **Step 2: 运行不带真实凭证的线上健康与 Refresh 探针**

Run:

```powershell
$origin = 'http://10.44.100.100'
foreach ($path in @('/healthz', '/gateway/healthz', '/connect')) {
  $response = Invoke-WebRequest -Uri "$origin$path" -SkipHttpErrorCheck
  if ($response.StatusCode -ne 200) { throw "$path expected 200, got $($response.StatusCode)" }
}

$probe = Invoke-WebRequest `
  -Method Post `
  -Uri "$origin/api/v1/auth/token/refresh" `
  -ContentType 'application/json' `
  -Body (@{ refreshToken = 'invalid' } | ConvertTo-Json -Compress) `
  -SkipHttpErrorCheck
$body = $probe.Content | ConvertFrom-Json
if ($probe.StatusCode -ne 401) { throw "Refresh expected 401, got $($probe.StatusCode)" }
if ($probe.Headers['Content-Type'] -notmatch '^application/json(?:;|$)') { throw 'Refresh response is not JSON' }
if ($probe.Headers['Cache-Control'] -notmatch '(^|,)\s*no-store\s*(,|$)') { throw 'Refresh response is missing no-store' }
if ($body.code -ne 'invalid_grant') { throw "Refresh expected invalid_grant, got $($body.code)" }
'Production preflight: PASS'
```

Expected: 最后一行只输出 `Production preflight: PASS`；任何断言失败都停止本次联调，不创建 Skill 或授权。

- [ ] **Step 3: 在生产主机核对不可变 API 镜像**

在 `10.44.100.100` 的 `/data/ucli-server` 运行：

```bash
cd /data/ucli-server
test "$(docker inspect ucli-prod-api-1 --format '{{.Image}}')" = "sha256:d351803a621daa5aa5ef77aab47d18b75402b8fa1e0b1b7405869a9b94cd405e"
docker compose -p ucli-prod ps
```

Expected: 第一条检查退出码为 0；API 和 Gateway 显示 healthy，Worker 和 Web 显示 running。

---

### Task 2: Create and Publish the Minimal Integration Skill

**Owner:** UCLI Server 平台管理员

**Files:**

- Temporary create: `%TEMP%\ucli-live-integration-smoke-20260828\SKILL.md`
- Temporary create: `%TEMP%\ucli-live-integration-smoke-20260828.zip`
- Operate: `apps/admin/src/views/Skills.vue`
- No repository source changes.

**Interfaces:**

- Consumes: Task 1 的全部 PASS 证据和现有 Skill ZIP 扫描规则。
- Produces: slug 为 `ucli-live-integration-smoke-20260828`、版本为 `0.1.0`、状态为 `PUBLISHED` 的临时联调 Skill。

- [ ] **Step 1: 在管理员工作站生成内容固定的最小 ZIP**

Run:

```powershell
$skillRoot = Join-Path $env:TEMP 'ucli-live-integration-smoke-20260828'
$skillZip = Join-Path $env:TEMP 'ucli-live-integration-smoke-20260828.zip'
if (Test-Path -LiteralPath $skillRoot) { throw "Refusing to overwrite existing directory: $skillRoot" }
if (Test-Path -LiteralPath $skillZip) { throw "Refusing to overwrite existing archive: $skillZip" }
New-Item -ItemType Directory -Path $skillRoot | Out-Null
$skillContent = @'
---
name: ucli-live-integration-smoke
description: Harmless package used only to verify UCLI server catalog, download, and SHA-256 boundaries.
---

# UCLI Live Integration Smoke

When explicitly invoked in a test workspace, respond with exactly `ucli-live-integration-ok`.
'@
[IO.File]::WriteAllText(
  (Join-Path $skillRoot 'SKILL.md'),
  $skillContent,
  [Text.UTF8Encoding]::new($false)
)
Compress-Archive -LiteralPath (Join-Path $skillRoot 'SKILL.md') -DestinationPath $skillZip -CompressionLevel Optimal
$entries = @(tar -tf $skillZip)
if ($entries.Count -ne 1 -or $entries[0] -ne 'SKILL.md') { throw 'Skill ZIP must contain only root SKILL.md' }
$hash = (Get-FileHash -LiteralPath $skillZip -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $skillZip).Length
if ($size -le 0 -or $size -gt 20MB) { throw "Skill ZIP size is invalid: $size" }
"Integration Skill archive: PASS ($size bytes, SHA-256 $hash)"
```

Expected: ZIP 只包含根目录 `SKILL.md`，大小小于 20 MiB，并输出本地 SHA-256；归档中没有脚本、可执行文件或凭证。

- [ ] **Step 2: 通过管理端创建 Skill 元数据**

在 `http://10.44.100.100` 使用 `PLATFORM_ADMIN` 登录，打开“技能超市”，创建：

```text
slug: ucli-live-integration-smoke-20260828
名称: UCLI Live Integration Smoke 2026-08-28
描述: Temporary package for UCLI 0.12 client-server live integration verification.
```

Expected: 技能列表出现该 slug，版本区域显示“无”。如果该 slug 已存在，只允许在确认它正是本方案上一次未清理的记录后继续，禁止创建拼写不同的重复 Skill。

- [ ] **Step 3: 上传并发布固定版本**

在该 Skill 的“上传新版本”区域输入版本 `0.1.0`，选择 `%TEMP%\ucli-live-integration-smoke-20260828.zip`，依次点击“上传”和“发布”。

Expected: 版本显示 `v0.1.0 · PUBLISHED`。上传扫描或发布失败时停止联调，不创建授权；不得绕过扫描、直接改数据库或上传其他 ZIP。

---

### Task 3: Create and Deliver a Fresh One-Time Device Grant

**Owner:** UCLI Server 平台管理员

**Files:**

- Operate: `apps/admin/src/views/UserDetail.vue`
- Operate: `apps/admin/src/components/DeviceGrantLinkActions.vue`
- No repository source changes.

**Interfaces:**

- Consumes: Task 2 的 `PUBLISHED` Skill、现有至少一个已发布模型，以及上一轮 smoke 用户的 ACTIVE 组织成员关系。
- Produces: 一个状态为 `AVAILABLE` 的新设备授权和一个 1 天内有效、未消费的连接 URL。

- [ ] **Step 1: 在管理端确认联调用户和资源前置条件**

打开“用户管理”，找到上一轮 smoke 用户并进入详情；同时检查“模型管理”和“技能超市”。

Expected:

- 用户组织状态为“正常”，角色为 `MEMBER`。
- 至少一个公共模型处于已发布且健康状态。
- `ucli-live-integration-smoke-20260828` 的 `v0.1.0` 为 `PUBLISHED`。
- 上一轮授权保持原状态，不删除、不重新生成 URL，也不用于本次联调。

- [ ] **Step 2: 为同一用户创建一个新的授权**

在用户详情点击“创建授权”，选择：

```text
设备授权有效期: 永久有效
URL 有效期: 1 天
```

点击“创建授权”。

Expected: 新授权状态为“待绑定”，授权有效期为“永久”，URL 状态为“可用”，URL 有效期约为创建时间后 24 小时。用户可以同时保留上一轮设备和本轮新授权，这是“一用户多设备”的预期行为。

- [ ] **Step 3: 通过受控一对一渠道交付完整 URL**

点击“复制连接链接”，只发送给本次执行 smoke 的客户端开发人员。双方在独立消息中确认 URL 的 `secretHint`，但联调记录只保留 `secretHint`，不保存完整 URL。

Expected: 完整 URL 形如 `http://10.44.100.100/connect#link=...`，无 query string。管理员关闭抽屉后仍可在 URL 未消费或仅过期时通过“查看 URL”找回；不得为了“确认可用”在其他设备打开或提交该 URL。

---

### Task 4: Run the Existing Client Smoke Exactly Once

**Owner:** UCLI Client 开发

**Files:**

- Verify: `test/server-contract-fixtures.test.mjs`
- Verify: `test/server-device-grant-client.test.mjs`
- Verify: `test/server-connection-manager.test.mjs`
- Verify: `test/server-skills-catalog.test.mjs`
- Execute: `test/server-integration-smoke.test.mjs`
- No source changes in this task.

**Interfaces:**

- Consumes: Task 3 的未消费完整连接 URL。
- Produces: Preview、首次 Redeem、同 installationId 幂等 Redeem、强制 Refresh、Bootstrap、模型列表、最小流式模型调用、Skill catalog、ZIP 下载和 SHA-256 验证的单次结果。

- [ ] **Step 1: 在不读取连接 URL 的情况下运行客户端本地硬门**

在 `F:\projects\ucli` 运行：

```powershell
node --test --test-concurrency=1 `
  test/server-contract-fixtures.test.mjs `
  test/server-device-grant-client.test.mjs `
  test/server-connection-manager.test.mjs `
  test/server-skills-catalog.test.mjs
```

Expected: `tests 45`、`pass 45`、`fail 0`、`skipped 0`。`MODULE_TYPELESS_PACKAGE_JSON` 仅为已知性能 warning，不是联调阻断；任何测试失败都停止，不读取或消费连接 URL。

- [ ] **Step 2: 检查客户端工作树并记录当前提交**

Run:

```powershell
git rev-parse HEAD
git status --short
```

Expected: 记录实际客户端提交用于脱敏证据。已有无关未跟踪文件保持原样；不得清理、移动或提交它们。

- [ ] **Step 3: 通过掩码输入解析完整 URL 并运行一次真实 smoke**

Run；命令文本中不得粘贴 URL 或 secret：

```powershell
$env:UCLI_SERVER_SMOKE = '1'
$env:UCLI_SERVER_ORIGIN = 'http://10.44.100.100'
$secureUrl = Read-Host 'One-time UCLI connection URL' -AsSecureString
$urlPtr = [IntPtr]::Zero
$smokeExit = 1
$connectionUrl = $null
$linkSecret = $null
try {
  $urlPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
  $connectionUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPtr)
  $uri = [Uri]$connectionUrl
  if ($uri.Scheme -ne 'http' -or $uri.Authority -ne '10.44.100.100' -or
      $uri.AbsolutePath -ne '/connect' -or $uri.Query) {
    throw 'Connection URL origin or path is invalid'
  }
  $linkPairs = @($uri.Fragment.TrimStart('#').Split('&') | Where-Object { $_.StartsWith('link=') })
  if ($linkPairs.Count -ne 1) { throw 'Connection URL must contain exactly one link fragment' }
  $linkSecret = [Uri]::UnescapeDataString($linkPairs[0].Substring(5))
  if (-not $linkSecret) { throw 'Connection URL link fragment is empty' }
  $env:UCLI_SERVER_LINK = $linkSecret
  node --test test/server-integration-smoke.test.mjs
  $smokeExit = $LASTEXITCODE
} finally {
  Remove-Item Env:UCLI_SERVER_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:UCLI_SERVER_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:UCLI_SERVER_ORIGIN -ErrorAction SilentlyContinue
  if ($urlPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlPtr) }
  $linkSecret = $null
  $connectionUrl = $null
  $secureUrl.Dispose()
}
if ($smokeExit -ne 0) { throw "Live smoke failed with exit code $smokeExit" }
```

Expected: `tests 1`、`pass 1`、`fail 0`、`skipped 0`。测试内部完成以下有序断言：

1. Preview 返回 link `AVAILABLE`、authorization `AVAILABLE`。
2. 首次 Redeem 绑定临时 installationId。
3. 同一 installationId 在同一进程内幂等 Redeem，并安全替换 refresh token。
4. 强制 Refresh 成功且返回 `Cache-Control: no-store`，refresh token 再次轮换。
5. Bootstrap 返回组织、授权有效期、Gateway URL、Skills catalog URL 和至少一个模型。
6. 本地代理的 `/v1/models` 返回至少一个模型。
7. 使用 `bootstrap.models[0].id` 发送输入 `ping` 的最小流式请求并收到非空数据。
8. Skills catalog 返回至少一个版本，下载 ZIP 的字节数、inode/device 身份、catalog SHA-256 和 `x-ucli-sha256` 全部一致。
9. 验证后的 ZIP 只交给测试替身，不安装、不执行，并在 shutdown 中删除。

- [ ] **Step 4: 验证客户端临时材料清理**

Run:

```powershell
$leftovers = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'ucli-server-smoke-*' -ErrorAction SilentlyContinue)
if ($leftovers.Count -ne 0) { throw "Smoke temp directories remain: $($leftovers.Count)" }
$vars = @(Get-ChildItem Env: | Where-Object Name -Like 'UCLI_SERVER_*')
if ($vars.Count -ne 0) { throw "Smoke environment variables remain: $($vars.Name -join ',')" }
'Client smoke cleanup: PASS'
```

Expected: 只输出 `Client smoke cleanup: PASS`。

---

### Task 5: Verify Joint Evidence and Update the Client Handoff

**Owner:** UCLI Server / UCLI Client 开发

**Files:**

- Modify: UCLI Client `docs/release-acceptance.md`
- Modify: UCLI Client `docs/ucli-client-protocol.md`
- Modify: UCLI Client `docs/ucli-client-registration-upgrade.md`

**Interfaces:**

- Consumes: Task 4 的 `pass 1 / fail 0 / skipped 0` 和双方脱敏运行信息。
- Produces: 可交付给 UCLI 升级开发的最终通过记录，不包含任何凭证或个人身份信息。

- [ ] **Step 1: 平台侧核对绑定结果**

在上一轮 smoke 用户详情刷新设备和授权列表。

Expected:

- 本轮新授权从“待绑定”变为“已绑定”，URL 状态为“已使用”。
- 新增设备名称为 `UCLI 0.12 smoke device`，客户端版本为 `0.12.0`。
- 本轮授权有效期为“永久”；设备持有的授权响应中 `expiresAt` 为 `null`，并有合法 `serverTime`。
- 上一轮设备仍保留，证明一个用户可绑定多个设备。
- 未出现第二个由本轮授权绑定的设备。

- [ ] **Step 2: 在生产主机只统计错误和敏感字段命中数**

在 `/data/ucli-server` 运行；不要输出匹配行：

```bash
cd /data/ucli-server
log_errors="$(docker compose -p ucli-prod logs --since 30m api gateway worker 2>&1 | grep -Eic 'error|fatal|panic' || true)"
secret_hits="$(docker compose -p ucli-prod logs --since 30m api gateway worker 2>&1 | grep -Eic 'refreshToken|accessToken|Authorization|Bearer|#link=' || true)"
printf 'error/fatal/panic count: %s\nsensitive-term count: %s\n' "$log_errors" "$secret_hits"
test "$secret_hits" -eq 0
```

Expected: `sensitive-term count: 0` 且命令退出码为 0。若错误数非零，平台人员只按时间和请求阶段检查原因，仍不得复制含请求体或 header 的原始日志。

- [ ] **Step 3: 更新三份客户端交付文档的真实联调结论**

将 `docs/release-acceptance.md` 的“真实内网冒烟”行替换为：

```markdown
| 真实内网冒烟 | 通过（2026-08-28，Asia/Shanghai）：在服务端提交 `a65361d` / runtime 镜像 `sha256:d351803a621d` 上，Preview、首次 Redeem、同 installationId 幂等 Redeem、强制 Refresh、Bootstrap、模型列表、最小模型流、Skills catalog、ZIP 下载和 SHA-256 校验全部通过；测试未安装或执行服务端 Skill，临时数据库、凭证环境变量和 smoke 目录已清理。 |
```

将 `docs/ucli-client-protocol.md` 末尾的旧阻断段落替换为：

```markdown
2026-08-28 的真实内网 smoke 已在服务端提交 `a65361d` 上完整通过。Preview、首次 Redeem、同 installationId 幂等 Redeem、强制 Refresh、Bootstrap、模型列表、最小模型流、Skills catalog、ZIP 下载和 SHA-256 校验均实际执行；Refresh 的成功响应满足 `Cache-Control: no-store`。测试没有安装或执行下载的 Skill，临时数据库、环境变量和 staging 文件已清理，验收记录不包含连接 URL 或任何 token。
```

将 `docs/ucli-client-registration-upgrade.md` 末尾的旧阻断说明替换为：

```markdown
2026-08-28，UCLI Client 0.12.0 已使用新的单次设备授权完成目标内网真实联调：Preview、首次 Redeem、同 installationId 幂等 Redeem、Refresh、Bootstrap、模型列表、最小模型流和 Skills 下载哈希检查全部通过。服务端基线为提交 `a65361d`；下载的联调 Skill 只经过隔离验证，没有安装到真实用户目录或执行。UCLI 未注册服务端时的独立使用能力保持不变。
```

- [ ] **Step 4: 运行客户端文档与发布门**

Run:

```powershell
git diff --check
node --test --test-concurrency=1 test/release-verification.test.mjs test/server-contract-fixtures.test.mjs
npm run verify:release
```

Expected: `git diff --check` 无输出；目标测试零失败；`verify:release` 退出码为 0。已有无关未跟踪文件保持不变。

- [ ] **Step 5: 提交客户端联调证据**

Run:

```powershell
git add -- docs/release-acceptance.md docs/ucli-client-protocol.md docs/ucli-client-registration-upgrade.md
git diff --cached --check
git commit -m "docs(release): record complete server live smoke"
```

Expected: 提交只包含三份客户端文档，不包含测试输出、ZIP、环境文件、URL、token 或其他工作树文件。

---

### Task 6: Close the Integration Window Safely

**Owner:** UCLI Server 平台管理员 / UCLI Client 开发

**Files:**

- Operate: `apps/admin/src/views/Skills.vue`
- Operate: `apps/admin/src/views/DeviceGrants.vue`
- Delete temporary artifact only: `%TEMP%\ucli-live-integration-smoke-20260828\`
- Delete temporary artifact only: `%TEMP%\ucli-live-integration-smoke-20260828.zip`
- No repository source changes.

**Interfaces:**

- Consumes: Task 5 已提交的通过证据。
- Produces: 已撤销的联调 Skill、已禁用但可审计的联调授权，以及无本地临时归档的关闭状态。

- [ ] **Step 1: 撤销联调 Skill 版本**

在“技能超市”找到 `ucli-live-integration-smoke-20260828` 的 `v0.1.0`，点击“撤销”。

Expected: 版本状态变为 `REVOKED`，后续 catalog 不再返回该版本，已连接客户端可从 revocations 得知撤销状态。平台当前没有 Skill 删除接口，因此保留元数据和审计记录，不直接改数据库。

- [ ] **Step 2: 禁用本轮设备授权**

在“授权令牌”页面按上一轮 smoke 用户聚合定位本轮 `BOUND` 授权，核对设备名称为 `UCLI 0.12 smoke device` 和本轮创建时间后点击“禁用”。

Expected: 本轮授权变为 `DISABLED`，关联测试设备立即失去服务端能力，但记录仍可审计且可由管理员重新启用。不得误操作上一轮授权或该用户的其他真实设备。

- [ ] **Step 3: 删除管理员工作站上的固定临时 Skill 文件**

Run:

```powershell
$skillRoot = Join-Path $env:TEMP 'ucli-live-integration-smoke-20260828'
$skillZip = Join-Path $env:TEMP 'ucli-live-integration-smoke-20260828.zip'
if (Test-Path -LiteralPath $skillRoot) {
  $resolvedTemp = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\')
  $resolvedRoot = (Resolve-Path -LiteralPath $skillRoot).Path
  if (-not $resolvedRoot.StartsWith("$resolvedTemp\", [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedRoot) -ne 'ucli-live-integration-smoke-20260828') {
    throw "Unexpected Skill directory target: $resolvedRoot"
  }
  $entries = @(Get-ChildItem -LiteralPath $resolvedRoot -Force)
  $expectedFile = Join-Path $resolvedRoot 'SKILL.md'
  if ($entries.Count -ne 1 -or $entries[0].PSIsContainer -or $entries[0].FullName -ne $expectedFile) {
    throw 'Skill temp directory contains unexpected entries'
  }
  Remove-Item -LiteralPath $expectedFile -Force
  Remove-Item -LiteralPath $resolvedRoot -Force
}
if (Test-Path -LiteralPath $skillZip) {
  $resolvedTemp = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\')
  $resolvedZip = (Resolve-Path -LiteralPath $skillZip).Path
  if (-not $resolvedZip.StartsWith("$resolvedTemp\", [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedZip) -ne 'ucli-live-integration-smoke-20260828.zip') {
    throw "Unexpected Skill ZIP target: $resolvedZip"
  }
  Remove-Item -LiteralPath $resolvedZip -Force
}
if (Test-Path -LiteralPath $skillRoot) { throw 'Skill temp directory cleanup failed' }
if (Test-Path -LiteralPath $skillZip) { throw 'Skill ZIP cleanup failed' }
'Integration window cleanup: PASS'
```

Expected: 只删除两个固定 `%TEMP%` 目标并输出 `Integration window cleanup: PASS`；仓库文件不受影响。

---

## Retry and Failure Rules

| Failure point | Grant/link state | Required action |
| --- | --- | --- |
| Task 1 或客户端 45 项本地硬门失败 | 尚未创建或尚未读取链接 | 修复前置问题后从 Task 1 重跑；不得创建授权来“试一下” |
| Skill 创建、上传、扫描或发布失败 | 尚未创建授权 | 保留错误状态供平台排查；不得绕过扫描或直接写数据库 |
| 已创建 URL，但客户端尚未启动 smoke | `AVAILABLE` / `AVAILABLE` | 可继续使用同一 URL；若 URL 到期，对同一未绑定授权重新生成 URL，授权本身不变 |
| Preview 失败且管理端仍显示授权和 URL 都为 `AVAILABLE` | 未消费 | 修复可重试网络问题后允许使用同一 URL重新启动一次 smoke |
| 管理端显示 URL `CONSUMED` 或授权 `BOUND` | 已完成 Redeem | 本次进程内由测试完成同 installationId 幂等 Redeem；跨进程重跑必须创建新的设备授权和 URL |
| Refresh、Bootstrap、模型或 Skills 阶段失败 | 通常已绑定 | 保留脱敏阶段证据，禁用失败授权；修复后创建新授权重新运行完整 smoke |
| Skill 版本在 smoke 前被撤销 | catalog 不可用 | 重新发布经过扫描的新版本后再创建新授权，不复用已绑定授权 |
| 清理失败 | 联调链路可能已经通过 | 联调结果与清理结果分别记录；继续完成撤销/禁用，不重复 smoke |

## Failure Handoff Format

任一阶段失败时，双方只交换：

```text
timestamp: ISO-8601 with timezone
clientCommit: short SHA
serverCommitOrImage: a65361d or sha256:d351803a621d
grantHint: server-displayed secretHint only
stage: preflight | skill-publish | preview | redeem | idempotent-redeem | refresh | bootstrap | models | model-stream | skills-catalog | skill-download | cleanup
httpStatus: number or not-received
contentType: media type or not-received
cacheControl: no-store | missing | not-received
stableCode: approved protocol code | null | not-received
grantStatus: AVAILABLE | BOUND | DISABLED | EXPIRED | DELETED | unknown
linkStatus: AVAILABLE | CONSUMED | EXPIRED | REVOKED | unknown
retryable: true | false
```

禁止追加 URL、fragment、请求/响应正文、token、Authorization、Cookie、登录凭证、数据库密文、完整堆栈或用户邮箱/姓名。

## Joint Acceptance Criteria

只有全部满足时，本次客户端联调才算完成：

- 生产健康探针通过，API 镜像与固定基线一致。
- Refresh 无效 token 探针返回 HTTP 401、JSON、`Cache-Control: no-store` 和 `invalid_grant`。
- 客户端四组离线合同测试为 `45 passed / 0 failed`。
- 联调 Skill `v0.1.0` 通过服务端扫描并在 smoke 时处于 `PUBLISHED`。
- 新授权在 smoke 前为 `AVAILABLE`，设备授权永久有效，URL 单独有效 1 天。
- 真实 smoke 为 `1 passed / 0 failed / 0 skipped`。
- Preview、首次 Redeem、同 installationId 幂等 Redeem、Refresh、Bootstrap、模型列表、模型流、Skills catalog、ZIP 下载和 SHA-256 全部实际执行。
- 客户端收到授权 `expiresAt: null` 和合法 `serverTime`；独立使用模式未被改变。
- 平台显示本轮授权只绑定一个新设备，同一用户保留多设备能力。
- smoke 未安装或执行联调 Skill，客户端临时数据库、环境变量和 staging 目录全部清理。
- 服务端日志敏感字段统计为 0，双方证据不包含任何凭证或真实用户身份。
- 三份客户端交付文档更新并通过发布校验。
- 联调窗口结束后，联调 Skill 已撤销，本轮授权已禁用，管理员临时 ZIP 已删除。
