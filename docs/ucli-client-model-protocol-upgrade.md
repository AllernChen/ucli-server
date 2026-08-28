# UCLI 客户端模型协议能力升级方案

## 实施仓库与边界

客户端代码只在 UCLI 仓库实施；UCLI Server 仓库不包含客户端代码改动。本交接文档是 UCLI 开发者升级模型选择、Gateway 调用、错误处理和验收回传所需的完整服务端合同。

本次仅公开 `openai_responses`、`openai_chat`、`anthropic_messages` 三种 Gateway 协议。`GEMINI` 是服务端内部上游/转换协议，仅贡献 `openai_chat`；UCLI 不得把 `gemini` 作为可选择的能力、配置项或原生 Gateway 调用端点。

## 服务端合同

### Bootstrap 模型目录

`GET /api/v1/client/bootstrap` 的每个 `models` 项必须包含 `id`、`displayName`、正整数 `contextSize` 和非空 `protocols`：

```json
{
  "id": "example-model",
  "displayName": "示例模型",
  "contextSize": 128000,
  "protocols": ["openai_responses"]
}
```

`protocols` 的公开枚举严格为 `openai_responses`、`openai_chat`、`anthropic_messages`。它表示模型的静态配置能力，不表示渠道、密钥、熔断器或上游当前健康状况。客户端必须拒绝缺失、空数组或含未知值的条目，不能以模型 ID、厂商或 `models[0]` 推断协议。

### Gateway 模型目录与端点

`GET /gateway/v1/models` 返回 OpenAI 风格列表；每个项目必须有 `id`、`object`、`owned_by`、`display_name`、`context_size`、`protocols`：

```json
{
  "object": "list",
  "data": [{
    "id": "example-model",
    "object": "model",
    "owned_by": "ucli",
    "display_name": "示例模型",
    "context_size": 128000,
    "protocols": ["openai_responses"]
  }]
}
```

按能力选择模型及 Gateway 端点：

| 公开协议 | Gateway 端点 |
| --- | --- |
| `openai_responses` | `POST /gateway/v1/responses` |
| `openai_chat` | `POST /gateway/v1/chat/completions` |
| `anthropic_messages` | `POST /gateway/anthropic/v1/messages` |

Bootstrap 与 Gateway 目录对于同一可用模型必须给出一致的 `protocols`。如果所需协议筛选后没有模型，显示“没有兼容的服务端模型”；绝不回退到 `models[0]`。

### Gateway 路由失败

三种稳定路由失败都是 HTTP `503`，响应头必须有 `X-UCLI-Request-ID` 和 `Cache-Control: no-store`，JSON 响应体必须有 `statusCode`、`code`、`message`、`requestId`、`retryable`：

```json
{
  "statusCode": 503,
  "code": "model_protocol_unavailable",
  "message": "The model does not support the requested protocol",
  "requestId": "request-uuid",
  "retryable": false
}
```

| `code` | `message` | `retryable` | 客户端处理 |
| --- | --- | --- | --- |
| `model_protocol_unavailable` | `The model does not support the requested protocol` | `false` | 重新按能力筛选，不自动重试。 |
| `model_channel_unavailable` | `No model channel is currently available` | `true` | 可退避重试。 |
| `upstream_unavailable` | `No upstream channel succeeded` | `true` | 可退避重试。 |

三种失败都不是授权失效，不得清除已保存的服务端凭证。请求失败只降级服务端模型和相关服务端能力；独立模式、本地模型、已安装本地技能、本地数据和本地会话持续可用。

## 客户端实现

1. 解析 Bootstrap 与 Gateway 模型目录，并校验每个候选模型的 `protocols` 必填、非空且只含三种公开枚举值。缺失或未知值不得猜测兼容性。
2. 依据用户所选公开协议过滤模型，再以表中的固定 Gateway 端点发起请求。不得从模型 ID、模型厂商或 `models[0]` 推断协议；不得选择原生 `gemini` 协议。
3. 协议筛选结果为空时，保持现有本地模型选择并显示没有兼容模型，不发送猜测的 Gateway 请求。
4. 收到路由失败时按稳定 `code` 和 `retryable` 决策；始终保留独立模式、已有服务端凭证和本地能力。授权有效期到期才按既有设备授权合同处理，不把路由失败误报为授权失效。
5. 在断言流式响应成功、读取完整流或更新界面前，捕获经脱敏的 HTTP 诊断：状态码、`Content-Type`、`Cache-Control`、稳定 `code`、`requestId`、`retryable`。仅在收到非空流式数据后标记模型流成功。

## 测试矩阵

| 场景 | 断言 |
| --- | --- |
| 目录合同夹具 | 覆盖 `openai_responses`、`openai_chat`、`anthropic_messages`，以及缺失、空数组和未知协议值。 |
| Provider/模型选择 | Responses、Chat、Anthropic 均只选择声明相应能力的模型；Gemini 上游映射只能通过 `openai_chat` 选择。 |
| 无兼容模型 | 展示空状态，不使用 `models[0]`，不按模型 ID 或厂商猜测端点。 |
| 稳定 503 | 分别校验 `model_protocol_unavailable`、`model_channel_unavailable`、`upstream_unavailable` 的状态、字段、`X-UCLI-Request-ID`、`Cache-Control: no-store` 与 `retryable`。 |
| 在线模型流 | 使用声明所选协议的模型，先记录经脱敏的 HTTP 诊断，再断言收到非空数据；结束后执行清理。 |
| 独立模式与授权 | 三种路由失败均保留本地能力和服务端凭证；授权到期仍沿用设备授权的到期提示与恢复路径。 |

## 回传格式

```yaml
timestamp: null
clientVersion: null
clientCommit: null
serverCommit: null
serverRuntimeImage: null
localContractGate: null
selectedModelId: "not-selected"
selectedProtocol: "not-selected"
failedStage: null
httpStatus: "not-received"
contentType: "not-received"
cacheControl: "not-received"
stableCode: "not-received"
requestId: "not-received"
retryable: null
streamReceivedNonEmptyData: false
authorizationExpiresAt: "not-recorded"
serverTimePresent: false
skillsCatalog: "NOT_RUN"
skillDownloadHash: "NOT_RUN"
cleanup: "NOT_RUN"
```

填写回传时只使用经脱敏的诊断值。`selectedProtocol` 只能写 `openai_responses`、`openai_chat`、`anthropic_messages` 或默认值 `not-selected`；不得写 `gemini`。

## 禁止回传内容

禁止回传 Connection URL、fragment、token、Authorization/Cookie、供应商密钥、请求或响应正文、完整响应头、真实用户身份和完整堆栈跟踪。也不得回传任何可复原上述信息的截图、日志片段或编码文本。
