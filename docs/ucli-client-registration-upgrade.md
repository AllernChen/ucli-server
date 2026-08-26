# UCLI 客户端服务端注册升级方案

**实施归属：** UCLI 客户端仓库。随交接包附带服务端协议；本文件已内联实施所需接口与安全契约，客户端不依赖相对链接才能实现。

## 目标与单服务端状态

UCLI 必须继续独立安装、独立使用。没有服务端连接、服务端不可达或授权失效时，本地模型、已安装本地技能、本地数据和本地会话保持可用；只有服务端模型、服务端技能及后续服务端能力降级。

设置只维护一个当前服务端连接。新注册链接先完成 preview 和 redeem，成功后才替换旧连接；失败保留旧连接。断开只移除本机服务端凭证和元数据，不删除服务端设备或授权。

状态：未连接、连接中、已连接、服务端不可达、授权临近到期、授权已禁用、授权已到期、授权已删除、账号/当前组织成员关系不可用、组织不可用。

## 入口与安全边界

浏览器链接格式为 `http://<server-ip>:<port>/connect#token=<secret>`；令牌只在 fragment，不能放入 URL query、请求路径、日志、异常、审计、storage、遥测或崩溃报告。浏览器页面确认后唤起：

```text
ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#token=<secret>
```

协议处理器和设置页粘贴链接都必须解析为 HTTP(S) origin 和 fragment 令牌，拒绝用户信息、路径注入及其他协议，并先打开确认页。确认页展示服务端 IP/端口、组织、用户、状态和有效期；未确认不得兑换。

管理端创建响应仅返回 `connectionUrl`，绝不返回裸 `token` 字段。原始 grant token 只在收到该链接 fragment 后、发起 preview/redeem 或同安装 10 分钟重试期间短暂存在内存。确认页关闭、注册失败、切换用户或卸载时清空；注册成功、取消或断开时同样清空。普通配置、系统安全存储、DOM、最近打开记录和诊断输出都不得保存它；`tokenHash`/`refreshTokenHash` 永不展示。

## API 契约

### Preview

```http
POST /api/v1/auth/device-grants/preview
Content-Type: application/json
```

```json
{"token":"<secret>"}
```

响应带 `Cache-Control: no-store`，不消费授权：

```json
{
  "account": { "id": "account-uuid", "displayName": "成员姓名" },
  "organization": { "id": "organization-uuid", "name": "组织名称" },
  "status": "AVAILABLE",
  "authorization": { "expiresAt": null, "serverTime": "2026-08-26T04:00:00.000Z" }
}
```

状态为 `AVAILABLE`、`BOUND`、`DISABLED`、`EXPIRED` 或 `DELETED`；只有 `AVAILABLE` 可继续确认注册。

### Redeem

```http
POST /api/v1/auth/device-grants/redeem
Content-Type: application/json
```

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

`installationId` 是安装前生成并持久化的 UUID v4；`name` 为 1–120 字符，`platform` 仅为 `windows`、`macos`、`linux`，`clientVersion` 为 1–32 字符。

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

响应带 `Cache-Control: no-store`。同一授权只绑定一台设备；同一用户可获多个授权。响应丢失时只可使用相同 installationId 和原始令牌在首次绑定后 10 分钟内重试，不得生成新的 installationId。

### Refresh 与 bootstrap

```http
POST /api/v1/auth/token/refresh
Content-Type: application/json
```

```json
{"refreshToken":"opaque-refresh-token"}
```

成功响应包含 `accessToken`、轮换后的 `refreshToken`、`expiresIn: 900` 与：

```json
{"authorization":{"expiresAt":null,"serverTime":"2026-08-26T04:00:00.000Z"}}
```

```http
GET /api/v1/client/bootstrap
Authorization: Bearer <accessToken>
```

bootstrap 返回 `organization`（`id`/`name`/`timezone`）、`gateway.baseUrl`、模型数组（`id`/`displayName`/`contextSize`）、`skillsCatalogUrl` 与相同 `authorization`。每个成功的 redeem、refresh 与 bootstrap 都更新 `authorization.expiresAt` 和 `authorization.serverTime`。

## 本机存储与提醒

普通配置只保存一个 origin、installationId、账号/组织摘要、设备名称和最后同步的授权元数据。refresh token 仅存操作系统安全存储；access token 仅存在运行时内存。写入顺序为先原子替换安全存储中的 refresh token，再原子更新普通连接配置。

`expiresAt: null` 表示永久授权。使用服务端 `serverTime` 校正时钟，在到期前 7 天、3 天、1 天和当天各提醒一次；到期后显示最后同步的具体时间并提示联系管理员延期。新的有效期重新计算提醒，改为永久则清除提醒。

## 错误映射与能力隔离

| 错误码 | 行为 |
| --- | --- |
| `invalid_grant` | 链接或 refresh token 无效，注册时保留当前连接。 |
| `grant_disabled` | 停用服务端能力，提示管理员启用。 |
| `grant_expired` | 停用服务端能力，显示有效期并提示联系管理员延期。 |
| `grant_already_bound` | 链接已用于其他设备，请管理员创建新授权。 |
| `grant_deleted` | 停用服务端能力、停止自动 refresh，要求新授权。 |
| `account_inactive` | 停用服务端能力，提示账号或当前组织成员关系不可用。 |
| `organization_inactive` | 停用服务端能力，提示组织不可用。 |
| `invalid_device` | 清除失效设备凭证，要求新授权。 |

服务端不可达是可恢复网络状态，不清除凭证；不得把网络问题误报为授权删除。所有上述状态都不得影响本地功能和数据。

## 客户端实施清单

- 注册 `ucli://`，实现 fragment 解析、确认页、preview、redeem 和 10 分钟同安装重试。
- 实现一个服务端连接状态、原子安全存储、refresh 轮换和 bootstrap 授权同步。
- 将服务端模型、技能目录/撤销同步和后续服务端能力接入统一开关。
- 覆盖协议处理、配置迁移、安全存储、设置界面、错误状态、能力隔离和到期通知测试。
