# UCLI 模型协议能力与 Gateway 错误分类设计

**状态：** 已确认

**日期：** 2026-08-28

**相关协议：** [`docs/ucli-client-protocol.md`](../../ucli-client-protocol.md)

**客户端交付物：** `docs/ucli-client-model-protocol-upgrade.md`

## 背景

UCLI 0.12.0 已通过授权预览、兑换、幂等兑换、刷新、Bootstrap 和模型列表联调，但在使用 `bootstrap.models[0]` 调用 `POST /gateway/v1/responses` 时失败。服务端日志确认该请求返回 503；同一时间窗口内 Responses 可用候选、配额拒绝和上游调用次数均为 0。

当前 Bootstrap 和 Gateway 模型列表只发布公共模型身份，不声明每个模型可接受的客户端协议。Gateway 实际按请求端点筛选模型映射：Responses 只接受 `OPENAI_RESPONSES`，而生产环境的三个已发布模型只配置了 `OPENAI_CHAT` 或 `ANTHROPIC_MESSAGES` 映射。因此模型“已发布”不等于它能处理任意 Gateway 端点，客户端也无法在调用前做出正确选择。

## 目标

- 让 UCLI 在调用 Gateway 前准确知道每个模型支持的客户端协议。
- Bootstrap 与 Gateway 模型列表使用同一能力计算规则。
- 区分“没有协议映射”“有映射但无健康候选”和“上游尝试失败”。
- 为每次路由失败返回可关联的稳定错误码和脱敏请求 ID。
- 生成由 UCLI 项目独立实施的客户端升级方案。
- 配置至少一个真实的 `OPENAI_RESPONSES` 路由后重新完成全链路 smoke。

## 非目标

- 不在本仓库修改 UCLI 客户端代码。
- 不把模型、通道、密钥的瞬时健康状态作为 Bootstrap 的实时服务发现机制。
- 不向客户端下发供应商地址、上游模型名、通道 ID、密钥 ID、成本或供应商密钥。
- 不自动读取、复制或迁移已有通道的供应商密钥。
- 不让 Gateway 在 Responses、Chat、Anthropic Messages 之间执行本期未实现的请求格式转换。
- 不保留依赖“任意模型都可调用 Responses”或默认选择 `models[0]` 的旧客户端行为。

## 方案选择

采用“模型目录内嵌协议能力”方案。Bootstrap 和 Gateway 模型列表直接在每个模型上返回 `protocols`，避免新增能力端点造成额外请求和目录状态漂移。

不采用以下方案：

- 不新增独立模型能力端点；模型身份与能力必须来自同一次目录读取。
- 不让客户端维护模型 ID 到协议的硬编码表；协议能力由平台配置决定。
- 不只为 smoke 固定一个 Responses 模型；这不能解决正常使用中的模型选择错误。

## 对外模型契约

### 客户端协议枚举

`protocols` 只允许以下小写字符串：

```text
openai_responses
openai_chat
anthropic_messages
gemini
```

数组按上述顺序稳定输出并去重。该枚举描述 UCLI 可以调用的 Gateway 协议，不直接等同于数据库中的上游协议。

### Bootstrap

`GET /api/v1/client/bootstrap` 的模型项变更为：

```json
{
  "id": "deepseek-v4-flash",
  "displayName": "DeepSeek V4 Flash",
  "contextSize": 128000,
  "protocols": ["openai_responses", "anthropic_messages"]
}
```

Bootstrap 继续只返回当前账号可访问、已启用、未删除且 `contextSize > 0` 的公共模型。没有任何客户端协议能力的模型不进入客户端目录。

### Gateway 模型列表

`GET /gateway/v1/models` 保留 OpenAI 风格的列表外壳，并为每项增加 UCLI 扩展字段：

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-flash",
      "object": "model",
      "owned_by": "ucli",
      "display_name": "DeepSeek V4 Flash",
      "context_size": 128000,
      "protocols": ["openai_responses", "anthropic_messages"]
    }
  ]
}
```

该端点与 Bootstrap 使用相同的访问控制、公共模型过滤和协议聚合规则。UCLI 可校验两处返回的模型 ID 与 `protocols` 一致；不一致视为服务端契约错误，不自行猜测。

## 协议能力计算

一个上游模型映射参与协议能力计算，必须同时满足：

- `PublicModel.enabled = true` 且 `PublicModel.deletedAt = null`；
- `ChannelModel.enabled = true` 且 `ChannelModel.deletedAt = null`；
- 关联 `Channel.enabled = true` 且 `Channel.deletedAt = null`；
- 关联通道至少存在一个 `ChannelKey.enabled = true` 且 `ChannelKey.deletedAt = null` 的密钥。

能力计算不检查以下瞬时条件：

- 模型映射、通道或密钥的 `health`；
- 密钥 `isolatedUntil`；
- 通道 `circuitOpenUntil`；
- 当前配额余额和限流状态；
- 当前时刻是否存在可解析的成本规则。

这样 `protocols` 表达稳定的已配置能力。瞬时健康、熔断、配额和成本仍在实际请求时判断，避免客户端模型目录随短时故障反复消失和出现。因认证失败被服务端禁用的密钥不再参与能力计算。

客户端协议按现有可路由关系从上游协议推导：

| 上游映射协议 | 对外客户端协议 |
| --- | --- |
| `OPENAI_RESPONSES` | `openai_responses` |
| `OPENAI_CHAT` | `openai_chat` |
| `ANTHROPIC_MESSAGES` | `anthropic_messages` |
| `GEMINI` | `gemini`、`openai_chat` |

`GEMINI` 同时提供 `openai_chat` 是因为当前 Gateway 已实现 Chat 到 Gemini 的转换。不存在的转换不得通过能力目录宣告。

协议聚合和稳定排序放入共享的 Gateway Core 纯函数；API 与 Gateway 各自查询目录数据，但必须调用同一纯函数，避免两处维护不同映射表。

## Gateway 路由失败契约

Gateway 在读取公共模型并通过访问控制后生成 `requestId`，立即设置响应头 `X-UCLI-Request-ID`。后续失败响应同时在 JSON 中返回同一个 ID：

```json
{
  "statusCode": 503,
  "code": "model_protocol_unavailable",
  "message": "The model does not support the requested protocol",
  "requestId": "uuid",
  "retryable": false
}
```

上述错误响应使用 `Content-Type: application/json; charset=utf-8` 和 `Cache-Control: no-store`。`retryable` 是服务端契约字段，客户端不得仅根据 HTTP 状态自行推断。

稳定错误分类如下：

| HTTP | `code` | 判定时机 | `retryable` |
| ---: | --- | --- | --- |
| 503 | `model_protocol_unavailable` | 模型存在且可访问，但配置能力中不含请求协议 | `false` |
| 503 | `model_channel_unavailable` | 配置能力包含请求协议，但候选筛选后为空 | `true` |
| 503 | `upstream_unavailable` | 至少发起一次上游尝试，但所有尝试失败 | `true` |

`message` 用于人类诊断，客户端控制流只依赖 `code`。已有的“模型不存在或无权访问”继续返回 404，不通过协议错误泄漏模型存在性。配额错误继续返回 429 及现有配额错误码，不归入上述三类。

### 判定边界

Gateway 先使用与目录相同的静态能力规则检查请求协议：

1. 请求协议不在静态能力中，返回 `model_protocol_unavailable`，不进入配额和上游阶段。
2. 请求协议存在，但健康、熔断、密钥隔离或成本解析导致候选为空，返回 `model_channel_unavailable`，不进入配额和上游阶段。
3. 候选存在且配额预留成功，调用上游；全部失败时返回 `upstream_unavailable`。

## 脱敏可观测性

三类 503 都写入结构化 Gateway 日志，字段限定为：

```text
event, requestId, organizationId, accountId, deviceId,
publicModelId, protocol, code, routeAttempts, timestamp
```

日志不得包含 access token、refresh token、授权令牌、供应商密钥、请求正文、响应正文或完整请求头。

Gateway 内部日志可以保存组织、账号和设备 UUID 以供授权范围内排障；向客户端或外部联调报告导出时必须将这些 ID 删除或做不可逆脱敏，只保留 `requestId` 作为双方关联键。

`model_protocol_unavailable` 和 `model_channel_unavailable` 没有具体通道，现有 `UsageLog` 又要求通道关联，因此本期不伪造 usage 记录；运维通过 Gateway 结构化日志确认这两类前置路由失败。`upstream_unavailable` 继续写 usage 和 route attempt 记录。后续如需统一分析，可单独设计允许空通道的请求事件表。

## UCLI 客户端升级边界

本仓库生成 `docs/ucli-client-model-protocol-upgrade.md`，由 UCLI 项目实施以下行为：

- Bootstrap 类型增加必填 `protocols`，拒绝未知协议值和缺失字段。
- 创建 Responses 配置或发起 Responses smoke 时，只从包含 `openai_responses` 的模型中选择。
- 创建 OpenAI Chat、Anthropic 或 Gemini 配置时，分别按对应协议筛选。
- 不再回退到 `models[0]`，也不根据模型名称或厂商猜测协议。
- 没有兼容模型时显示“服务端未配置该协议模型”，不清除连接凭证，不影响本地能力和其他可用服务端协议。
- 模型流请求在断言前记录 HTTP 状态、Content-Type、Cache-Control、稳定错误码、请求 ID、`retryable` 和是否收到非空流数据；不得记录响应正文中的敏感内容。
- smoke 在报告中记录所选模型 ID 与协议，并继续清理临时数据库、环境变量和 smoke 目录。

客户端项目完成升级后返回：客户端版本和提交、服务端提交和镜像、契约测试结果、各 smoke 阶段结果、所选模型与协议、失败时的脱敏 HTTP 诊断、授权有效期、服务端时间字段、技能安装或执行结果以及清理结果。

## 生产配置与部署

代码发布不会自动创建或修改供应商通道。部署后由平台管理员通过管理后台创建独立的 Responses 通道：

- 协议映射选择 `OPENAI_RESPONSES`；
- 使用供应商 Responses API 对应的 base URL，不复用带 `/anthropic` 的 Anthropic Messages base URL；
- 管理员重新输入供应商密钥，不从数据库或现有通道提取秘密；
- 为目标公共模型创建 Responses 映射、有效价格和健康探测配置；
- 通道测试通过后再启用映射和公共模型。

本设计不强制供应商或模型 ID。生产验收只要求至少一个当前账号可访问的模型声明 `openai_responses`，并能完成非空流式响应。

## 测试与验收

### 服务端自动化测试

- 纯函数测试覆盖四种上游协议到客户端协议的映射、去重和稳定顺序。
- Bootstrap 测试覆盖启用/删除状态、有效 context size、访问策略、映射、通道和密钥过滤。
- 测试证明 `UNHEALTHY`、隔离和熔断不会移除静态 `protocols`，禁用密钥会移除对应能力。
- Gateway 模型列表与 Bootstrap 对相同输入返回一致的模型 ID 和协议集合。
- Gateway 路由测试分别覆盖三个 503 稳定错误码、HTTP 状态、`retryable`、请求 ID 响应头和 JSON 字段。
- 测试证明协议不兼容和无健康候选不会执行配额预留或上游调用。
- 测试证明上游失败仍写 usage/route attempt，而前置路由失败只写脱敏 Gateway 日志。
- 协议文档契约测试解析示例 JSON，并断言必填 `protocols` 和错误码存在。

### 线上验收顺序

1. 部署服务端代码并确认健康检查通过。
2. 管理员创建并测试独立 Responses 通道和映射。
3. 使用管理员测试接口验证目标映射可返回非空响应。
4. 使用设备 access token 验证 Bootstrap 和 Gateway 模型列表能力一致。
5. 向 UCLI 项目交付客户端升级文档并等待其实施结果。
6. 客户端升级完成后创建一条新的设备授权链接；已消费链接不得复用。
7. 重新执行 preview、redeem、幂等 redeem、refresh、bootstrap、models、model stream、skills catalog、技能下载或执行以及 cleanup 全链路 smoke。
8. 结合客户端 request ID、Gateway 结构化日志和 usage/route attempt 完成最终验收。

## 安全与兼容约束

- 模型协议能力不包含供应商秘密或内部路由标识。
- 错误响应不泄漏无权访问的模型、通道或密钥是否存在。
- 请求 ID 是随机 UUID，不编码账号、设备、模型或时间信息。
- UCLI 的独立模式和本地能力降级规则保持不变。
- 本次不为缺失 `protocols` 的旧客户端提供默认协议；服务端与 UCLI 按联合发布和联调顺序升级。
- 已绑定授权的有效期、禁用、删除和刷新语义不变；模型能力升级不重新生成或延长授权。
