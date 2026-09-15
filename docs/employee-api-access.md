# 员工 API Key 接入

当前已实现组预算、管理页面、成本分析与设备归组迁移，尚未部署。`EMPLOYEE_API_KEYS_ENABLED` 默认 `false`：本次仅隔离测试环境显式设置 `true`。本地验证不代表公司服务器已启用；验证证据、发布前条件见[验收记录](employee-gateway-acceptance.md)。

## 凭据与权限

管理员给员工签发平台 Key，每个 Key 固定属于一个用户和一个用量组。员工无需安装 UCLI，也无需开通网页密码。公司采购的上游密钥不会发给员工。

Key 明文仅在创建响应出现一次；数据库只存摘要。遗失时创建新 Key，再撤销旧 Key。停用可以恢复，撤销和删除不能恢复。移除组成员永久撤销该组旧凭据，重新加入不会复活它们。组、账号、组织、成员或 Key 失效都会阻止新调用；已经开始的请求不是强制断流。

Key 的权限为“组模型白名单”与已有组织/用户/角色策略的交集；不同组的 Key 可以看见不同模型。客户端的项目字段、`groupId` 或其他请求头不能改变归属。平台成本单位为人民币，不计算员工销售价格。

## 地址与协议

把下面示例域名替换为管理员给出的地址。推荐 HTTPS；既有公司可信内网 HTTP 配置不得扩展到公网。不要把 Key 放进 URL、配置仓库、截图或聊天记录。

| 客户端协议 | Base URL | 路径 |
| --- | --- | --- |
| OpenAI Chat | `https://ucli.company.example/gateway/v1` | `/chat/completions` |
| OpenAI Responses | 同上 | `/responses` |
| Anthropic Messages | `https://ucli.company.example/gateway/anthropic` | `/v1/messages` |

OpenAI 目录是 `/gateway/v1/models`；Anthropic 目录是 `/gateway/anthropic/v1/models?limit=1000`，只列出具有 Messages 能力的已授权模型。目录直接返回、不重定向、`Cache-Control: no-store`，不调用付费上游。当前返回完整清单，不支持分页游标。

目录不是实时健康检查，也不表示工具调用已通过验收。Chat、Responses、Messages 不自动互转；Gemini 仅保留内部 Chat 文本转换，没有公开 Gemini 原生入口。

两种入口使用同一员工 Key。支持 `Authorization: Bearer <Key>` 或 `x-api-key: <Key>`；两者同时出现必须相同。不同双头、空值、数组或非法格式返回 401，不会挑一个继续。网页 JWT 不能当作网关凭据；既有有效 UCLI 设备 JWT 仍可用。

## PowerShell 验证

以下假设公司凭据工具已安全注入 `UCLI_API_KEY`，不要在脚本中写真实 Key。

```powershell
$base = 'https://ucli.company.example'
$headers = @{ Authorization = "Bearer $env:UCLI_API_KEY" }
Invoke-RestMethod -Uri "$base/gateway/v1/models" -Headers $headers

$body = @{
  model = '替换为目录中的真实模型ID'
  messages = @(@{ role = 'user'; content = '请只回复 OK' })
  max_tokens = 16
  stream = $false
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$base/gateway/v1/chat/completions" `
  -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

对话会产生实际采购成本，只在获准环境测试；先从目录选取支持 Chat 的模型。

## Claude Code

```powershell
$env:ANTHROPIC_BASE_URL = 'https://ucli.company.example/gateway/anthropic'
$env:ANTHROPIC_API_KEY = $env:UCLI_API_KEY
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
# 当前组预算尚不支持缓存写入计价，必须关闭客户端提示缓存
$env:DISABLE_PROMPT_CACHING = '1'
# 首次验收使用小输出上限，之后按模型上下文和组预算调整
$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS = '1024'
claude
```

清理旧的、不同值的 `ANTHROPIC_AUTH_TOKEN`，避免与新 Key 冲突。当前官方文档说明：发现请求使用 `/v1/models?limit=1000`，超时为 3 秒；客户端筛选包含 `claude` 或 `anthropic` 的 ID。因此 DeepSeek 目录正常，不代表一定自动出现在 Claude Code 的 `/model` 中。不要修改厂商名称或伪造模型 ID 绕过筛选。发现行为还受客户端版本及受管配置影响。[Claude Code 官方网关协议说明](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery)（2026-09-14 核对）。

服务端保留请求体，并向 Messages 上游透传 `anthropic-version`、`anthropic-beta`；认证头始终替换成采购渠道凭据。本次没有实现所有 Claude 扩展接口或任意 `anthropic-*` 头透传，不能宣称完整 Claude Code 兼容。

2026-09-15 已用真实 Claude Code 2.1.268 连接本地网关/模拟上游验证：关闭提示缓存后的文本流与 Read 工具往返成功，非交互 `/model` 触发真实目录请求并返回 200。未验收交互模型选择器画面。默认缓存请求实际返回 400 `unsupported_budget_estimation`；不能把缓存读费率当作缓存写入费率，也不在网关偷偷删除 `cache_control`。`DISABLE_PROMPT_CACHING=1` 是官方客户端开关，见[环境变量说明](https://code.claude.com/docs/en/env-vars)（2026-09-15 核对）。验收时另用 `MAX_THINKING_TOKENS=0` 关闭推理，未覆盖全部推理/缓存扩展。

## OpenCode

Chat 模型可配置自定义 provider；将 `your-platform-model-id` 换成目录内真实 ID。Key 从环境读取，不写入文件：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ucli": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "公司 UCLI",
      "options": {
        "baseURL": "https://ucli.company.example/gateway/v1",
        "apiKey": "{env:UCLI_API_KEY}"
      },
      "models": {
        "your-platform-model-id": { "name": "公司模型" }
      }
    }
  }
}
```

OpenCode 自定义 provider 的模型列表需要配置，不能假定只填地址就会自动导入所有模型。Responses 模型需使用对应适配器，不能使用 Chat 适配器代替。[OpenCode 官方自定义 Provider 说明](https://opencode.ai/docs/providers/#custom-provider)（2026-09-14 核对）。2026-09-15 已用 OpenCode 1.18.23 验证 `models ucli`、Chat 文本流与 read 工具往返；本地模拟上游通过，未测试真实付费模型或该客户端的 Responses 适配器。

CLI 可能自行估算美元费用，或因为自定义 provider 没有价格而显示零；这些不是平台采购成本。本次 Claude 显示其默认美元估价、OpenCode 显示零，但服务端每笔均按测试采购价计 ¥0.00000700。组预算和公司统计只使用服务端人民币账本，切勿以 CLI 本地金额对账。

## 管理接口与故障

管理员可通过 `/api/v1/admin/users/:accountId/api-keys` 查询、创建；`/api/v1/admin/employee-api-keys/:id` 修改名称/到期时间或软删除；其 `/enable`、`/disable`、`/revoke` 执行生命周期操作。不能修改员工和组归属。

`/api/v1/me/api-keys` 查询自己的 Key，`/api/v1/me/api-keys/:id/revoke` 撤销自己的 Key；只接受网页登录 JWT，设备 JWT 和员工 Key 均不能调用。无密码员工由管理员代办。

- `401 invalid_credential/invalid_api_key`：认证头不合法、Key 不存在/到期/停用/撤销/删除。
- `403 employee_api_keys_disabled`：测试开关尚未启用。
- `403 group_access_denied/model_access_denied`：组、成员等不可用，或组未授权该模型。既有模型策略也可能返回 404。
- `503 model_protocol_unavailable/model_channel_unavailable`：协议或健康渠道不可用，不是 Key 认证失败。

当前自动验证覆盖本地 PostgreSQL/Redis、双目录、权限、模拟上游三种普通请求/Chat 流式响应、凭据不外泄、预算竞争、跨月结算、待核对费用及 Worker 恢复；未连接付费上游，未替代真实 CLI 验收。

## 组预算与成本对账（管理 API）

下列接口位于 `/api/v1/admin/usage-groups/:id`，使用管理员网页登录 JWT，不能用员工 Key 调用。金额为 CNY 十进制字符串，最多八位小数；零额度禁止调用，不限额必须显式设置 `unlimited: true`。

| 方法与子路径 | 用途 |
| --- | --- |
| `GET /budget` | 当前周期额度、已用、预占、待核对及可用金额；不限额的 availableCny 为 null |
| `PATCH /budget-config` | budgetMode（TOTAL/MONTHLY）、budgetTimezone、operationId、reason |
| `POST /budget-adjustments` | scope（CURRENT/DEFAULT）、limitCny、unlimited、operationId、reason；可带 periodId 指定要调整的已有周期 |
| `GET /budget-entries` | offset/limit 分页查看请求、额度和成本调整记录 |
| `POST /budget-entries/:entryId/reconcile` | action（SETTLE/RELEASE）、actualCny、operationId、reason；多路由需 routes 数组，逐项填写 id/costCny 且合计一致 |

CURRENT 修改指定周期（默认当前周期）的**总额度**，不清除已用成本，不能降低到“已用＋预占”以下。DEFAULT 仅修改以后新建周期的默认额度，不改变已创建周期；总额项目应使用 CURRENT。operationId 用客户端生成的 UUID，同一操作重试必须保持相同参数。

月周期按组时区和请求开始时间确定，跨月完成仍结算原周期。有请求的当前周期或其他未完成请求会阻止更改模式/时区。配置修改不会删除历史周期。

组请求当前支持文本及调用方提供的函数工具。图片、音频、外部托管工具、隐式历史上下文及显式缓存写入等无法用现有采购价格可靠估算的输入返回 `unsupported_budget_estimation`；不限额只取消金额限制，不额外开放这些计费类型。Chat/Responses/Messages 会实际带上服务端确定的输出上限，默认不超过 4096，并受模型上下文大小约束。

已确认费用入账，未知路由费用保留预占并标记 RECONCILIATION_REQUIRED，不因超时、流中断、缺少结束事件或进程退出自动清零。普通完整响应缺 usage 时沿用显式估算；发现未配置费率的缓存写入 token 则转待核对。账单确认后可人工结算，或以 RELEASE 和零成本有依据地释放。人工终态不会被迟到的自动结果覆盖。

账本和使用日志在同一个 PostgreSQL 事务中提交；Redis 仅为旧速率/token/成本配额的兼容计数，微单位向上取整，不是组金额依据。Worker 每分钟处理过期记录与待同步配额；尚未发送的预占可释放，已发送的转待核对。未知费用保留时释放并发槽位，避免把已结束请求当作仍在运行。80/100 阈值在周期内去重写入审计。

数据提交失败会重试一次，仍失败则保留预占、记录 `group_settlement_pending` 并等待恢复/人工账单核对；不承诺异常情况下实际费用绝不超过额度。Redis 恢复使用有界 SCAN，标记量很大时应改为索引队列。管理页面提供预算配置及账目查询；待核对账目的人工结算仍使用上述对账 API。

## 管理页面与设备归组

管理员在“用量组”维护项目/部门组、成员、模型白名单及人民币预算，在“用户详情 → 员工 API Key”签发和管理 Key。已有网页登录账号的员工使用“我的接入”查看/撤销自己的 Key，不自动为无密码员工开通网页登录。

“使用日志”和“统计分析”支持组、Key、凭据类型过滤；历史未归组日志仍保留。名称使用请求快照，成本取结算值和当时价格快照；一个请求经过多个计费渠道时，各渠道费用分别归集，同渠道请求去重，不同渠道请求数不可相加作为全平台请求数。待核对费用与已确认成本分开。

在“设备授权 → 设备归组迁移”查看当前组织的有效未归组授权（含待绑定）。先把员工加入组并配置模型/额度，再执行“首次归组”；原设备 Token 无需重新兑换，新请求立即按该组权限和预算执行。已归组授权不能改组，需要新建授权。使用日志的历史归属不回填。

全部有效授权归组或撤销后才可开启“强制归组”。开启后，新建设备授权必须选组，兑换与刷新重新检查组成员状态；已停用或已过期的无组授权也不能直接恢复使用。关闭强制模式只恢复无组兼容，不解除已归组设备的组权限与预算。平台管理员可在“组织”页面查看各组织迁移状态和开关。

开发验证需要显式配置本地 `TEST_DATABASE_URL`（数据库名以 `ucli_test` 开头）和 `TEST_REDIS_URL`（使用独立测试 Redis/数据库编号），并先将现有迁移应用到该测试库。`npm run verify` 的覆盖率包含真实账本逻辑；省略测试库会跳过集成用例，不能作为完整验证。禁止为测试连接公司中间件，CI 的 verify 和 group-integration 任务均使用专用服务。
