# UCLI 客户端服务端注册升级方案

**实施归属：** UCLI 客户端仓库。本文件提供独立实现所需的完整服务端契约，不依赖本服务端仓库的相对链接。

## 目标与状态

UCLI 必须保持独立安装、独立使用。没有服务端连接、服务端不可达或授权失效时，本地模型、已安装本地技能、本地数据和本地会话保持可用；只有服务端模型、服务端技能和后续服务端能力降级。

设置只维护一个当前服务端连接。新链接必须 preview 和 redeem 成功后才替换旧连接；失败保留旧连接。断开只移除本机服务端凭证和元数据，不删除服务端设备或授权。

状态包括：未连接、连接中、已连接、服务端不可达、授权临近到期、授权已禁用、授权已到期、授权已删除、账号或当前组织成员关系不可用、组织不可用。

## 入口、安全边界和浏览器交接

浏览器链接格式固定为 `http://<server-ip>:<port>/connect#link=<secret>`，例如 `http://10.0.0.8:3000/connect#link=one-time-link-secret`。只解析 HTTP(S) origin 与 fragment `link`；拒绝 `#token`、query、用户信息、路径注入和其他协议。读取后先打开确认页，确认页从浏览器地址清除 fragment；未经确认不得 redeem。

确认后启动：

```text
ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#link=<secret>
```

链接秘密只能为 preview、redeem、同一 installationId 的 10 分钟重试或管理端恢复当前 URL 暂存于内存。确认页关闭、注册失败、切换用户、注册成功、取消、断开或卸载时清空当前页面副本；redeem 成功后不再持久化链接秘密。管理端关闭 URL 弹窗只清除 DOM 中的当前副本，不撤销服务端链接；授权管理员之后仍可再次查看当前 URL。普通配置、操作系统安全存储、DOM 隐藏字段、最近打开记录、日志、异常、审计、遥测和崩溃报告都不得保存它。服务端管理端仅返回 `connectionUrl`，不返回裸链接秘密字段。

## API 契约

### Preview

```http
POST /api/v1/auth/device-grants/preview
Content-Type: application/json
```

```json
{"link":"<secret>"}
```

响应必须遵守 `Cache-Control: no-store`，且不消费链接：

```json
{
  "account": { "id": "account-uuid", "displayName": "成员姓名" },
  "organization": { "id": "organization-uuid", "name": "组织名称" },
  "link": { "status": "AVAILABLE", "expiresAt": "2026-09-02T04:00:00.000Z" },
  "authorization": { "status": "AVAILABLE", "expiresAt": null, "serverTime": "2026-08-27T04:00:00.000Z" }
}
```

显示 URL 有效期和授权有效期为两个字段，并保留 `serverTime`。只有两个 status 都为 `AVAILABLE` 可继续。URL 过期只影响该 URL；授权有效期才是客户端的长期服务端访问边界。

### Redeem

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

`installationId` 为预先生成并持久化的 UUID v4；`name` 为 1–120 字符；`platform` 只允许 `windows`、`macos`、`linux`；`clientVersion` 为 1–32 字符。

响应必须遵守 `Cache-Control: no-store`：

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

首次 redeem 绑定设备。若响应丢失，只能用同一 installationId 和相同链接秘密在首次绑定后的 10 分钟内重试；不得生成新的 installationId。成功时先原子写入操作系统安全存储的 refresh token，再更新普通连接配置；access token 仅保留运行时内存，随后删除链接秘密。

## 授权同步和到期提醒

```http
POST /api/v1/auth/token/refresh
Content-Type: application/json
```

```json
{"refreshToken":"opaque-refresh-token"}
```

```http
GET /api/v1/client/bootstrap
Authorization: Bearer <accessToken>
```

每个成功的 redeem、refresh 与 bootstrap 都保存 `authorization.expiresAt` 和 `authorization.serverTime`。`expiresAt: null` 表示永久授权。客户端用 serverTime 校正时钟，以授权有效期在到期前 7 天、3 天、1 天和当天各提醒一次；到期后显示最后同步的具体时间并提示联系管理员延期。新的有效期重新计算提醒，改为永久则清除提醒。绝不使用 URL 有效期触发管理员续期提醒。

## 稳定错误映射与能力隔离

`grant_bound` 只适用于管理端 `POST /api/v1/admin/device-grants/:id/links`，表示授权已绑定而不能重新生成 URL。公开 Preview/Redeem 遇到已消费链接时返回 `link_consumed`，同一 installationId 在 10 分钟幂等窗口内可重试；不要兼容旧的绑定错误别名。

| 错误码 | 客户端行为 |
| --- | --- |
| `invalid_link` | 链接无效，保留当前连接，提示联系管理员创建新的授权链接。 |
| `link_expired` | URL 已过期，提示联系管理员创建新的授权链接。 |
| `link_revoked` | URL 已撤销，提示联系管理员创建新的授权链接。 |
| `link_consumed` | URL 已消费或重试窗口结束，提示联系管理员创建新的授权链接。 |
| `grant_disabled` | 停用服务端能力，提示联系管理员启用。 |
| `grant_expired` | 停用服务端能力，显示授权有效期并提示联系管理员延期。 |
| `grant_bound` | 管理端重新生成被拒：授权已绑定设备，不能再生成 URL。 |
| `grant_deleted` | 停用服务端能力，要求新的授权链接。 |
| `account_inactive` | 停用服务端能力，提示账号或当前组织成员关系不可用。 |
| `organization_inactive` | 停用服务端能力，提示组织不可用。 |
| `invalid_device` | 清除失效设备凭证，要求新的授权链接。 |

服务端不可达是可恢复网络状态，不清除凭证；不得把网络问题误报为授权删除。所有服务端错误都不得影响本地功能或本地数据。

## 实施清单

- 注册 `ucli://`，实现 `#link=` 解析、确认页、Preview、Redeem 和 10 分钟同安装重试。
- 实现一个服务端连接状态、原子安全存储、refresh 轮换、bootstrap 授权同步和授权到期提醒。
- 将服务端模型、技能目录与撤销同步、以及后续服务端能力接入统一开关。
- 覆盖协议处理、配置迁移、安全存储、设置界面、稳定错误状态、能力隔离和到期通知测试。
