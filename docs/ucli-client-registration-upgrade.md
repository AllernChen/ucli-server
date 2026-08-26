# UCLI 客户端服务端注册升级方案

**实施归属：** UCLI 客户端仓库

**服务端设计：** [`docs/superpowers/specs/2026-08-26-device-grant-registration-design.md`](superpowers/specs/2026-08-26-device-grant-registration-design.md)

**服务端协议：** [`docs/ucli-client-protocol.md`](ucli-client-protocol.md)；接口字段、稳定错误码和安全边界以该协议为准。

**协议版本：** UCLI Server Device Grant v1

## 升级目标

UCLI 继续保持可独立安装、独立使用。此次升级在设置中增加可选的“注册到服务端”能力。注册后启用服务端模型、服务端技能和后续扩展能力；未注册、服务端不可达或授权失效时，本地功能、本地数据和本地会话保持可用。

首版只维护一个当前服务端连接。连接新服务端时替换原连接，但不删除本地数据。

## 用户入口

### 浏览器授权链接

管理员发送：

```text
http://<server-ip>:<port>/connect#token=<secret>
```

用户在浏览器打开页面并点击“连接 UCLI”。页面通过系统注册的以下协议 URL 唤起 UCLI，传递服务端地址和原始授权令牌：

```text
ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#token=<secret>
```

### UCLI 设置

在设置中新增“服务端连接”：

- 未连接：显示“注册到服务端”，支持粘贴完整浏览器授权链接。
- 已连接：展示服务端地址、组织、用户、设备名称、状态和授权有效期。
- 支持使用新链接替换当前服务端连接。
- 支持断开本地连接；断开只删除本机保存的服务端凭证和连接元数据，不删除服务端设备或授权。

## 客户端模块边界

客户端实现可按现有代码结构映射以下职责；具体文件路径由客户端仓库确定：

| 模块 | 职责 |
| --- | --- |
| 协议唤起处理器 | 注册并解析 `ucli://`，验证参数后打开注册确认界面 |
| 授权链接解析器 | 解析粘贴的 HTTP 链接，从 fragment 提取令牌和服务端 origin |
| 服务端注册服务 | 调用 preview、redeem、refresh 和 bootstrap |
| 安装身份存储 | 生成并持久化一个 UUID `installationId`，重试和重启后保持不变 |
| 安全凭证存储 | 使用操作系统安全存储保存 refresh token；access token 仅保存在运行时 |
| 服务端连接状态 | 保存单个服务端地址、账号、组织、设备、有效期和最近同步时间 |
| 能力开关 | 根据连接与授权状态启用或停用服务端模型、技能和扩展能力 |
| 到期提醒器 | 根据缓存的服务端时间和到期时间生成提醒 |

## 本地持久化数据

普通配置存储：

```json
{
  "serverBaseUrl": "http://10.0.0.8:3000",
  "installationId": "persistent-client-uuid",
  "account": {
    "id": "account-uuid",
    "displayName": "成员姓名"
  },
  "organization": {
    "id": "organization-uuid",
    "name": "组织名称"
  },
  "deviceName": "张三的工作站",
  "authorizationExpiresAt": null,
  "authorizationServerTime": "2026-08-26T04:00:00.000Z",
  "authorizationSyncedAt": "2026-08-26T04:00:01.000Z"
}
```

操作系统安全存储：

- 当前服务端 refresh token。

不得持久化：

- 已成功兑换的原始授权令牌。
- access token 明文到普通配置文件。

## 注册流程

1. 协议处理器或设置页解析服务端地址与授权令牌。
2. 只接受 `http:` 或 `https:` 服务端地址，规范化为 origin，拒绝用户信息、路径注入和不支持的协议。
3. 调用 `POST /api/v1/auth/device-grants/preview`，展示服务端、组织、用户和有效期。
4. 显示确认页，明确注册将启用服务端能力；若已经连接另一服务端，明确提示将替换连接。
5. 确认后读取持久化 `installationId`；没有则生成 UUID 并先保存。
6. 调用 `POST /api/v1/auth/device-grants/redeem`，提交安装 ID、设备名称、平台和客户端版本。
7. 成功后先把 refresh token 写入安全存储，再原子更新普通连接配置。
8. 删除内存中的原始授权令牌，加载 bootstrap，刷新服务端模型与技能。
9. 若响应丢失，使用相同安装 ID 和原始令牌在 10 分钟内重试；不生成新的安装 ID。

## API 契约

### 预览

```http
POST /api/v1/auth/device-grants/preview
Content-Type: application/json

{"token":"<secret>"}
```

客户端不得把令牌放进服务端请求 URL、诊断日志或崩溃报告。

### 兑换

```http
POST /api/v1/auth/device-grants/redeem
Content-Type: application/json
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

成功响应包含 access token、refresh token、账号、组织和：

```json
{
  "authorization": {
    "expiresAt": null,
    "serverTime": "2026-08-26T04:00:00.000Z"
  }
}
```

### 刷新与启动配置

- access token 过期前使用现有 `POST /api/v1/auth/token/refresh`，每次成功后替换安全存储中的 refresh token。
- refresh 成功响应和 `GET /api/v1/client/bootstrap` 都更新 `authorization.expiresAt` 与 `authorization.serverTime`。
- 配置写入必须原子化，避免进程崩溃后保留已失效的旧 refresh token。

## 连接状态

客户端维护以下展示状态：

```text
未连接
连接中
已连接
服务端不可达
授权临近到期
授权已禁用
授权已到期
授权已删除
账号不可用
组织不可用
```

- “服务端不可达”是可恢复的网络状态，不清除凭证。
- “已禁用”和“已到期”保留凭证与连接信息，重新启用或延期后可自动恢复。
- “已删除”表示服务端授权不可恢复；客户端保留非敏感连接信息用于解释状态，但停止自动 refresh，要求使用新授权链接重新注册。
- 注册新服务端成功后才删除旧服务端凭证，避免新注册失败造成现有连接丢失。

## 错误映射

| 服务端错误码 | UCLI 行为 |
| --- | --- |
| `invalid_grant` | 提示链接无效，保留当前连接 |
| `grant_disabled` | 停用服务端能力，提示联系管理员启用 |
| `grant_expired` | 停用服务端能力，显示缓存到期时间并提示延期 |
| `grant_already_bound` | 提示该链接已用于其他设备，联系管理员创建新授权 |
| `grant_deleted` | 停用服务端能力，要求使用新授权重新注册 |
| `account_inactive` | 停用服务端能力，提示账号已停用 |
| `organization_inactive` | 停用服务端能力，提示组织不可用 |
| `invalid_device` | 清除失效设备凭证，要求使用新授权重新注册 |

任何服务端错误都不得影响本地功能和本地数据。

## 服务端能力隔离

所有依赖服务端的入口通过统一连接状态判断：

- 服务端模型列表与模型调用。
- 服务端技能目录、下载和撤销同步。
- 后续增加的服务端能力。

能力不可用时显示原因和恢复动作，不把普通网络失败误报为授权删除。已有本地模型、已安装本地技能和本地会话继续工作。

## 有效期与提醒

- `expiresAt = null` 显示“长期有效”，不创建到期提醒。
- 客户端使用服务端 `serverTime` 计算本机与服务端的时钟偏差。
- 在到期前 7 天、3 天、1 天和到期当天提醒；同一阈值最多提醒一次。
- refresh 或 bootstrap 获得新的有效期后，重新计算并持久化提醒状态。
- 已延期到更晚时间时清除旧阈值状态；改为永久时清除全部到期提醒。
- 到期后保留最后同步的时间，提示“授权已于具体时间到期，请联系管理员延期”。

## 协议唤起安全

- 安装包注册 `ucli://` 协议，并保证只有 UCLI 处理对应命令。
- 协议处理器不得直接兑换；必须先打开确认界面。
- 确认界面完整展示服务端 IP、端口、组织、用户和有效期。
- 不把原始协议 URL、fragment 或令牌写入应用日志、最近打开记录、遥测或崩溃报告。
- HTTP 是本次公司可信内网部署的明确约束；界面不应把 HTTP 错误标记为配置失败，但可展示“内网非加密连接”。

## 实施阶段

### 阶段 1：连接基础设施

- 增加单服务端连接模型、安装 ID、安全凭证存储和服务端 API 客户端。
- 完成 refresh token 原子轮换与授权元数据同步。

### 阶段 2：注册入口

- 注册 `ucli://` 系统协议。
- 实现浏览器唤起、粘贴链接、预览、确认、兑换和 10 分钟重试。

### 阶段 3：设置与状态

- 实现服务端连接设置区、替换连接、断开本地连接和错误状态展示。
- 把服务端模型、技能和扩展能力接入统一能力开关。

### 阶段 4：有效期体验

- 同步和缓存有效期。
- 实现 7 天、3 天、1 天和到期提醒。
- 验证延期、永久授权、禁用恢复和删除后的交互。

## 客户端验收清单

- 无服务端配置时 UCLI 可正常启动并使用全部本地能力。
- 浏览器链接能唤起 UCLI；未确认前不兑换令牌。
- 设置页粘贴同一链接可进入相同注册流程。
- 成功注册后原始授权令牌不再持久化，refresh token 只进入系统安全存储。
- 响应丢失后使用相同安装 ID 可在 10 分钟内恢复注册。
- 一个 UCLI 实例只保留一个当前服务端，新注册失败不破坏旧连接。
- 永久授权和定期授权展示正确。
- refresh 与 bootstrap 能发现管理员延期并更新提醒。
- 禁用、到期、删除、账号停用和组织停用均只影响服务端能力。
- 服务端断网不清除凭证，本地模型、技能和会话继续可用。
- 日志、遥测、崩溃报告和普通配置中不存在授权令牌或 refresh token。
- Windows 安装、升级和卸载能正确注册、更新和清理 `ucli://` 协议处理器。

## 客户端仓库落地要求

客户端团队实施前应根据实际仓库结构，把上述四个阶段拆成文件级、测试优先的实施任务。计划必须覆盖协议处理器、配置迁移、安全存储、网络服务、设置界面、能力隔离和通知测试；服务端接口字段、稳定错误码和安全边界以服务端协议为准。
