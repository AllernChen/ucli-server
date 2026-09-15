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

`npm run verify` 不能记为全通过：nginx 健康测试需要拉取 `node:24-alpine`，Docker Hub `auth.docker.io` 连接超时，发生在本次变化前的基线上。全默认并发还出现一次 group-gateway 用例超过 5 秒；相同用例在 4 worker 重跑耗时 1.75 秒通过。没有调低覆盖率、修改测试超时或永久屏蔽用例。

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

发现/配置合同参考：[Claude 网关协议](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery)、[Claude 环境变量](https://code.claude.com/docs/en/env-vars)、[OpenCode 配置](https://opencode.ai/docs/config/#enabled-providers)（2026-09-15 核对）。后续仍需交互 picker、真实渠道和 Docker 部署链路验收；付费调用须单独授权。接入配置见[员工接入](employee-api-access.md)。

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
