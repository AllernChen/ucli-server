# UCLI 桌面端接入协议 v1

**实施归属：** UCLI 客户端代码在独立的 UCLI 客户端仓库实现。本文件是该仓库的完整服务端接入契约。

**服务端基线：** UCLI Server `0.3.0`，设备授权链接扩展合并提交 `4f71d6efdfe2504b8f72da53e1647c226bb8ff1f`，2026-08-27 已部署并验证。

**当前内网环境：** 控制面 `http://10.44.100.100`，模型网关 `http://10.44.100.100/gateway`。HTTP 是本次公司可信内网部署的既定配置；客户端不得把该信任假设扩展到公网或其他不可信网络。

**兼容性：** 客户端只实现本文的 `#link=` 协议，不保留旧邀请、设备码、旧 token fragment 或 query 传递秘密的兼容路径。

## 独立模式与单服务端

UCLI 可独立安装、独立使用。未注册、服务端不可达或授权失效时，本地模型、已安装本地技能、本地数据和本地会话持续可用；仅服务端模型、服务端技能同步和后续服务端能力降级。

设置只维护一个当前服务端连接。新连接必须先 preview 和 redeem 成功，之后才替换旧连接；失败不得删除旧连接或本地数据。断开只删除本机服务端凭证和连接元数据，不删除服务端设备或授权。

## 浏览器链接和秘密边界

管理端创建、查看或重新生成设备授权 URL 的 `connectionUrl` 响应是链接秘密的受控输出，绝不返回裸链接秘密字段；对应的 Vue 弹窗仅短暂保存并展示完整连接链接。关闭只会清除当前页面 DOM 中的 URL 副本；只要当前链接未撤销、未使用且授权可用，管理员仍可再次查看当前 URL 恢复副本。示例：

### 创建响应

```json
{
  "id": "grant-uuid",
  "connectionUrl": "http://10.44.100.100/connect#link=one-time-link-secret",
  "expiresAt": null
}
```

连接链接必须使用 UCLI 可访问的一个 HTTP(S) 服务端 origin；当前环境为 `http://10.44.100.100/connect#link=<secret>`。浏览器只解析 fragment 的 `link` 键，拒绝旧 token fragment 和所有 query 参数；读取后立即以 `history.replaceState` 清除 fragment。fragment 不会进入 HTTP 请求 URL 或常规访问日志。

确认后，页面使用规范化 origin 唤起：

```text
ucli://connect?server=http%3A%2F%2F10.44.100.100#link=<secret>
```

协议处理器和设置页粘贴链接都只接受 HTTP(S) origin 与 `#link=` fragment，拒绝用户信息、路径注入和其他协议，并先打开确认页；未确认不得 redeem。页面显示服务端、组织、用户、URL 状态、URL 有效期、授权状态、授权有效期和服务器时间。

链接秘密仅在从 fragment 发起 preview/redeem、同一 installationId 的 10 分钟重试，或管理端当前 URL 恢复响应时存在内存。弹窗关闭、创建失败、切换用户、确认页关闭、注册失败、注册成功、取消、断开或卸载时清空当前页面副本。浏览器跳转至 `ucli://` 后和组件卸载时也清空。管理端清空页面副本不撤销服务端当前链接，授权管理员之后仍可再次查看恢复。链接秘密不得进入 DOM 隐藏字段、URL query、请求路径、日志、异常、审计、storage、遥测、崩溃报告或最近打开记录；`secretHash` 与 refresh token 哈希永不展示。

URL 默认有效 7 天，也可由管理员单独设置为其他未来时间或永久；设备授权默认永久，也可单独设置或延期。重新生成 URL 只轮换当前 URL，不新建授权、不改变用户或设备，并立即撤销旧 URL。禁用或删除授权会撤销并清除当前 URL；之后重新启用授权不会复活旧 URL。授权绑定设备后 URL 被消费，不能查看、兑换或重新生成。UCLI 不调用这些管理端操作，只按公开 Preview/Redeem 结果处理。

## Preview

### Preview HTTP

```http
POST /api/v1/auth/device-grants/preview
Content-Type: application/json
```

### Preview 请求

```json
{"link":"<secret>"}
```

### Preview 响应

```json
{
  "account": { "id": "account-uuid", "displayName": "成员姓名" },
  "organization": { "id": "organization-uuid", "name": "组织名称" },
  "link": { "status": "AVAILABLE", "expiresAt": "2026-09-02T04:00:00.000Z" },
  "authorization": { "status": "AVAILABLE", "expiresAt": null, "serverTime": "2026-08-27T04:00:00.000Z" }
}
```

服务端响应头 `Cache-Control: no-store`；Preview 不消费链接。`link.expiresAt` 是 URL 到期时间，`authorization.expiresAt` 是设备授权到期时间，二者独立；`null` 表示永久有效。保留服务端返回的 `authorization.serverTime`，客户端据此校正本机时间。只有 `link.status` 与 `authorization.status` 都是 `AVAILABLE` 才可确认注册。

`link.status` 为 `AVAILABLE`、`EXPIRED`、`REVOKED` 或 `CONSUMED`；`authorization.status` 为 `AVAILABLE`、`BOUND`、`DISABLED`、`EXPIRED` 或 `DELETED`。

## Redeem

`installationId` 必须是持久化 UUID v4；`name` 为去空格后的 1–120 字符；`platform` 仅允许 `windows`、`macos`、`linux`；`clientVersion` 为 1–32 字符。不符合约束返回 `invalid_device`。

### Redeem HTTP

```http
POST /api/v1/auth/device-grants/redeem
Content-Type: application/json
```

### Redeem 请求

```json
{
  "link": "<secret>",
  "device": {
    "installationId": "550e8400-e29b-41d4-a716-446655440000",
    "name": "张三的工作站",
    "platform": "windows",
    "clientVersion": "1.2.0"
  }
}
```

### Redeem 响应

```json
{
  "accessToken": "jwt",
  "refreshToken": "opaque-refresh-token",
  "expiresIn": 900,
  "account": { "id": "account-uuid", "displayName": "成员姓名" },
  "organization": { "id": "organization-uuid", "name": "组织名称" },
  "authorization": { "expiresAt": null, "serverTime": "2026-08-27T04:00:00.000Z" }
}
```

服务端响应头 `Cache-Control: no-store`。首次兑换绑定设备。同一 installationId 可在首次绑定后 10 分钟内用同一链接秘密重试，以恢复丢失的响应；该重试轮换 refresh token 并重新返回凭证。其他 installationId、超出重试窗口或已消费链接均返回 `link_consumed`。成功后先将 refresh token 写入操作系统安全存储，再删除内存和普通配置中的链接秘密；access token 只保留运行时内存。

## 刷新与启动配置

refresh token 为单次使用凭证。客户端先原子替换操作系统安全存储中的 refresh token，再更新连接配置；服务端每次成功刷新都轮换 refresh token。

### Refresh HTTP

```http
POST /api/v1/auth/token/refresh
Content-Type: application/json
```

### Refresh 请求

```json
{"refreshToken":"opaque-refresh-token"}
```

### Refresh 响应

```json
{
  "accessToken": "jwt",
  "refreshToken": "next-opaque-refresh-token",
  "expiresIn": 900,
  "authorization": { "expiresAt": null, "serverTime": "2026-08-27T04:00:00.000Z" }
}
```

### Refresh 响应头

```http
Cache-Control: no-store
```

Refresh 的成功和错误响应都带 `Cache-Control: no-store`。客户端必须在解析或持久化任何响应内容前验证该响应头；缺失时按不可信响应 fail closed，但保留现有本地能力。

### Bootstrap HTTP

```http
GET /api/v1/client/bootstrap
Authorization: Bearer <accessToken>
```

### Bootstrap 响应

```json
{
  "organization": { "id": "organization-uuid", "name": "组织名称", "timezone": "Asia/Shanghai" },
  "gateway": { "baseUrl": "http://10.44.100.100/gateway" },
  "models": [{
    "id": "example-model",
    "displayName": "示例模型",
    "contextSize": 128000,
    "protocols": ["openai_responses"]
  }],
  "skillsCatalogUrl": "http://10.44.100.100/api/v1/skills/catalog",
  "authorization": { "expiresAt": null, "serverTime": "2026-08-27T04:00:00.000Z" }
}
```

`models` 只包含已发布且 `contextSize` 为正整数的公共模型；草稿或历史上缺少有效上下文长度的目录项不会下发。客户端仍应按正整数校验该字段，协议不提供 `null` 或默认值兼容。每个模型的 `protocols` 是必填的非空数组，表示该模型静态配置完成、可由 Gateway 调用的协议能力；它不是渠道、密钥、熔断或上游的瞬时健康状态。

公开协议枚举固定为 `openai_responses`、`openai_chat`、`anthropic_messages`。`GEMINI` 是服务端内部上游/转换协议，仅贡献 `openai_chat`，UCLI 不得把 `gemini` 当作可选择的 Gateway 协议或调用原生 Gemini 端点。客户端必须按所需协议筛选模型和端点，绝不能从模型 ID、厂商或 `models[0]` 推断协议。

redeem、refresh 和 bootstrap 都同步 `authorization.expiresAt` 与 `authorization.serverTime`。客户端使用授权有效期（不是 URL 有效期）在临近到期及到期后显示具体时间，并提示联系管理员延期。

## 稳定错误与能力降级

`grant_bound` 只适用于管理端 `POST /api/v1/admin/device-grants/:id/links`，表示稳定授权已经绑定设备，不能再生成连接 URL。对于已消费链接，公开 Preview/Redeem 则返回 `link_consumed`；同一 installationId 在 10 分钟窗口内的幂等 Redeem 除外。两者不得互换或保留旧别名。

Preview/Redeem 的稳定业务错误使用 HTTP `400`，响应体至少包含 `{ "code": "<错误码>" }`。Refresh、Bootstrap、技能和网关鉴权失败使用 HTTP `401`；授权生命周期错误响应体为 `{ "code": "<错误码>", "message": "<英文说明>" }`。客户端必须按 `code` 分支，不得依赖 `message` 文案。网络失败、超时和 HTTP `5xx` 属于可重试故障，不等价于任何授权状态。

| 错误码 | UCLI 行为 |
| --- | --- |
| `invalid_link` | 链接秘密无效；保留当前连接，并提示联系管理员创建新的授权链接。 |
| `link_expired` | URL 已到期；提示联系管理员创建新的授权链接。 |
| `link_revoked` | URL 已被撤销；提示联系管理员创建新的授权链接。 |
| `link_consumed` | URL 已使用或重试窗口结束；提示联系管理员创建新的授权链接。 |
| `grant_disabled` | 停用服务端能力，提示联系管理员启用。 |
| `grant_expired` | 停用服务端能力，显示授权有效期并提示联系管理员延期。 |
| `grant_bound` | 管理端重新生成被拒：授权已绑定设备，不能再生成 URL。 |
| `grant_deleted` | 停用服务端能力，要求新的授权链接。 |
| `account_inactive` | 停用服务端能力，提示账号或当前组织成员关系不可用。 |
| `organization_inactive` | 停用服务端能力，提示组织不可用。 |
| `invalid_device` | 清除失效设备凭证，要求新的授权链接。 |

网络不可达可恢复且不清除凭证，不得误报为授权删除。所有服务端错误只停用服务端能力，不影响本地模型、已安装本地技能、本地会话或本地数据。

## 网关与技能

Bootstrap 返回的 `gateway.baseUrl` 是网关基址。当前环境以 Bearer access token 调用 `GET /gateway/v1/models`、`POST /gateway/v1/responses`、`POST /gateway/v1/chat/completions`；Anthropic 兼容接口为 `POST /gateway/anthropic/v1/messages`，支持 Bearer，也允许兼容客户端通过 `x-api-key` 传入同一设备 access token。供应商 Key 永不下发。

### Gateway 模型列表 HTTP

```http
GET /gateway/v1/models
Authorization: Bearer <accessToken>
```

### Gateway 模型列表响应

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

Gateway 模型项中的 `display_name`、`context_size` 和 `protocols` 是与 Bootstrap 相同模型目录的扩展字段。客户端必须校验 `protocols` 存在、非空且每一项都属于公开协议枚举；缺失、空数组或未知值都不是可猜测的兼容情形。用相应协议筛选后的模型列表为空时，显示该协议当前没有兼容的服务端模型，不能回退到 `models[0]`、模型 ID 或厂商推断的端点。

### Gateway 路由错误响应

```json
{
  "statusCode": 503,
  "code": "model_protocol_unavailable",
  "message": "The model does not support the requested protocol",
  "requestId": "request-uuid",
  "retryable": false
}
```

所有 Gateway 路由失败均返回 HTTP `503`、`Content-Type: application/json`、`X-UCLI-Request-ID` 和 `Cache-Control: no-store`。响应体总是包含 `statusCode`、`code`、`message`、`requestId`、`retryable`：

| `code` | `message` | `retryable` | UCLI 处理 |
| --- | --- | --- | --- |
| `model_protocol_unavailable` | `The model does not support the requested protocol` | `false` | 这是选择错误：重新按 `protocols` 筛选模型；不自动重试，不清除本地凭证。 |
| `model_channel_unavailable` | `No model channel is currently available` | `true` | 模型有该静态能力但暂时无可路由渠道；可按退避重试，不清除本地凭证。 |
| `upstream_unavailable` | `No upstream channel succeeded` | `true` | 兼容渠道均未成功；可按退避重试，不清除本地凭证。 |

在验证流式响应成功之前，客户端先记录经脱敏的 HTTP 状态、`Content-Type`、`Cache-Control`、稳定 `code`、`requestId` 和 `retryable`。无论三种路由失败中的哪一种，都只降级服务端模型与相关服务端能力；独立模式、本地模型、已安装本地技能、本地数据、本地会话和现有凭证必须保持不变。

以 Bearer access token 请求 Bootstrap 返回的 `skillsCatalogUrl`。`GET /api/v1/skills/catalog?cursor=<ISO时间>` 每次最多按 `createdAt` 升序返回 100 个当前组织可见的已发布不可变版本；客户端以最后一个 `createdAt` 作为下一次 cursor。每项包含 `id`、`version`、`sha256`、`sizeBytes`、`publishedAt`、`createdAt`、`skill.slug/name/description` 与 `downloadUrl`。下载也必须携带 Bearer token，并同时校验响应头 `x-ucli-sha256`、目录中的 `sha256` 和实际 ZIP 内容摘要。

`GET /api/v1/skills/revocations` 返回当前组织可见、状态为 `REVOKED` 或 `DEPRECATED` 的版本。服务端技能同步失败只标记服务端同步异常，不得删除或破坏用户已有的本地技能与本地数据。
