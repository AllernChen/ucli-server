# UCLI 服务端设备授权注册设计

**状态：** 已确认

**日期：** 2026-08-26

**相关客户端方案：** [`docs/ucli-client-registration-upgrade.md`](../../ucli-client-registration-upgrade.md)

## 背景

UCLI 可以独立安装和使用，不依赖 UCLI Server。用户可在 UCLI 设置中选择注册到一个公司内网服务端；注册后，UCLI 获得服务端提供的模型、技能和后续扩展能力。本地能力、本地数据和本地会话不以服务端注册为前提。

当前服务端流程是：管理员创建邀请记录，用户在网页接受邀请并设置密码，UCLI 再通过设备码和网页登录审批完成设备授权。目标流程改为：平台预创建普通用户，为用户创建可管理的设备授权令牌，用户从浏览器打开授权链接并唤起 UCLI，UCLI 使用该令牌注册当前设备。

## 目标

- 平台预创建普通成员，普通成员不需要服务端密码。
- 一个授权令牌归属一个用户，最多绑定一台设备。
- 同一用户可拥有多个授权令牌，从而注册多台设备。
- 授权默认永久有效，也可设置到期时间；到期约束同时作用于未绑定令牌和已绑定设备。
- 授权可禁用、重新启用、延期、改为永久或软删除。
- 禁用可恢复；删除不可恢复并永久撤销关联设备。
- 平台用户页可查看用户的设备和授权；授权页按用户聚合展示。
- UCLI 获得并持续同步授权有效期，在临近到期时提醒用户联系管理员。
- 移除旧邀请接受和设备码审批流程，不保留旧客户端兼容。

## 非目标

- 不改变 UCLI 的独立使用模式。
- 不支持一个 UCLI 实例同时连接多个服务端。
- 不在本仓库实现 UCLI 客户端；本仓库只提供服务端、管理后台、浏览器连接页和协议文档。
- 不在本期设计新的平台管理员创建或找回密码流程；现有管理员账号和网页登录继续使用密码。
- 不支持已删除授权恢复。
- 不通过邮件或短信自动发送授权链接。

## 核心方案

采用持久化 `DeviceGrant` 授权记录。授权链接中的原始令牌只用于首次绑定和短时间幂等重试；绑定成功后，UCLI 使用独立的 access token 和滚动 refresh token 访问服务端。服务端每次鉴权都校验关联授权的实时状态。

不采用以下方案：

- 不让授权链接令牌直接充当长期 API 凭证，避免链接秘密长期参与每次访问。
- 不采用无状态签名链接，因为禁用、恢复、删除、按用户聚合和审计都要求服务端持久化状态。

## 领域模型

### Account

现有 `Account` 保留，`passwordHash` 改为可空。`Account.status` 是全局平台状态；`Membership.status` 是组织范围内的成员状态：

- 平台创建普通成员时，事务内创建 `Account` 和当前组织的 `Membership`，角色固定为 `MEMBER`，`passwordHash = null`。
- 登录接口只接受存在密码摘要、全局 `Account.status` 有效且当前 `Membership.status` 有效的账号。
- 现有管理员账号和密码摘要保持不变。
- 管理员“禁用用户”只禁用当前组织的 `Membership.status`，不改变全局 `Account.status`；该成员在当前组织的设备立即失去服务端访问能力，其他组织成员关系不受影响。

### DeviceGrant

新增 `DeviceGrant`：

| 字段 | 含义 |
| --- | --- |
| `id` | UUID 主键 |
| `organizationId` | 所属组织 |
| `accountId` | 被授权用户 |
| `tokenHash` | 原始令牌的 SHA-256 摘要，唯一 |
| `tokenHint` | 管理界面使用的非敏感脱敏提示 |
| `expiresAt` | 可空；空表示永久有效 |
| `disabledAt` | 可空；非空表示暂时禁用 |
| `deletedAt` | 可空；非空表示不可恢复的软删除 |
| `boundAt` | 可空；首次成功绑定时间 |
| `redeemRetryUntil` | 可空；首次绑定后 10 分钟的幂等重试截止时间 |
| `deviceId` | 可空且唯一；一个授权最多关联一台设备 |
| `createdById` | 创建授权的管理员账号 |
| `createdAt` | 创建时间 |
| `updatedAt` | 最近管理操作时间 |

令牌使用 32 字节安全随机数并编码为 base64url。数据库、审计日志、应用日志和异常中不得记录原始令牌。

授权状态由字段实时推导，不重复保存状态枚举，优先级如下：

```text
已删除 > 已禁用 > 已过期 > 已绑定 > 待绑定
```

### Device

现有 `Device` 保留并扩展：

- 新增全局唯一的 `installationId`，由 UCLI 首次注册前生成并持久化。
- 保存 `platform` 和 `clientVersion`，用于平台展示与后续兼容判断。
- 与 `DeviceGrant` 建立一对一关系。
- 继续保存 refresh token 摘要、最后活跃时间和永久撤销时间。

禁用授权时不写 `Device.revokedAt`，因此重新启用或延期后原设备可以恢复。删除授权时写入 `deletedAt` 并永久撤销关联设备。

## 授权状态与生命周期

```text
待绑定 ──绑定──> 已绑定
   │              │
   ├──禁用──> 已禁用 <──禁用──┤
   │              │
   └──到期──> 已过期 <──到期──┘

已禁用 ──启用──> 根据绑定关系和有效期恢复
已过期 ──延长──> 根据绑定关系恢复为待绑定或已绑定
任意非删除状态 ──删除──> 已删除
```

- 未绑定授权到期后不能绑定。
- 已绑定授权到期后关联设备立即失去服务端能力。
- 延长到未来时间或改为永久后，未删除且未禁用的设备恢复。
- 启用操作不覆盖到期判断；仍在过期状态的授权保持不可用。
- 删除不可撤销、不可延期、不可重新绑定。

## 管理接口

所有接口继续使用现有管理员 Bearer 鉴权，并限制在调用者有权管理的组织内。

### 用户

```text
POST /api/v1/admin/users
GET  /api/v1/admin/users
GET  /api/v1/admin/users/:userId
POST /api/v1/admin/users/:userId/disable
POST /api/v1/admin/users/:userId/enable
```

创建普通成员请求：

```json
{
  "email": "member@example.com",
  "displayName": "成员姓名"
}
```

创建操作以邮箱小写形式判重，在同一事务内创建账号和当前组织的 `MEMBER` 成员关系。详情接口返回用户基本信息、当前组织成员状态、授权摘要和设备摘要，但不返回任何凭证明文或摘要字段。禁用和启用接口只作用于当前组织内的普通成员；不得通过这些接口修改平台管理员账号。

### 设备授权

```text
POST   /api/v1/admin/users/:userId/device-grants
GET    /api/v1/admin/device-grants
PATCH  /api/v1/admin/device-grants/:grantId
POST   /api/v1/admin/device-grants/:grantId/disable
POST   /api/v1/admin/device-grants/:grantId/enable
DELETE /api/v1/admin/device-grants/:grantId
```

创建请求：

```json
{
  "expiresAt": null
}
```

`expiresAt` 省略或为 `null` 时表示永久授权；非空值必须是晚于服务端当前时间的 ISO 8601 时间。创建响应是唯一一次返回原始令牌和完整连接链接的响应：

```json
{
  "id": "grant-uuid",
  "token": "one-time-secret",
  "connectionUrl": "http://10.0.0.8:3000/connect#token=one-time-secret",
  "expiresAt": null
}
```

`PATCH` 只修改 `expiresAt`。禁用和启用使用显式动作接口，避免把生命周期动作混入通用更新。`DELETE` 执行软删除并永久撤销关联设备。

授权列表以用户为分页单位，返回用户摘要及其授权列表，支持按派生状态筛选。已删除授权默认不展示，可通过显式筛选查看。

## 浏览器连接页

平台生成标准 HTTP 链接：

```text
http://10.0.0.8:3000/connect#token=<secret>
```

服务端公开地址来自必填部署配置 `PUBLIC_URL`，允许是公司内网 IP 加端口。令牌位于 URL fragment；浏览器请求 `/connect` 时不会把令牌加入请求路径或常规访问日志。

`/connect` 是无需登录的公开页面。页面从 fragment 读取令牌，通过以下接口获取预览：

```http
POST /api/v1/auth/device-grants/preview
Content-Type: application/json
Cache-Control: no-store

{"token":"<secret>"}
```

预览响应包含服务端名称、用户显示名、组织名称、授权状态和到期时间，不消费授权。响应使用 `Cache-Control: no-store`；服务端不得记录请求体令牌。

页面展示服务端地址、用户和有效期。用户点击“连接 UCLI”后，页面构造以下协议 URL，传入当前 `location.origin` 和原始令牌并唤起 UCLI：

```text
ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#token=<secret>
```

未安装 UCLI 时显示安装说明和复制连接链接按钮。

## UCLI 设备注册接口

```http
POST /api/v1/auth/device-grants/redeem
Content-Type: application/json
```

请求：

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

绑定算法在数据库事务中完成：

1. 通过令牌摘要查找并锁定授权记录。
2. 校验授权未删除、未禁用、未过期，账号、成员关系和组织均有效。
3. 若未绑定，创建 `Device`、关联授权并记录 `boundAt` 与 `redeemRetryUntil = boundAt + 10 分钟`。
4. 若已绑定，仅当 `installationId` 相同且仍在重试窗口内时允许幂等重试；服务端轮换 refresh token 后重新返回凭证。
5. 不同 `installationId` 或超过重试窗口时返回 `grant_already_bound`。

成功响应：

```json
{
  "accessToken": "jwt",
  "refreshToken": "opaque-refresh-token",
  "expiresIn": 900,
  "account": {
    "id": "account-uuid",
    "displayName": "成员姓名"
  },
  "organization": {
    "id": "organization-uuid",
    "name": "组织名称"
  },
  "authorization": {
    "expiresAt": null,
    "serverTime": "2026-08-26T04:00:00.000Z"
  }
}
```

UCLI 成功保存 refresh token 后不得继续保存原始授权令牌。

## 授权元数据同步

以下成功响应统一携带最新授权信息：

- 设备注册响应。
- `POST /api/v1/auth/token/refresh`。
- `GET /api/v1/client/bootstrap`。

```json
{
  "authorization": {
    "expiresAt": "2026-12-31T16:00:00.000Z",
    "serverTime": "2026-08-26T04:00:00.000Z"
  }
}
```

永久授权返回 `expiresAt: null`。UCLI 缓存最后一次成功同步的有效期，以便授权到期后服务端已经拒绝请求时仍能展示准确提示。服务端返回 `serverTime`，客户端用它校正本机时钟偏差。

## 鉴权与错误

access token 鉴权与 refresh token 轮换都校验：

```text
全局 Account.status 有效
+ 组织有效
+ 当前组织 Membership.status 有效
+ 设备未永久撤销
+ 关联授权未禁用、未删除、未过期
```

稳定错误码：

```text
invalid_grant
grant_disabled
grant_expired
grant_already_bound
grant_deleted
account_inactive
organization_inactive
invalid_device
```

授权禁用、删除或到期在下一次受保护请求时立即生效，不等待 JWT 自身过期。UCLI 收到授权错误后只停用服务端模型、服务端技能同步和后续服务端能力，不删除本地数据。

## 管理后台

### 用户管理页

- 创建普通用户：显示名和邮箱。
- 展示账号状态、角色、设备数、授权数和最近使用时间。
- 用户详情展示全部授权和设备。
- 可为用户创建新授权，默认永久，也可指定到期时间。
- 设备展示名称、平台、客户端版本、绑定时间、最后活跃时间和对应授权。
- 禁用当前组织成员后提示该成员在当前组织的全部设备会立即停止访问服务端。

### 授权令牌页

- 以用户为分页单位聚合展示。
- 展示脱敏提示、派生状态、创建人、创建时间、有效期、绑定设备和绑定时间。
- 支持状态筛选、修改有效期、改为永久、禁用、重新启用和删除。
- 创建完成弹窗展示完整链接并支持复制，明确提示关闭后不能再次查看完整令牌。
- 删除前明确提示关联设备将被永久撤销；禁用前提示重新启用后设备可恢复。

## 数据迁移与移除项

- 将 `Account.passwordHash` 改为可空，保留所有现有密码摘要。
- 创建 `DeviceGrant` 表、关系、唯一约束和查询索引。
- 扩展 `Device` 字段；现有设备没有关联授权，迁移后不能继续访问服务端，需要新授权重新注册。
- 删除 `Invitation` 和 `DeviceAuthorization` 模型及数据库表。
- 删除 `/api/v1/auth/invitations/accept`、`/device/code`、`/device/token`、`/device/approve`。
- 删除管理后台旧邀请接受页和设备码审批页。
- 保留账号、成员关系、组织、配额、使用日志、审计和其他业务数据。
- 发布说明明确旧邀请、待审批设备码和旧设备 refresh token 全部失效。

## 安全约束

- 该部署明确允许 HTTP，前提是公司内网被视为可信网络。
- 令牌不得出现在服务端请求 URL、日志、审计元数据或错误信息中。
- 预览和兑换响应使用 `Cache-Control: no-store`。
- 管理接口必须校验组织边界，不能读取或管理其他组织的用户和授权。
- 创建、绑定、禁用、启用、延期和删除均写入审计日志，但只记录授权 ID 和脱敏提示。
- refresh token 保持单次使用后轮换。
- 并发兑换必须通过事务和条件写入保证只有一台设备成功。

## 验证策略

- 用户服务：创建无密码成员、邮箱归一化、重复邮箱和组织权限隔离。
- 授权服务：永久授权、自定义有效期、摘要存储、脱敏输出、延期和状态推导。
- 兑换服务：正常绑定、并发抢占、相同安装 ID 的 10 分钟重试、不同安装 ID 拒绝和重试窗口超时。
- 生命周期：禁用立即失效、启用恢复、到期失效、延期恢复、删除永久撤销。
- 鉴权：access token 和 refresh token 均受实时授权状态约束，refresh 返回最新有效期。
- 浏览器页：fragment 不进入 HTTP 请求 URL、预览不消费授权、协议唤起参数正确。
- 管理后台：按用户聚合、筛选、创建链接、延期、永久、禁用、启用和删除交互。
- 协议：UCLI 独立模式、单服务端连接、有效期同步、提醒和能力降级均有明确说明。
- 最终执行 `npm run typecheck`、相关 Vitest 测试、覆盖率、服务端构建和管理后台构建。

## 发布顺序

1. 发布服务端数据库迁移、授权 API、鉴权变更、浏览器连接页和管理后台。
2. 服务端管理员创建测试用户和测试授权，使用契约测试验证预览与兑换。
3. UCLI 客户端按独立升级方案实现并发布。
4. 提醒现有用户升级 UCLI，并由管理员为每台设备创建新授权。
5. 旧客户端不会通过设备码兼容路径继续连接服务端。
