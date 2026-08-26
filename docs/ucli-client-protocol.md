# UCLI 桌面端接入协议 v1

## 独立模式与连接范围

UCLI 可独立安装和使用；未注册、服务端不可达或授权失效时，本地能力、本地数据和本地会话持续可用。服务端注册是可选能力，仅启用服务端模型、服务端技能和后续服务端能力。

设置中只允许连接一个服务端。连接新服务端必须先成功完成新注册，之后才替换旧连接；新连接失败不得删除旧连接或本地数据。断开只删除本机服务端凭证与连接元数据，不删除服务端设备或授权。

## 令牌边界

原始 grant token 是一次性秘密。服务端只可在管理端创建设备授权 API 的一次性 `connectionUrl` 响应中输出其 fragment，绝不返回裸 `token` 字段；管理端只可在对应的一次性 Vue 弹窗中短暂保存并展示完整连接链接。弹窗关闭、创建失败、切换用户或卸载时清空。浏览器和 UCLI 仅为从 fragment 发起 preview/redeem 或同安装 10 分钟重试而短暂保留内存副本。

除这些必要边界外，原始 grant token 不得进入其他 serializer 或响应、DOM 页面、URL query、日志、异常、审计、storage、遥测、崩溃报告或最近打开记录。`tokenHash`/`refreshTokenHash` 永不展示。令牌始终位于浏览器和 `ucli://` URL 的 fragment，绝不位于 query 或服务端请求路径。

## 浏览器授权链接

管理员为平台预创建普通成员创建授权。一个授权令牌最多绑定一台设备；同一用户可创建多个授权令牌以注册多台设备。创建响应中 `connectionUrl` 是唯一一次性秘密输出：

### 创建响应

```json
{
  "id": "grant-uuid",
  "connectionUrl": "http://10.0.0.8:3000/connect#token=one-time-secret",
  "expiresAt": null
}
```

连接链接必须是 UCLI 可访问 origin 下的 `http://IP:port/connect#token=<secret>`（或 HTTPS）。浏览器请求 `/connect` 时 fragment 不会进入请求 URL 或常规访问日志。页面显示服务端、组织、用户、授权状态和有效期；点击确认前不兑换令牌。未安装 UCLI 时显示安装说明和复制连接链接。

确认后页面以当前 `location.origin` 和 fragment 令牌唤起：

```text
ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#token=<secret>
```

协议处理器只能打开确认界面；设置页粘贴完整浏览器链接进入同一流程，不能直接兑换。

## 预览

### Preview HTTP

```http
POST /api/v1/auth/device-grants/preview
Content-Type: application/json
```

### Preview 请求

```json
{"token":"<secret>"}
```

### Preview 响应

```json
{
  "account": { "id": "account-uuid", "displayName": "成员姓名" },
  "organization": { "id": "organization-uuid", "name": "组织名称" },
  "status": "AVAILABLE",
  "authorization": { "expiresAt": null, "serverTime": "2026-08-26T04:00:00.000Z" }
}
```

服务端响应头 `Cache-Control: no-store`；预览不消费授权。`status` 仅为 `AVAILABLE`、`BOUND`、`DISABLED`、`EXPIRED` 或 `DELETED`。

## 设备兑换

`installationId` 必须是 UUID v4；`name` 为去空格后的 1–120 字符；`platform` 仅允许 `windows`、`macos`、`linux`；`clientVersion` 为 1–32 字符。不符合这些约束时返回 `invalid_device`。

### Redeem HTTP

```http
POST /api/v1/auth/device-grants/redeem
Content-Type: application/json
```

### Redeem 请求

```json
{
  "token": "<secret>",
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
  "authorization": { "expiresAt": null, "serverTime": "2026-08-26T04:00:00.000Z" }
}
```

服务端响应头 `Cache-Control: no-store`。首次兑换绑定设备；响应丢失时只能用相同 `installationId` 与 grant token 在首次绑定后的 10 分钟内重试。重试轮换 refresh token 并重新返回凭证；不同安装 ID 或超时返回 `grant_already_bound`。成功后先将 refresh token 写入操作系统安全存储，再删除内存与普通配置中的 grant token；access token 只保留运行时内存。

## 刷新与启动配置

refresh token 为单次使用凭证。客户端先原子替换操作系统安全存储中的新 refresh token，再更新连接配置；服务端每次成功刷新都轮换 refresh token。

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
  "authorization": { "expiresAt": null, "serverTime": "2026-08-26T04:00:00.000Z" }
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
  "authorization": { "expiresAt": null, "serverTime": "2026-08-26T04:00:00.000Z" }
}
```

redeem、refresh 和 bootstrap 都同步 `authorization.expiresAt` 与 `authorization.serverTime`。`expiresAt: null` 表示永久授权；客户端缓存最后成功值，以 serverTime 校正本机时钟，在临近到期及到期后显示具体时间并提醒用户联系管理员延期。

## 稳定错误与能力降级

| 错误码 | UCLI 行为 |
| --- | --- |
| `invalid_grant` | 链接或 refresh token 无效；注册时保留当前连接。 |
| `grant_disabled` | 停用服务端能力，提示联系管理员启用。 |
| `grant_expired` | 停用服务端能力，显示缓存有效期并提示联系管理员延期。 |
| `grant_already_bound` | 提示链接已用于其他设备。 |
| `grant_deleted` | 停用服务端能力，要求新授权重新注册。 |
| `account_inactive` | 停用服务端能力，提示账号或当前组织成员关系已停用。 |
| `organization_inactive` | 停用服务端能力，提示组织不可用。 |
| `invalid_device` | 清除失效设备凭证，要求新授权重新注册。 |

网络不可达可恢复且不清除凭证。所有服务端错误只停用服务端模型、服务端技能同步和后续服务端能力；本地模型、已安装本地技能、本地会话和本地数据不受影响。旧邀请、浏览器接受邀请、设备码轮询及其端点均无兼容路径。

## 网关与技能

`GET /gateway/v1/models`、`POST /gateway/v1/responses`、`POST /gateway/v1/chat/completions` 和 `POST /gateway/anthropic/v1/messages` 使用设备 access token。`GET /api/v1/skills/catalog?cursor=<ISO时间>` 返回当前组织可见的不可变技能版本；`GET /api/v1/skills/revocations` 返回撤销/弃用版本。供应商 Key 永不下发。
