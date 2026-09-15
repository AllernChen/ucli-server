# 员工网关与组预算验收记录

日期：2026-09-15。分支：`codex/group-access`。已完成 Tasks 8–10 的源码、本地自动验收和真实 CLI 的本地模拟上游验收；未合并、推送、部署、连接公司中间件或调用付费上游。真实采购渠道与部署验收仍待执行。

## 本地结果

环境：Windows、Node.js 24.9.0；专用本地 `ucli_test_group_verified` PostgreSQL（127.0.0.1:55439，数据库时区 Asia/Shanghai）和测试 Redis（127.0.0.1:56389/15）。普通 HTTP 上游由测试进程模拟，不使用公司采购 Key。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| 覆盖率测试，排除 nginx Docker 单项、`--maxWorkers=4` | 107 个文件、652 项通过；行/语句 95.96%、分支 84.85%、函数 97.77% |
| `npm run build`、`npm run admin:build` | 通过；保留既有 Analytics 大包告警（547.46 kB） |
| `npm run licenses:check` | 455 条包记录通过，无新增依赖 |
| PowerShell 迁移脚本只读运行 | `dryRun: true`，未写组归属或开启组织开关 |
| Vue 挂载交互测试 | 覆盖组/成员/模型/预算、Key 一次明文、可信导航、设备归组、加载失败禁止提交；未进行真人浏览器视觉验收 |

早期 `npm run verify` 被 Docker Hub 连接超时和默认并发争用资源阻断。镜像补齐后，已将共享 PG/Docker 测试的默认 worker 上限设为 4；最新默认命令验证通过，见“发布收尾复验”。以下各节保留历史失败证据，没有调低覆盖率、修改测试超时或屏蔽用例。

### 发布收尾复验与生产预检（2026-09-15 12:04）

- 本机 12 个逻辑核、16 GiB 内存，默认高并发下同一 PG 网关用例反复超过 5 秒；4 worker 下约 1.6–2.2 秒。`vitest.config.ts` 限制默认并发为 4，不修改业务请求并发或断言；此前失败的默认 `npm run verify` 连续两轮通过（各 653 项）。
- 关键路径复核覆盖组/模型身份、Key 管理与永久撤销、预算预占/结算/人工对账、日志统计来源和明文 Key 页面生命周期。发现无使用日志的异常请求经人工对账补录后仍保留 UNKNOWN 状态；先新增 SETTLE/RELEASE 两项真实 PG 回归，均复现失败，再修正补录日志为 CONFIRMED/NO_CHARGE，同时保留原价格与审计快照。未修改历史生产数据。
- 最终修复后再次运行原样 `npm run verify`：108 文件、655 项全部通过；行/语句 95.96%、分支 85.07%、函数 97.77%。typecheck、服务端/管理端构建、455 条包许可证检查通过；两个编译产物 HTTP 脚本 `group-http.mjs`、`employee-key-http.mjs` 均退出码 0。未使用命令行 worker 覆盖或排除参数。
- SSH 只读确认 `/data/ucli-server` 当前 release 0.3.2，来源 `032c8ec23b4293bd43ee748640faf4f7b00abe77`，runtime 镜像 ID `sha256:bf1ab13d08eeb39ba4e18d35f66e3a0fffacb834cbebc2d92442249278a02391`、web 镜像 ID `sha256:928f4152c4b8ba2ff1e25c504aa3cd443dedc6f8dea5101a6932be7f51287fb2`（来自线上 RELEASE 元数据，正式升级前仍须逐容器比对）。四个应用容器运行，API/Gateway 健康端点均通过；Compose 2.29.7，两个外部网络存在，/data 约 18 TiB 可用。
- 生产 PG 为 16.14；15 条既有迁移均已完成，无回滚记录，最新为设备链接签发顺序。当前唯一新增迁移是 `202609140001_group_access_budget`，尚未执行。生产旧版本的业务改动已在当前分支中；本地及拉取后的 origin/main 仍为 `62ae863`，不是当前线上 release 的来源。
- 在部署目录三层范围内只找到 2026-09-02 的升级备份 `backups/pre-upgrade-0.3.2-20260902T170421/ucli-pre-upgrade-0.3.2.dump`，没有本次新鲜备份或恢复演练证据。根据 deploy-ucli-company-server / DEPLOY.md，停在生产升级前：需确定隔离 staging 库、创建并验证新备份、同版本恢复迁移演练、核实回滚镜像及密钥连续性，再固定新版本/源码、干净构建离线包和校验哈希。
- 本轮只读访问生产，没有备份/恢复/迁移/开关或业务数据变更；没有合并、推送、打发布标签或部署。Claude 交互 403 和真实采购渠道验收仍独立待办。本记录是关键路径人工复核，不冒称全仓库独立安全审计。

### 镜像补齐后的全量复验（2026-09-15 11:40）

- 确认本机存在 `node:24-alpine`、`nginx:1.27-alpine`，nginx 单项独立通过（约 112 秒）；真实管理端镜像构建并启动后，`/healthz` 返回 API JSON 而非 SPA 页面。
- 首次全量启动漏带本地 PG 端口参数，导致 27 项数据库连接失败；修正为 `-p 55439 -h 127.0.0.1` 并用 `SELECT 1` 确认就绪后重跑。默认并发结果为 652 通过、1 项 group-gateway 超时；不是业务断言失败。
- `npm run test:coverage -- --maxWorkers=4`：108 个文件、653 项全部通过，没有排除 Docker 或数据库测试。group-gateway 用例约 1.64 秒；行/语句覆盖率 95.96%、分支 84.85%、函数 97.77%。
- 同轮 typecheck、服务端构建、管理端构建和许可证检查（455 条包记录）全部通过，保留 Analytics 547.46 kB 的既有包体积告警。覆盖率和后续构建命令串联执行，任一步失败即停止，最终退出码 0。
- 未修改业务代码、Dockerfile 或测试门槛；Claude 交互启动 403、真实采购渠道验收仍待处理。未合并、推送或部署；本地 Docker 管理端健康验证不等于公司服务器发布验收。

真实 PG 测试覆盖组权限/跨组织隔离、Key 生命周期、预算竞争/幂等/月界/未知费用/人工校正、Redis 故障恢复、设备首次归组和强制开关与签发竞争。固定多渠道成本样本在总览、组、员工、Key、模型及渠道均为 ¥4.00000000，历史未归组记录保留，未知费用单列。

## HTTP 端到端

沿用并扩展已有 `test/integration/employee-key-http.mjs`，不再新增重复的 `employee-gateway-e2e.test.ts`。它运行编译产物、真实 PG/Redis 和本地模拟上游，已配置在 CI 的 group-integration job；本轮不宣称远程 CI 已运行。

覆盖：管理员建立员工和 A/B 组、模型授权、小额预算、签发 Key、双目录权限差异、三种协议普通/流式请求、函数工具调用及结果回传、设备旧 Token 归组后继续使用、日志/余额对账、并发预算、401/403/429、停用/恢复/撤销。13 笔主组调用每笔 ¥0.00000700，总览和预算均为 ¥0.00009100；8 路并发竞争另一组的预占额度，1 路放行、7 路 429。

所有成功请求检查 `x-ucli-request-id` 与持久日志对应、员工/组/Key 归属及 CNY 精度。工具测试发现并修复 Chat 历史 `tool_calls[].type=function` 被预算文本检查误拒绝的问题；图片等无法估价的输入仍拒绝。

最近一轮本地 HTTP 测试的日志样本（不是 CLI 调用，每笔 ¥0.00000700）：

| 协议 | 普通请求 ID | 流式请求 ID |
| --- | --- | --- |
| Chat | `3409184f-f450-4832-982e-ca44f41887f1` | `1f23ec04-5396-49dc-b91d-55166704a1b0` |
| Responses | `6be24b96-f876-4ef6-ad3e-467f35b7f5dc` | `2f2a2d66-34a9-48fa-9465-a5dfbe076181` |
| Messages | `d5a33fc3-457e-415d-8518-7ff3433397c7` | `7efdf243-158d-4098-a8c1-30f55eccf0ca` |

`group-http.mjs` 与上述员工网关 E2E 均已在最新编译产物复跑通过。

复跑（先为专用测试库应用现有 Prisma 迁移；不要把生产 URL 赋给这些变量）：

```powershell
$env:TEST_DATABASE_URL = '<本地 ucli_test* PostgreSQL URL>'
$env:TEST_REDIS_URL = '<独立本地 Redis URL>'
npm run typecheck
npm test -- test/integration --maxWorkers=4
npm run test:coverage -- --exclude test/deploy/nginx-health-route.test.ts --maxWorkers=4
npm run build
node --import tsx test/integration/group-http.mjs
node --import tsx test/integration/employee-key-http.mjs
npm run admin:build
npm run licenses:check
# Docker Hub 恢复后，必须重新运行未排除的完整 verify
npm run verify
```

## 实际 CLI 状态

| 客户端 | 本机版本 | 已测协议 | 状态 |
| --- | --- | --- | --- |
| Claude Code | 2.1.268 | Anthropic Messages | 非交互 `/model` 发起目录请求并成功；缓存关闭后文本流、Read 工具结果往返通过 |
| OpenCode | 1.18.23 | `@ai-sdk/openai-compatible` / Chat | `models ucli` 列出配置模型；文本流、read 工具结果往返通过 |
| UCLI 客户端 | 未启动客户端 | 依模型声明选择 | 设备 JWT 的 HTTP 回归通过，客户端界面未实测 |

### 真实 CLI 本地验收补充

复用 HTTP E2E 的编译产物、实际员工 Key、真实 PG/Redis 和本地模拟上游，增加可选 `employee-cli.mjs`，默认测试及 CI 不启动 CLI。每轮使用新临时目录，隔离 Claude 配置和 OpenCode 的 XDG 配置/数据/缓存，不读取日常 API Key、插件或项目；不启用权限绕过，只让工具读取本轮临时 `probe.txt`。模拟上游请求读文件后，必须收到文件内随机标记才返回 `UCLI_TOOL_OK`，避免仅凭工具调用事件判断成功。

Claude 用 `--bare` 做对话测试，用 `--safe-mode --setting-sources ""` 执行非交互 `/model`。后者确实请求 `/anthropic/v1/models`（200），未验证交互式 picker 画面或磁盘缓存；短时非交互命令没有留下官方文档所述缓存文件，不能据此认定过滤后的 picker 已验收。模型使用明确标记的 `claude-ucli-local-*` 合成测试条目，未重命名任何真实供应商模型。

真实调用证据（本轮每笔服务端采购成本 ¥0.00000700）：

| 客户端场景 | 请求 ID |
| --- | --- |
| Claude 文本流 | `fba4c1c4-97a5-40ad-9b73-3a0f5dc8d109` |
| Claude 工具调用 / 结果回传 | `2f9a064a-90d5-48a6-a780-24ac90316801` / `e440c80e-546e-4f60-b9fd-a5f51649fe44` |
| OpenCode 文本流（含额外辅助请求） | `187dbde1-2fb4-4d96-922e-bc35ca6c499e` / `07f38703-6b69-4c0f-8b18-803f8a9c1ebb` |
| OpenCode 工具（辅助 / 调用 / 回传） | `b4826a98-7181-4a67-80eb-f11ecb8dce56` / `d32d4487-4be6-43a0-af09-ccdf669030dd` / `fc5e81ca-420e-4696-a187-c2a1e986b2ef` |

共 8 条成功日志，组预算新增 ¥0.00005600，与日志合计一致。各日志断言了真实员工 Key/组归属和采购成本；客户端显示的金额不是该账本依据。原始脱敏输出保存在本地忽略目录 `data/employee-cli-acceptance.json`（后续复跑覆盖）。

明确边界：

- Claude 默认提示缓存请求返回 400 `unsupported_budget_estimation`，请求 ID `35e9e95a-7a11-4389-9b49-ac7040027b12`，未形成收费日志。设置 `DISABLE_PROMPT_CACHING=1` 关闭客户端提示缓存后成功。没有扩展缓存写入价格模型，也未删除网关校验。
- 验收使用 `CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024` 和 `MAX_THINKING_TOKENS=0`；文本与文件读取工具通过，不代表图像、所有内建工具、缓存写入或全部扩展支持。两款 CLI 均实际发送流式请求，非流式 HTTP 已在前述 E2E 覆盖。
- Claude 的 `HEAD /api/hello` 预热 404 未影响对话；目录请求没有网关推理 request ID。OpenCode 的 `models ucli` 只读自身 provider 配置，未调用网关目录，不应称为自动发现。
- 本地失败首轮的 Key 已显式撤销；修正清理字段后最终轮通过并由父 E2E 撤销 Key。首轮临时目录 `ucli-cli-acceptance-I0WEl4` 的手动删除被工具策略阻止，保留于系统 Temp；最终轮自己的临时配置已清理。
- 本轮仅修改测试及接入/验收文档，未改变生产功能；类型检查、脚本语法检查和 12 项协议/预算定向回归通过，完整 HTTP 加真实 CLI 验收脚本退出码为 0。上文 652 项覆盖率是上一轮完整记录。

复跑方式（先配置本地 TEST_DATABASE_URL / TEST_REDIS_URL 并构建）：

```powershell
$env:UCLI_TEST_REAL_CLI = '1'
$env:UCLI_TEST_CLAUDE_EXE = '<本机 claude 可执行文件绝对路径>'
$env:UCLI_TEST_OPENCODE_EXE = '<本机 opencode 可执行文件绝对路径>'
node --import tsx test/integration/employee-key-http.mjs
Remove-Item Env:UCLI_TEST_REAL_CLI
```

发现/配置合同参考：[Claude 网关协议](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery)、[Claude 环境变量](https://code.claude.com/docs/en/env-vars)、[OpenCode 配置](https://opencode.ai/docs/config/#enabled-providers)（2026-09-15 核对）。后续仍需 Claude 交互 picker、真实渠道和 Docker 部署链路验收；付费调用须单独授权。接入配置见[员工接入](employee-api-access.md)。

### 交互终端与 Docker 复查（2026-09-15）

- 在真实 TTY 中启动 OpenCode 1.18.23，输入 `/models` 打开 `Select model`，看到并选择 `Local mock Chat / UCLI local acceptance`，再用 `/exit` 正常退出（退出码 0）。仅验证配置模型的选择器，没有目录 HTTP 请求，不是自动发现。
- 同轮 Claude Code 2.1.268 交互启动退出码 1。完整终端输出为 `Unable to connect to Anthropic services`、`Failed to connect to api.anthropic.com: Status 403`，没有进入 `/model` 选择器。未知合成模型目录提示只是警告；该轮网关只收到预热 HEAD 404，没有目录或推理请求，不能把外部启动检查失败归因于模型权限。
- 可在上述真实 CLI 命令前显式设置 `$env:UCLI_TEST_INTERACTIVE = '1'`，在真实终端中人工操作选择器；结束后 `Remove-Item Env:UCLI_TEST_INTERACTIVE`。该模式可能触发客户端自身联网检查，不能宣称完全离线。任一客户端异常退出即失败；退出码正常仍不代替人工画面检查。生产默认和 CI 不启用该模式。
- `npm test -- test/deploy/nginx-health-route.test.ts` 再次失败于拉取 `node:24-alpine` 元数据：`auth.docker.io/token` 连接 `199.16.156.38:443` 超时。主机 DNS 也返回该 IP；本机仅缓存 Redis/nginx 镜像，没有 Node 基础镜像。nginx 用例尚未运行，不记通过；未修改 Dockerfile、网络或覆盖率门槛。
- 随后的非交互完整 HTTP + CLI 复跑退出码 0，typecheck 与脚本语法检查通过。该次实际版本为 Claude 2.1.268 / OpenCode 1.18.31，与前一次 UI 验证版本分开记录。Claude 文本请求 `e06d065a-cd0d-43bb-84c1-005a9418f3ba`、OpenCode 文本请求 `2dc6cf5e-6dac-4351-a16f-2230df892cfb`；8 条成功日志仍合计 ¥0.00005600，Key 撤销回归通过。报告文件已被这次成功的非交互复跑覆盖，以上交互记录以终端实际输出为依据。

本轮仅增加可选人工验收入口和证据记录，没有修改服务端能力、公司数据或客户端日常配置。Claude 交互启动与 Docker Hub 连通性解决后须分别复验，不能宣布完整发布验证通过。

## 设备归组演练与发布顺序

1. 保留备份并确认新旧版本兼容；此次不改变既有公司数据。
2. 在专用本地测试库先创建组、加入员工、分配模型和预算，盘点无组设备授权。
3. 先只读检查，再用显式映射预览；确认后才使用 `-Apply`。每批只允许一个组织、1–1000 个不重复授权，组织/员工/授权/组归属必须一致；任一条无效整批回滚。已归组授权不可改组。
4. 生产部署后由管理员使用设备授权页面首次归组；有效未归组授权清零后，再确认开启该组织强制模式。脚本只允许 loopback `ucli_test*` 库，**不能用于公司生产导入**，也不会自动切换强制模式。
5. 新增 Key 入口的生产开关、真实渠道验收和发布需要单独确认。关闭 Key 入口不解除已归组设备预算；关闭组织强制模式不改变已有组归属。不通过清零账本或重新签发全部设备处理回滚。

映射文件结构（占位 UUID 必须替换为该测试库实际值）：

```json
[{"organizationId":"<UUID>","accountId":"<UUID>","grantId":"<UUID>","groupId":"<UUID>"}]
```

```powershell
# TEST_DATABASE_URL 必须显式指向本地测试库；不接受 URL 查询参数
./scripts/rehearse-group-access-migration.ps1 -OrganizationId '<UUID>'
./scripts/rehearse-group-access-migration.ps1 -OrganizationId '<UUID>' -ActorId '<管理员 UUID>' -MappingPath './mapping.json'
# 仅在上一步预览确认后，显式写入本地测试映射
./scripts/rehearse-group-access-migration.ps1 -OrganizationId '<UUID>' -ActorId '<管理员 UUID>' -MappingPath './mapping.json' -Apply
```

灰度观察：错误率与 401/403/429 分布、已用/预占/待核对余额、Worker 的 `group_settlement_pending` / `group-quota-recovery-pending` 告警、渠道账单与各维度成本。未知费用先保留预占，拿到账单后通过现有对账 API 结算，不直接编辑金额列。
