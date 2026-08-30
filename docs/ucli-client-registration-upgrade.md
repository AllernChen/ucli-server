# UCLI 客户端服务端接入升级实施文档

## 1. 交付信息

本文直接交付 UCLI 客户端升级开发，内容自包含，不依赖 UCLI Server 仓库中的相对链接。

| 项目 | 值 |
| --- | --- |
| 客户端实施归属 | 独立的 UCLI 客户端仓库 |
| 服务端版本 | UCLI Server `0.3.1` + 设备授权链接扩展 |
| 服务端合并提交 | `aa748c4b7488302507346f86e6a2f51ccbba0c10` |
| 部署验证日期 | 2026-08-30 |
| 控制面/API | `http://10.44.100.100` |
| 模型网关 | `http://10.44.100.100/gateway` |
| 网络边界 | 公司可信内网，当前明确使用 HTTP |
| 兼容要求 | 不兼容旧邀请、设备码、旧 token fragment 和 query 传密 |

服务端部分已部署完成。本次由 UCLI 客户端单独实施协议处理、设置界面、设备注册、凭据轮换、授权提醒以及服务端模型/技能能力接入。

## 2. 产品边界

UCLI 必须保持独立安装、独立使用。用户不注册服务端时，本地模型、已安装本地技能、本地数据和本地会话仍然可用。在设置中注册到服务端后，才增加服务端模型、服务端技能和后续服务端能力。

客户端只维护一个当前服务端连接。连接新服务端必须先完成 Preview 和 Redeem，且安全保存新凭据后，才能替换旧连接；任何解析失败、用户取消、网络失败、服务端拒绝或安全存储失败都保留旧连接和本地数据。断开连接只删除本机的服务端凭据与连接元数据，不删除服务端设备或授权。

平台管理员预先创建用户，再为用户的每台设备分别创建一个授权。一个授权只绑定一台设备；一个用户可以拥有多个授权并绑定多台设备。UCLI 客户端不实现用户注册、账号密码登录或管理员授权管理。

## 3. 必须实现的入口

客户端必须让下列三个入口汇合到同一套“解析 → Preview → 用户确认 → Redeem”流程：

1. 浏览器授权页点击“连接 UCLI”，操作系统启动 `ucli://` 协议处理器。
2. 用户在 UCLI 设置中粘贴完整的浏览器授权 URL。
3. 用户在 UCLI 设置中粘贴浏览器页复制出的 `ucli://` 连接地址。

当前生产浏览器 URL：

```text
http://10.44.100.100/connect#link=<secret>
```

浏览器唤起 UCLI 的地址：

```text
ucli://connect?server=http%3A%2F%2F10.44.100.100#link=<secret>
```

解析要求：

- 浏览器 URL 只接受 HTTP(S)、`/connect` 路径和 fragment 中的 `link`。
- `ucli://` 只接受 `ucli://connect`、query 中的 `server` 和 fragment 中的 `link`。
- `server` 必须能规范化为不带用户名、密码、路径、query 或 fragment 的 HTTP(S) origin。
- 拒绝旧 token fragment、query 传密、其他协议、用户信息和路径注入。
- `link` 是区分大小写的不透明字符串；不得解码后重组、截断或自行派生。
- 当前只连接一个服务端，不因收到新链接提前清除当前连接。

浏览器授权页已经做过一次 Preview，但 UCLI 被唤起后仍必须重新 Preview。链接可能在浏览器确认与客户端兑换之间到期、被撤销、被重新生成或被其他设备使用。

## 4. 客户端注册状态机

| 状态 | 进入条件 | 允许动作 |
| --- | --- | --- |
| `STANDALONE` | 从未连接或用户主动断开 | 本地能力；可开始注册 |
| `CONNECTED` | 已有可用连接 | 本地及服务端能力；可连接新服务端 |
| `PREVIEWING` | 已解析新链接 | 请求 Preview；旧连接保持不变 |
| `AWAITING_CONFIRMATION` | 两个状态均为 `AVAILABLE` | 展示服务端、组织、用户和两类有效期 |
| `REDEEMING` | 用户明确确认 | 使用稳定 installationId 兑换 |
| `COMMITTING` | Redeem 成功 | 原子写入安全存储及连接配置 |
| `SERVER_UNREACHABLE` | 网络失败、超时或 HTTP `5xx` | 保留凭据并重试；本地能力正常 |
| `AUTH_EXPIRING` | 设备授权临近到期 | 服务端能力仍可用；提醒联系管理员 |
| `SERVER_CAPABILITIES_DISABLED` | 授权或主体不可用 | 停用服务端能力；本地能力正常 |

注册事务必须遵守以下顺序：

1. 解析输入，只在内存中保留 `serverOrigin` 和链接秘密。
2. 调用 Preview；失败时按稳定错误码显示结果，旧连接不变。
3. 展示服务端、组织、用户、URL 状态/有效期、授权状态/有效期和服务器时间。
4. 只有 `link.status` 与 `authorization.status` 都为 `AVAILABLE`，才允许用户确认。
5. 使用本安装持久化的 installationId 调用 Redeem；同一次操作禁止并发重复提交。
6. Redeem 成功后，先把 refresh token 原子写入操作系统安全存储，再原子提交普通连接配置。
7. 新连接提交成功后才移除旧连接凭据；access token 仅保留在当前进程内存。
8. 清除所有内存、界面和导航记录中的链接秘密，然后调用 Bootstrap。
9. Bootstrap 成功后启用服务端模型和技能同步；失败时按网络或授权状态降级，不影响本地能力。

若 Redeem 已成功但本机安全存储写入失败，不得提交半成品连接，也不得丢弃旧连接。只要仍在首次绑定后的 10 分钟内，使用同一 installationId 和仍在内存中的相同链接秘密重试 Redeem，以取得新的 refresh token；不得生成新的 installationId。

## 5. 本机数据模型与凭据边界

安装时生成一个 UUID v4 `installationId` 并跨启动持久化。断开服务端、注册失败或普通升级都不应重置它；重新安装或明确清除应用数据才产生新的 installationId。

普通配置可保存：

- 当前服务端 origin；
- installationId、设备显示名、平台和客户端版本；
- 账号与组织的非敏感摘要；
- 最后同步的 `authorization.expiresAt`、`authorization.serverTime` 与本机同步时刻；
- 服务端能力状态及提醒记录。

操作系统安全存储只保存当前连接的 refresh token。access token 只存在运行时内存，默认有效 `900` 秒。每次 Refresh 都轮换 refresh token；客户端必须先原子替换安全存储中的值，再更新其他连接状态。

链接秘密禁止进入普通配置、操作系统安全存储、数据库、日志、异常、审计、遥测、崩溃报告、剪贴板历史管理、最近打开记录或隐藏 DOM。注册完成、取消、失败、确认页关闭、切换用户、断开或卸载时清空。诊断信息只能记录服务端 origin、阶段、HTTP 状态和稳定错误码，不能记录完整请求体、完整 URL 或 Authorization 头。

## 6. API 契约

除特别说明外，所有请求和响应使用 JSON。下面的相对路径均以 `http://10.44.100.100` 为基址。

### 6.1 Preview：不消费链接

```http
POST /api/v1/auth/device-grants/preview
Content-Type: application/json
```

```json
{"link":"<secret>"}
```

成功为 HTTP `200`，并带 `Cache-Control: no-store`：

```json
{
  "account": { "id": "account-uuid", "displayName": "成员姓名" },
  "organization": { "id": "organization-uuid", "name": "组织名称" },
  "link": { "status": "AVAILABLE", "expiresAt": "2026-09-02T04:00:00.000Z" },
  "authorization": {
    "status": "AVAILABLE",
    "expiresAt": null,
    "serverTime": "2026-08-27T04:00:00.000Z"
  }
}
```

`link.status` 可能为 `AVAILABLE`、`EXPIRED`、`REVOKED`、`CONSUMED`。`authorization.status` 可能为 `AVAILABLE`、`BOUND`、`DISABLED`、`EXPIRED`、`DELETED`。日期均为 ISO 8601 UTC 字符串；`expiresAt: null` 表示永久有效。

### 6.2 Redeem：绑定当前设备

```http
POST /api/v1/auth/device-grants/redeem
Content-Type: application/json
```

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

字段约束：

- `installationId`：UUID v4。
- `name`：去除首尾空格后 1–120 字符。
- `platform`：仅 `windows`、`macos`、`linux`。
- `clientVersion`：1–32 字符。

成功为 HTTP `200`，并带 `Cache-Control: no-store`：

```json
{
  "accessToken": "jwt",
  "refreshToken": "opaque-refresh-token",
  "expiresIn": 900,
  "account": { "id": "account-uuid", "displayName": "成员姓名" },
  "organization": { "id": "organization-uuid", "name": "组织名称" },
  "authorization": {
    "expiresAt": null,
    "serverTime": "2026-08-27T04:00:00.000Z"
  }
}
```

首次成功 Redeem 会绑定设备并消费 URL。同一 installationId 可在首次绑定后的 10 分钟内使用相同链接秘密幂等重试；服务端会轮换 refresh token 并返回新凭据。不同 installationId、超过窗口或已消费链接返回 `link_consumed`。

### 6.3 Refresh：轮换设备凭据

```http
POST /api/v1/auth/token/refresh
Content-Type: application/json
```

```json
{"refreshToken":"opaque-refresh-token"}
```

```json
{
  "accessToken": "jwt",
  "refreshToken": "next-opaque-refresh-token",
  "expiresIn": 900,
  "authorization": {
    "expiresAt": null,
    "serverTime": "2026-08-27T04:00:00.000Z"
  }
}
```

refresh token 单次使用。收到成功响应后不要再使用旧 token。若安全存储暂时写入失败，在进程仍存活时保留新 token 于受控内存并重试本地写入，期间暂停新的 Refresh；不能把旧 token 回写为当前值。

Refresh 的成功和错误响应都带 `Cache-Control: no-store`。客户端继续在读取状态码对应的业务内容、解析 JSON 或持久化新 refresh token 前验证该响应头；缺失时必须 fail closed，保留本地能力并把服务端连接标记为协议错误，不得放宽校验。

### 6.4 Bootstrap：取得服务端能力

```http
GET /api/v1/client/bootstrap
Authorization: Bearer <accessToken>
```

```json
{
  "organization": {
    "id": "organization-uuid",
    "name": "组织名称",
    "timezone": "Asia/Shanghai"
  },
  "gateway": { "baseUrl": "http://10.44.100.100/gateway" },
  "models": [
    { "id": "example-model", "displayName": "示例模型", "contextSize": 128000 }
  ],
  "skillsCatalogUrl": "http://10.44.100.100/api/v1/skills/catalog",
  "authorization": {
    "expiresAt": null,
    "serverTime": "2026-08-27T04:00:00.000Z"
  }
}
```

`models` 只包含已发布且 `contextSize` 为正整数的公共模型；缺少有效上下文长度的历史目录项不会下发。UCLI 保持严格校验，不为 `null` 或缺失值增加兼容默认值。

客户端不得自行拼装或缓存永久网关地址，应以最近一次 Bootstrap 返回值为准。每次成功 Redeem、Refresh 和 Bootstrap 都更新授权有效期与服务器时间。

## 7. URL 有效期与设备授权有效期

这两类时间必须独立处理：

| 字段 | 含义 | 客户端用途 |
| --- | --- | --- |
| `link.expiresAt` | 当前连接 URL 的有效期；默认 7 天，可由管理员单独设置 | 仅判断注册入口能否继续，不做长期提醒 |
| `authorization.expiresAt` | 设备绑定后的服务端授权有效期；默认永久，可由管理员延期 | 决定服务端能力是否可用，并驱动到期提醒 |
| `authorization.serverTime` | 服务端生成响应时的时间 | 校正本机时间偏差 |

管理员关闭 URL 弹窗只清除页面副本，当前 URL 未撤销、未使用且授权可用时仍可再次查看找回。重新生成 URL 只轮换 URL，不创建新授权、不改变用户或设备，并立即撤销旧 URL。授权一旦绑定设备，URL 被消费且不能再重新生成。

管理员禁用或删除授权时，当前 URL 同时失效；重新启用授权不会复活旧 URL。客户端只需依据 Preview/Redeem 的稳定错误码处理，不调用任何管理端接口。

授权到期提醒使用 `authorization.expiresAt`，绝不使用 URL 有效期。建议在到期前 7 天、3 天、1 天和当天各提醒一次，文案显示具体到期时间并提示“请联系管理员延长授权”。授权延期后重新计算提醒；改为永久授权后清除未触发提醒。

本机时间校正建议保存：

```text
serverOffset = authorization.serverTime - receivedLocalTime
estimatedServerNow = currentLocalTime + serverOffset
remaining = authorization.expiresAt - estimatedServerNow
```

## 8. 稳定错误与客户端动作

Preview/Redeem 的业务错误为 HTTP `400`，响应体至少包含：

```json
{"code":"link_expired"}
```

Refresh、Bootstrap、技能和网关的授权生命周期错误为 HTTP `401`：

```json
{"code":"grant_expired","message":"Device grant has expired"}
```

必须按 `code` 处理，不依赖英文 `message`。网络错误、超时和 HTTP `5xx` 没有授权语义，统一视为可恢复的“服务端不可达”。

| 错误码 | 常见阶段 | 客户端动作 |
| --- | --- | --- |
| `invalid_link` | Preview/Redeem | 链接无效；保留当前连接，提示管理员提供新的授权链接 |
| `link_expired` | Preview/Redeem | URL 已过期；保留当前连接，提示管理员创建新 URL |
| `link_revoked` | Preview/Redeem | URL 已撤销；保留当前连接，提示管理员创建新 URL |
| `link_consumed` | Preview/Redeem | URL 已使用或重试窗口结束；保留当前连接，提示管理员创建新授权 |
| `invalid_device` | Redeem/Refresh/Bootstrap | 注册输入不合法时修正输入；已连接设备失效时清除该服务端凭据并要求新授权 |
| `invalid_grant` | Refresh/Bootstrap | 当前设备没有有效授权；停用并清除该服务端连接，要求新授权 |
| `grant_disabled` | Preview/Redeem/Refresh/Bootstrap | 停用服务端能力，保留连接元数据，提示联系管理员启用 |
| `grant_expired` | Preview/Redeem/Refresh/Bootstrap | 停用服务端能力，显示授权到期时间，提示联系管理员延期 |
| `grant_deleted` | Preview/Redeem/Refresh/Bootstrap | 停用并清除该服务端凭据，要求新授权 |
| `account_inactive` | Preview/Redeem/Refresh/Bootstrap | 停用服务端能力，提示账号或组织成员关系不可用 |
| `organization_inactive` | Preview/Redeem/Refresh/Bootstrap | 停用服务端能力，提示组织不可用 |

`grant_bound` 是管理端重新生成 URL 时使用的错误，UCLI 的公开 Preview/Redeem 不应收到它；公开接口对已消费 URL 返回 `link_consumed`。客户端不要兼容旧的绑定错误别名。

所有错误状态只影响服务端模型、服务端技能同步和后续服务端能力。不得删除本地模型、已安装本地技能、本地会话或本地数据，也不得阻止 UCLI 在独立模式启动。

## 9. 模型网关接入

使用 Bootstrap 返回的 `gateway.baseUrl` 与当前 access token：

| 能力 | 当前完整地址 | 鉴权 |
| --- | --- | --- |
| 模型列表 | `GET http://10.44.100.100/gateway/v1/models` | `Authorization: Bearer <accessToken>` |
| OpenAI Responses | `POST http://10.44.100.100/gateway/v1/responses` | Bearer |
| OpenAI Chat Completions | `POST http://10.44.100.100/gateway/v1/chat/completions` | Bearer |
| Anthropic Messages | `POST http://10.44.100.100/gateway/anthropic/v1/messages` | Bearer；兼容客户端可用 `x-api-key` 传同一设备 token |

`GET /v1/models` 返回 OpenAI 风格的 `{ "object": "list", "data": [...] }`。Bootstrap 中的 `models` 是当前账号可用模型的展示元数据；模型请求使用其中的 `id`。供应商 API Key 永远不会下发到客户端。

流式请求必须沿用对应 OpenAI/Anthropic 协议的取消与错误处理。收到授权生命周期 `401` 时进入第 8 节的服务端能力降级；单个上游模型失败不能误判为设备授权失效。

## 10. 服务端技能同步

所有技能接口都使用 Bearer access token。

1. 请求 Bootstrap 返回的 `skillsCatalogUrl`；首次不带 cursor。
2. 目录每页最多 100 项，按 `createdAt` 升序；以最后一项的 `createdAt` 请求下一页：`?cursor=<ISO时间>`。
3. 每项包含 `id`、`version`、`sha256`、`sizeBytes`、`publishedAt`、`createdAt`、`skill.slug/name/description` 和 `downloadUrl`。
4. 下载 `downloadUrl` 时仍携带 Bearer token。
5. 同时校验目录 `sha256`、响应头 `x-ucli-sha256` 和实际 ZIP 的 SHA-256；不一致时拒绝安装。
6. 请求 `GET http://10.44.100.100/api/v1/skills/revocations`，处理 `REVOKED` 和 `DEPRECATED` 版本。

服务端技能与本地技能必须分层存储或至少带来源标识。服务端同步失败、授权失效或服务端不可达不得删除、覆盖或禁用用户自行安装的本地技能。

## 11. 验收用例

### 11.1 注册流程

- 未配置服务端时 UCLI 可正常启动和使用全部本地能力。
- 浏览器 URL、`ucli://` 和设置页粘贴均进入同一确认流程。
- UCLI 会重新 Preview，并展示服务端、组织、用户、URL 有效期和授权有效期。
- 用户取消、Preview 失败和 Redeem 失败均不改变已有连接。
- Redeem 成功后设备出现在平台对应用户下；同一授权不能绑定第二台设备。
- 同一用户使用两个不同授权可绑定两台设备。
- 连接新服务端只有在新 refresh token 安全落盘后才替换旧连接。

### 11.2 幂等与并发

- Redeem 响应丢失后，以同一 installationId 和同一链接在 10 分钟内重试成功。
- 同一链接换 installationId、超过 10 分钟或被其他设备抢先消费时返回 `link_consumed`。
- 双击确认或并发提交只产生一个客户端注册事务。
- 注册失败不会生成新的 installationId。

### 11.3 安全

- 拒绝旧 token fragment、query 传密、非 HTTP(S) server、带凭据 origin 和路径注入。
- 浏览器或客户端读取 fragment 后，地址栏/导航历史不再包含秘密。
- 日志、配置、安全存储、遥测、异常和崩溃报告中搜索不到链接秘密、refresh token 或 access token。
- refresh token 只存在操作系统安全存储；access token 只存在运行时内存。
- 技能 ZIP 的 SHA-256 不匹配时不安装。

### 11.4 生命周期与降级

- URL 过期只阻止注册，不触发设备授权续期提醒。
- 授权在 7/3/1/0 天触发提醒，延期后重新计算，永久授权无到期提醒。
- 网络不可达和 HTTP `5xx` 保留凭据，可在恢复后继续使用。
- 禁用、到期、删除、账号不可用和组织不可用均只停用服务端能力。
- 所有服务端失败场景下，本地模型、本地技能、本地会话和本地数据仍可用。

### 11.5 服务端能力

- Bootstrap 后仅展示返回的可用模型，并能通过网关完成非流式和流式请求。
- access token 到期前能通过 Refresh 轮换 refresh token，随后继续调用 Bootstrap、网关和技能接口。
- 技能目录支持增量 cursor、下载校验和撤销/弃用同步。
- 断开连接后删除本机服务端凭据，但不请求删除服务端设备或授权。

## 12. 完成定义

满足以下条件后，UCLI 客户端升级可进入联调验收：

- 三个入口、状态机、单服务端替换事务和安装 ID 生命周期全部实现。
- Preview、Redeem、Refresh、Bootstrap、模型网关和技能同步已接通。
- 操作系统安全存储、refresh token 轮换和秘密清理通过安全测试。
- URL/授权双有效期、服务器时间校正和到期提醒通过时间边界测试。
- 稳定错误码、网络降级和本地能力隔离通过验收用例。
- 在可访问 `10.44.100.100` 的公司内网 Windows、macOS、Linux 环境完成至少一次真实设备注册；未支持的平台需在发布说明中明确。
