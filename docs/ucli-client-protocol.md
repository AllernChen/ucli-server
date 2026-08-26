# UCLI 桌面端接入协议 v1

## 独立模式与连接范围

UCLI 可独立安装和使用，未注册服务端时本地能力、本地数据和本地会话均可用。服务端注册是可选能力：成功连接后才启用服务端模型、服务端技能和后续服务端能力。

设置中只允许连接一个服务端。使用新授权连接另一服务端时，客户端应先完成新连接，再替换旧连接；新连接失败不得删除旧连接或任何本地数据。断开仅删除本机保存的服务端凭证与连接元数据，不删除服务端设备或授权。

## 浏览器授权链接

管理员为平台预创建的普通成员创建设备授权。一个授权令牌最多绑定一台设备；同一用户可创建多个授权令牌以注册多台设备。创建响应中的 `connectionUrl` 是唯一一次可取得原始令牌的机会：

```json
{
  "id": "grant-uuid",
  "token": "one-time-secret",
  "connectionUrl": "http://10.0.0.8:3000/connect#token=one-time-secret",
  "expiresAt": null
}
```

浏览器链接必须是 UCLI 可访问服务端 origin 下的 `http://IP:port/connect#token=<secret>`（或同等 HTTPS origin）。令牌只在 URL fragment；浏览器请求 `/connect` 时令牌不得进入 HTTP 请求路径或常规访问日志。

浏览器连接页读取 fragment 后调用预览接口，显示服务端地址、组织、用户、授权状态和有效期。预览不消费授权，且请求和响应均为 `Cache-Control: no-store`：

```http
POST /api/v1/auth/device-grants/preview
Content-Type: application/json
Cache-Control: no-store
```

```json
{"token":"<secret>"}
```

```json
{
  "account": { "id": "account-uuid", "displayName": "成员姓名" },
  "organization": { "id": "organization-uuid", "name": "组织名称" },
  "status": "AVAILABLE",
  "authorization": {
    "expiresAt": null,
    "serverTime": "2026-08-26T04:00:00.000Z"
  }
}
```

用户确认后，页面以当前 `location.origin` 和 fragment 中的令牌唤起 UCLI：

```text
ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#token=<secret>
```

未安装 UCLI 时页面应提供安装说明与复制连接链接。协议处理器只能打开确认界面，不能直接兑换令牌；客户端也可在设置中粘贴完整浏览器授权链接，进入同一确认流程。

## 设备兑换

确认后，UCLI 生成并持久化 UUID `installationId`，随后兑换当前设备：

```http
POST /api/v1/auth/device-grants/redeem
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "token": "<secret>",
  "device": {
    "installationId": "persistent-client-uuid",
    "name": "张三的工作站",
    "platform": "windows",
    "clientVersion": "1.2.0"
  }
}
```

```json
{
  "accessToken": "jwt",
  "refreshToken": "opaque-refresh-token",
  "expiresIn": 900,
  "account": { "id": "account-uuid", "displayName": "成员姓名" },
  "organization": { "id": "organization-uuid", "name": "组织名称" },
  "authorization": {
    "expiresAt": null,
    "serverTime": "2026-08-26T04:00:00.000Z"
  }
}
```

首次兑换绑定设备。若响应丢失，只能使用相同 `installationId` 与原始令牌在首次绑定后的 10 分钟内重试；重试成功会轮换并重新返回 refresh token。不同安装 ID 或超过 10 分钟返回 `grant_already_bound`。成功后使用操作系统安全存储保存 refresh token，随后立即从内存和普通配置中删除原始授权令牌；access token 只保留在运行时内存。

客户端不得把原始授权令牌、令牌摘要、完整协议 URL 或 refresh token 写入普通配置、诊断日志、遥测、崩溃报告或最近打开记录。服务端也不得将原始令牌或 `tokenHash`/`refreshTokenHash` 放入 Vue 页面、日志、审计元数据、异常或 API serializer。

## 刷新与授权元数据

refresh token 是单次使用凭证。客户端调用 `POST /api/v1/auth/token/refresh` 后，先原子替换操作系统安全存储中的 refresh token，再更新连接配置；服务端每次成功刷新都进行 refresh token 轮换。

兑换、刷新和 `GET /api/v1/client/bootstrap` 的成功响应均携带当前授权元数据：

```json
{
  "authorization": {
    "expiresAt": "2026-12-31T16:00:00.000Z",
    "serverTime": "2026-08-26T04:00:00.000Z"
  }
}
```

`expiresAt: null` 表示永久授权。客户端缓存最后成功同步的授权有效期，并使用 `serverTime` 校正本机时钟；临近到期和已到期时显示具体有效期并提醒用户联系管理员延期。管理员延期或改为永久后，下一次 refresh 或 bootstrap 覆盖缓存并重新计算提醒。

## 稳定错误与能力降级

设备注册、刷新和受保护请求使用以下稳定错误码：

| 错误码 | UCLI 行为 |
| --- | --- |
| `invalid_grant` | 链接或 refresh token 无效；注册时保留当前连接。 |
| `grant_disabled` | 停用服务端能力，提示联系管理员启用。 |
| `grant_expired` | 停用服务端能力，展示缓存有效期并提示联系管理员延期。 |
| `grant_already_bound` | 提示该链接已用于其他设备。 |
| `grant_deleted` | 停用服务端能力，要求使用新授权重新注册。 |
| `account_inactive` | 停用服务端能力，提示账号已停用。 |
| `organization_inactive` | 停用服务端能力，提示组织不可用。 |
| `invalid_device` | 清除失效设备凭证，要求使用新授权重新注册。 |

网络不可达是可恢复状态，不清除凭证。任何服务端失败都只停用服务端模型、服务端技能同步和后续服务端能力，绝不删除本地数据，也不影响本地模型、已安装本地技能或本地会话。授权禁用、删除或到期在下一次受保护请求时立即生效。

旧邀请、浏览器接受邀请、设备码轮询及其端点均无兼容路径；旧客户端必须升级并由管理员创建新设备授权。

## 启动配置

`GET /api/v1/client/bootstrap` 返回组织、网关地址、公开模型和技能目录地址。客户端为 Codex 创建 Responses 托管档案，为 Claude Code 创建 Anthropic Bearer 托管档案；平台设备访问令牌作为网关凭据，供应商 Key 永不下发。

## 模型请求头

除 `Authorization` 外可选发送：

- `X-UCLI-Session-ID`：UUID。
- `X-UCLI-Project-ID`：匿名项目 UUID，不得发送项目路径或名称。
- `X-UCLI-CLI-Type`：`claude`、`codex`、`opencode`、`ucode`。
- `X-UCLI-Client-Version`：最多32字符。
- `X-UCLI-Timezone`：IANA时区。

网关返回 `X-UCLI-Request-ID`，用于问题排查。客户端不上传独立遥测、使用事件或总结。

## 模型接口

- `GET /gateway/v1/models`
- `POST /gateway/v1/responses`
- `POST /gateway/v1/chat/completions`
- `POST /gateway/anthropic/v1/messages`

流式响应开始后平台不会自动重放请求。

## 技能目录

`GET /api/v1/skills/catalog?cursor=<ISO时间>` 返回当前组织可见的不可变技能版本。客户端从对象下载地址获取 ZIP，验证 SHA-256 后，复用现有 UCLI 安装、冲突和漂移处理流程。

`GET /api/v1/skills/revocations` 返回当前组织可见的已撤销/已弃用技能版本（`id`/`version`/`status`），客户端据此对已安装版本显示风险提示；`REVOKED` 版本禁止新下载，已安装内容不自动删除。
