# UCLI 桌面端接入协议 v1

**实施归属：** UCLI 客户端代码在独立的 UCLI 客户端仓库实现。本文件是该仓库的完整服务端接入契约。

## 独立模式与单服务端

UCLI 可独立安装、独立使用。未注册、服务端不可达或授权失效时，本地模型、已安装本地技能、本地数据和本地会话持续可用；仅服务端模型、服务端技能同步和后续服务端能力降级。

设置只维护一个当前服务端连接。新连接必须先 preview 和 redeem 成功，之后才替换旧连接；失败不得删除旧连接或本地数据。断开只删除本机服务端凭证和连接元数据，不删除服务端设备或授权。

## 浏览器链接和秘密边界

管理端创建、查看或重新生成设备授权 URL 的 `connectionUrl` 响应是链接秘密的受控输出，绝不返回裸链接秘密字段；对应的 Vue 弹窗仅短暂保存并展示完整连接链接。关闭只会清除当前页面 DOM 中的 URL 副本；只要当前链接未撤销、未使用且授权可用，管理员仍可再次查看当前 URL 恢复副本。示例：

### 创建响应

```json
{
  "id": "grant-uuid",
  "connectionUrl": "http://10.0.0.8:3000/connect#link=one-time-link-secret",
  "expiresAt": null
}
```

连接链接必须使用 UCLI 可访问的一个 HTTP(S) 服务端 origin，例如 `http://10.0.0.8:3000/connect#link=<secret>`。浏览器只解析 fragment 的 `link` 键，拒绝 `#token` 和所有 query 参数；读取后立即以 `history.replaceState` 清除 fragment。fragment 不会进入 HTTP 请求 URL 或常规访问日志。

确认后，页面使用规范化 origin 唤起：

```text
ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#link=<secret>
```

协议处理器和设置页粘贴链接都只接受 HTTP(S) origin 与 `#link=` fragment，拒绝用户信息、路径注入和其他协议，并先打开确认页；未确认不得 redeem。页面显示服务端、组织、用户、URL 状态、URL 有效期、授权状态、授权有效期和服务器时间。

链接秘密仅在从 fragment 发起 preview/redeem、同一 installationId 的 10 分钟重试，或管理端当前 URL 恢复响应时存在内存。弹窗关闭、创建失败、切换用户、确认页关闭、注册失败、注册成功、取消、断开或卸载时清空当前页面副本。浏览器跳转至 `ucli://` 后和组件卸载时也清空。管理端清空页面副本不撤销服务端当前链接，授权管理员之后仍可再次查看恢复。链接秘密不得进入 DOM 隐藏字段、URL query、请求路径、日志、异常、审计、storage、遥测、崩溃报告或最近打开记录；`secretHash` 与 refresh token 哈希永不展示。

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

### Bootstrap HTTP

```http
GET /api/v1/client/bootstrap
Authorization: Bearer <accessToken>
```

### Bootstrap 响应

```json
{
  "organization": { "id": "organization-uuid", "name": "组织名称", "timezone": "Asia/Shanghai" },
  "gateway": { "baseUrl": "http://10.0.0.8:3001" },
  "models": [{ "id": "example-model", "displayName": "示例模型", "contextSize": 128000 }],
  "skillsCatalogUrl": "http://10.0.0.8:3000/api/v1/skills/catalog",
  "authorization": { "expiresAt": null, "serverTime": "2026-08-27T04:00:00.000Z" }
}
```

redeem、refresh 和 bootstrap 都同步 `authorization.expiresAt` 与 `authorization.serverTime`。客户端使用授权有效期（不是 URL 有效期）在临近到期及到期后显示具体时间，并提示联系管理员延期。

## 稳定错误与能力降级

`grant_bound` 只适用于管理端 `POST /api/v1/admin/device-grants/:id/links`，表示稳定授权已经绑定设备，不能再生成连接 URL。对于已消费链接，公开 Preview/Redeem 则返回 `link_consumed`；同一 installationId 在 10 分钟窗口内的幂等 Redeem 除外。两者不得互换或保留旧别名。

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

`GET /gateway/v1/models`、`POST /gateway/v1/responses`、`POST /gateway/v1/chat/completions` 和 `POST /gateway/anthropic/v1/messages` 使用设备 access token。`GET /api/v1/skills/catalog?cursor=<ISO时间>` 返回当前组织可见的不可变技能版本；`GET /api/v1/skills/revocations` 返回撤销或弃用版本。供应商 Key 永不下发。
