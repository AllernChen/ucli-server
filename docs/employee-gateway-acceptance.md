# 员工网关与组预算验收记录

日期：2026-09-15。分支：`codex/group-access`。本轮完成 Tasks 8–10 的源码和本地自动验收；未合并、推送、部署、连接公司中间件或调用付费上游。真实客户端与部署验收仍待执行。

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

| 客户端 | 本机版本 | 待验证协议 | 状态 / 请求 ID |
| --- | --- | --- | --- |
| Claude Code | 2.1.268（仅执行 `--version`） | Anthropic Messages | 未实测；无 CLI 请求 ID |
| OpenCode | 1.18.23（仅执行 `--version`） | 选定 provider 的 OpenAI Chat | 未实测；无 CLI 请求 ID |
| UCLI 客户端 | 未启动客户端 | 依模型声明选择 | 设备 JWT 的 HTTP 回归通过，客户端界面未实测 |

下一轮使用明确的 CLI 版本、测试模型和测试 Key，记录 `/model`、普通/流式、工具调用/结果回传、usage/cost 和每次 request ID；目录发现不能替代对话验收。只有明确授权才运行真实渠道付费测试。接入配置和协议限制见[员工接入](employee-api-access.md)。

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
