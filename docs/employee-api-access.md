# 员工 API Key 接入

当前为第二阶段源码能力，尚未部署。`EMPLOYEE_API_KEYS_ENABLED` 默认 `false`：只有隔离测试环境可以显式设置 `true`。组预算预占、扣费和恢复将在下一阶段接入；现在不能据此承诺金额限制已经生效。

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
claude
```

清理旧的、不同值的 `ANTHROPIC_AUTH_TOKEN`，避免与新 Key 冲突。当前官方文档说明：发现请求使用 `/v1/models?limit=1000`，超时为 3 秒；客户端筛选包含 `claude` 或 `anthropic` 的 ID。因此 DeepSeek 目录正常，不代表一定自动出现在 Claude Code 的 `/model` 中。不要修改厂商名称或伪造模型 ID 绕过筛选。发现行为还受客户端版本及受管配置影响。[Claude Code 官方网关协议说明](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery)（2026-09-14 核对）。

服务端保留请求体，并向 Messages 上游透传 `anthropic-version`、`anthropic-beta`；认证头始终替换成采购渠道凭据。本次没有实现所有 Claude 扩展接口或任意 `anthropic-*` 头透传，不能宣称完整 Claude Code 兼容。具体 CLI 版本、工具调用和工具结果回传尚未实测。

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

OpenCode 自定义 provider 的模型列表需要配置，不能假定只填地址就会自动导入所有模型。Responses 模型需使用对应适配器，不能使用 Chat 适配器代替。[OpenCode 官方自定义 Provider 说明](https://opencode.ai/docs/providers/#custom-provider)（2026-09-14 核对）。当前未运行真实 OpenCode 客户端验收。

## 管理接口与故障

管理员可通过 `/api/v1/admin/users/:accountId/api-keys` 查询、创建；`/api/v1/admin/employee-api-keys/:id` 修改名称/到期时间或软删除；其 `/enable`、`/disable`、`/revoke` 执行生命周期操作。不能修改员工和组归属。

`/api/v1/me/api-keys` 查询自己的 Key，`/api/v1/me/api-keys/:id/revoke` 撤销自己的 Key；只接受网页登录 JWT，设备 JWT 和员工 Key 均不能调用。无密码员工由管理员代办。

- `401 invalid_credential/invalid_api_key`：认证头不合法、Key 不存在/到期/停用/撤销/删除。
- `403 employee_api_keys_disabled`：测试开关尚未启用。
- `403 group_access_denied/model_access_denied`：组、成员等不可用，或组未授权该模型。既有模型策略也可能返回 404。
- `503 model_protocol_unavailable/model_channel_unavailable`：协议或健康渠道不可用，不是 Key 认证失败。

当前自动验证覆盖本地 PostgreSQL、双目录、权限、模拟上游三种普通请求/Chat 流式响应、凭据不外泄和日志归属；未连接付费上游、未验证组预算、未替代真实 CLI 验收。
