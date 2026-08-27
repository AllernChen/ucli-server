# 设备授权连接链接管理设计

日期：2026-08-27

## 背景

当前实现把 `PLATFORM_ADMIN` 和 `ORG_ADMIN` 视为纯管理身份，只允许启用的 `MEMBER` 获得设备授权；授权记录本身同时承担连接凭证职责，完整连接 URL 只在创建时展示一次。这不符合实际使用需求：任意启用账号都可能注册 UCLI，平台管理员需要在授权创建后查看原 URL，也需要在不更换授权令牌的前提下重新生成 URL 并使旧 URL 失效。

本设计将稳定的设备授权与可轮换的连接链接拆分为两个领域对象。服务端项目实现数据模型、管理接口、浏览器连接页、协议文档和客户端升级方案；UCLI 客户端代码仍由独立项目实施。

## 目标

- `PLATFORM_ADMIN`、`ORG_ADMIN`、`MEMBER` 均可在满足启用条件时拥有设备授权。
- 授权记录保持稳定；重新生成 URL 不更换授权 ID、不改变授权有效期或绑定状态。
- 连接 URL 拥有独立有效期，默认 7 天，并支持 1 天、7 天、30 天、永久和自定义截止时间。
- 创建授权时自动生成首条 URL；未绑定时可以查看、复制或重新生成 URL。
- 重新生成 URL 后旧 URL 立即失效。
- 管理员关闭成功提示后仍可查看当前 URL。
- 一个授权仍只能绑定一个设备；绑定后不能重新生成 URL。
- UCLI 继续获得授权有效期和服务端时间，用于到期提醒。

## 非目标

- 不在本仓库实现 UCLI 客户端代码。
- 不保留现有 `#token=`、`token` Preview/Redeem 请求字段或旧授权数据模型兼容。
- 不允许一个授权绑定多个设备；新设备需要新的授权记录。
- 不允许通过历史链接恢复或重新展示已撤销、已使用链接的明文凭证。

## 领域术语

### 设备授权（DeviceGrant）

平台为一个账号创建的稳定授权记录。它决定账号、组织、授权有效期、禁用/删除状态和最终绑定设备。它是用户所称的“令牌”，重新生成 URL 时不重新创建。

### 连接链接（DeviceGrantLink）

设备授权下用于发起一次设备绑定的可轮换链接。它拥有独立凭证、独立有效期和生命周期。一个授权在任意时刻最多有一条当前链接。

### 链接凭证（Link Secret）

连接 URL fragment 中的高熵随机秘密。服务端同时保存哈希和加密密文：哈希用于 Preview/Redeem 查找，加密密文用于授权管理员再次查看当前 URL。

## 授权资格

授权资格不再由角色决定。目标账号满足以下全部条件即可创建和使用设备授权：

- `accounts.status = ACTIVE`；
- 目标组织中的 `memberships.status = ACTIVE`；
- 目标组织处于启用状态；
- 成员角色可以是 `PLATFORM_ADMIN`、`ORG_ADMIN` 或 `MEMBER`。

管理接口仍只允许具备管理权限的 `PLATFORM_ADMIN` 或 `ORG_ADMIN` 调用，并继续限制在调用者可管理的组织范围内。账号、成员关系或组织被禁用后，已有设备授权和设备访问立即失效。

## 数据模型

### DeviceGrant

保留现有稳定授权字段：

- `id`
- `organizationId`
- `accountId`
- `createdById`
- `expiresAt`：授权有效期，`null` 表示永久
- `disabledAt`
- `deletedAt`
- `boundAt`
- `deviceId`
- `createdAt`
- `updatedAt`

从 `device_grants` 移除连接秘密职责。现有 `tokenHash`、`tokenHint` 不再属于授权记录。

### DeviceGrantLink

新增 `device_grant_links` 表：

- `id`
- `deviceGrantId`
- `secretHash`：唯一，用于公开接口查找
- `secretEncrypted`：使用服务端主密钥加密，用于查看当前 URL
- `secretHint`：只用于列表识别，不包含完整秘密
- `expiresAt`：链接有效期，`null` 表示永久
- `revokedAt`：被重新生成替换时设置
- `consumedAt`：设备绑定成功时设置
- `createdById`
- `createdAt`

数据库使用部分唯一约束保证同一授权最多一条未撤销、未使用的当前链接。创建新链接前必须在同一事务内撤销当前链接。过期链接在生成新链接时也设置 `revokedAt`，从而释放当前链接唯一约束。

当链接被撤销或使用时，服务端清空 `secretEncrypted`，仅保留哈希、提示片段和生命周期字段用于审计。历史链接无法从平台恢复完整 URL。

## 状态与有效期

链接状态按以下优先级派生：

1. `CONSUMED`：`consumedAt` 非空；
2. `REVOKED`：`revokedAt` 非空；
3. `EXPIRED`：当前时间不早于 `expiresAt`；
4. `AVAILABLE`：以上条件均不成立。

授权状态继续由绑定、禁用、删除和授权有效期派生。链接有效不代表授权一定可用；Preview 和 Redeem 必须同时校验链接、授权、账号、成员关系和组织状态。

URL 有效期与授权有效期互不修改：

- URL 过期不改变授权状态，未绑定授权可以重新生成链接；
- 授权过期后，即使 URL 尚未过期也不能 Preview 或 Redeem；
- 授权绑定后，当前链接立即变为 `CONSUMED`，不可重新生成；
- 禁用或删除授权时，当前链接随之失效并清除可恢复密文。

## 凭证安全

- 链接凭证使用密码学安全随机源生成，熵不低于现有不透明令牌。
- `secretHash` 使用单向哈希，公开接口只通过哈希查找。
- `secretEncrypted` 使用现有主密钥信封加密能力保存；数据库中不保存明文。
- 查看 URL 时才临时解密，响应使用 `Cache-Control: no-store`。
- 完整 URL 和链接凭证不得进入数据库审计详情、应用日志、错误信息、DOM 隐藏字段、查询参数或浏览器历史。
- 查看、生成、重新生成、绑定均写审计事件，但只记录授权 ID、链接 ID、提示片段、有效期、操作者和结果。
- 只有同组织的 `PLATFORM_ADMIN`、`ORG_ADMIN` 可以查看或重新生成完整 URL。

## 管理接口

### 创建授权及首条链接

`POST /api/v1/admin/users/:userId/device-grants`

请求同时包含：

- `expiresAt`：授权截止时间或 `null`；
- `linkExpiresAt`：URL 截止时间或 `null`。

在单个事务内创建 `DeviceGrant` 和第一条 `DeviceGrantLink`。响应返回授权摘要、当前链接摘要和完整 `connectionUrl`。

### 查看当前 URL

`GET /api/v1/admin/device-grants/:id/link`

仅当前链接存在且可恢复密文尚未清除时返回同一条 `connectionUrl`。链接过期时仍允许管理员查看，但响应明确返回 `EXPIRED` 状态；撤销或使用后的链接不返回完整 URL。响应必须使用 `Cache-Control: no-store` 并记录 `view_link` 审计事件。

### 生成或重新生成 URL

`POST /api/v1/admin/device-grants/:id/links`

请求包含新的 `expiresAt`。若授权没有当前链接则生成；若存在当前链接则先撤销并清除其密文，再创建新链接。响应返回新链接摘要和完整 `connectionUrl`。

授权已绑定、被删除、被禁用或已经过期时禁止生成。并发请求通过事务锁和唯一约束保证只有一个当前链接；冲突请求返回稳定错误，不得产生两个可用 URL。

### 管理查询

用户详情和按用户聚合的授权查询增加 `currentLink` 摘要：

- `id`
- `secretHint`
- `status`
- `expiresAt`
- `createdAt`

查询不返回 `secretEncrypted`、完整 URL 或任何可拼接出凭证的内容。

## 公开连接协议

浏览器连接地址为：

```text
http://<server>/connect#link=<secret>
```

连接页只从 fragment 读取 `link`，随后立即清除地址栏 fragment。公开请求不把秘密放入 URL、查询参数或日志。

### Preview

`POST /api/v1/auth/device-grants/preview`

请求：

```json
{ "link": "<secret>" }
```

响应包含账号、组织、链接状态与有效期、授权状态与有效期、服务端时间。

### Redeem

`POST /api/v1/auth/device-grants/redeem`

请求包含 `link` 和设备元数据。事务执行顺序：

1. 按链接哈希查找并锁定链接；
2. 锁定所属授权；
3. 校验链接未撤销、未过期、未使用；
4. 校验授权、账号、成员关系和组织状态；
5. 校验授权尚未绑定且安装 ID 未被有效设备占用；
6. 创建设备、绑定授权；
7. 标记链接 `consumedAt` 并清空 `secretEncrypted`；
8. 签发设备访问令牌并提交事务。

若首次 Redeem 已提交但响应丢失，客户端可以在现有 10 分钟幂等窗口内使用同一链接凭证和同一 `installationId` 重试。服务端不得创建第二台设备，只轮换该设备的刷新令牌并重新返回凭证。超过窗口、安装 ID 不同或设备状态不一致时返回 `link_consumed`。链接密文在首次成功绑定后仍立即清除；幂等重试只依赖保留的链接哈希。

稳定错误至少包括：

- `invalid_link`
- `link_expired`
- `link_revoked`
- `link_consumed`
- `grant_disabled`
- `grant_expired`
- `grant_deleted`
- `grant_bound`
- `account_inactive`
- `organization_inactive`

## 管理端交互

### 创建授权

用户详情页允许为任意启用角色创建授权。创建抽屉分开展示：

- 授权有效期：默认永久，可自定义；
- URL 有效期：默认 7 天，预设 1 天、7 天、30 天、永久，并支持自定义截止时间。

成功抽屉显示完整 URL、URL 有效期、授权有效期和复制操作。

### 授权管理

用户详情和授权聚合页面展示授权状态、授权有效期、当前链接状态、链接有效期和链接提示片段。未绑定且授权可用时提供：

- 查看 URL；
- 复制 URL；
- 重新生成 URL。

重新生成前显示确认对话框，明确提示旧 URL 会立即失效，并要求选择新 URL 有效期。绑定后隐藏生成操作。所有失败必须显示明确错误；禁用控件必须同时显示不可操作原因，不允许再次出现“点击无反应”。

## 数据迁移

当前已部署数据库没有设备授权数据，但迁移仍按一般情况安全设计：

1. 新建 `device_grant_links` 表、索引和外键；
2. 对现有未绑定授权，将原 `tokenHash` 迁移为历史链接哈希，但因没有可恢复明文，将其标记为 `REVOKED`，管理员需要生成新 URL；
3. 已绑定授权的原凭证迁移为 `CONSUMED` 历史链接；
4. 验证每个授权最多一条当前链接；
5. 删除 `device_grants.tokenHash` 和 `device_grants.tokenHint`；
6. 整个迁移使用显式事务，失败时整体回滚。

迁移前继续要求数据库备份和依赖预检。迁移不会尝试恢复历史明文凭证。

## UCLI 客户端升级方案

服务端仓库更新独立客户端实施文档，明确以下改动：

- 只接受 `#link=`，不兼容 `#token=`；
- Preview/Redeem 请求字段由 `token` 改为 `link`；
- 展示 URL 有效期与授权有效期的区别；
- 对 `link_expired`、`link_revoked`、`link_consumed` 给出联系管理员重新生成链接的提示；
- Redeem 成功后只持久化设备访问令牌和授权有效期，不持久化连接链接凭证；
- 继续在授权临近到期时提醒用户联系管理员延长授权。

## 审计事件

新增或调整以下事件：

- `device_grant.create`
- `device_grant_link.create`
- `device_grant_link.view`
- `device_grant_link.regenerate`
- `device_grant_link.redeem`
- `device_grant_link.expire` 不单独写定时事件，状态按时间派生
- `device_grant.disable`
- `device_grant.enable`
- `device_grant.delete`

审计详情只允许包含 ID、提示片段、有效期、状态变化和结果，不得包含完整 URL、哈希、密文或明文凭证。

## 测试策略

- 资格矩阵：三个角色在启用状态均可获授权；账号、成员关系或组织禁用时拒绝。
- 数据模型：当前链接唯一约束、历史链接保留、撤销/使用后密文清除。
- 加密：链接密文可由正确主密钥恢复，错误密钥明确失败，日志和错误不泄露秘密。
- 有效期：授权与 URL 的永久、预设、自定义和交叉过期组合。
- 轮换：查看返回同一 URL；重新生成返回新 URL；旧 URL 立即返回 `link_revoked`。
- 并发：并发重新生成只保留一个当前链接；并发 Redeem 只有一个设备绑定成功。
- 幂等重试：首次 Redeem 响应丢失后，同一安装 ID 在 10 分钟内可重新获得凭证；其他安装 ID 和超时重试返回 `link_consumed`。
- 管理 API：组织隔离、角色权限、`Cache-Control: no-store` 和稳定错误。
- 管理端：真实点击创建、查看、复制、重新生成；禁用原因可见；错误有反馈；DOM、地址栏和诊断路径不泄露凭证。
- 协议契约：`#link=`、Preview/Redeem JSON、稳定错误和客户端升级文档一致。
- 迁移：有无历史授权、已绑定/未绑定授权及事务回滚路径。

## 发布与回滚

该变更包含数据库迁移和协议破坏性变化，作为独立版本发布。发布前执行完整测试、镜像构建、离线包校验、数据库备份和迁移预演。客户端需按升级文档独立实施后再进行真实绑定验收。

回滚必须同时恢复上一版数据库备份和上一版服务端镜像；只回滚镜像会因 schema 不兼容而失败。
