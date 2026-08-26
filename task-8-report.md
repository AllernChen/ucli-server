# Task 8：设备授权协议发布报告

## 已交付

- 替换桌面端协议：浏览器 fragment 链接、`ucli://` 唤起、preview/redeem JSON、`installationId`、同安装 10 分钟重试、refresh token 安全存储与轮换、授权元数据和稳定错误码。
- 明确 UCLI 独立模式、单服务端连接，以及服务端模型/技能/后续能力与本地能力的隔离降级。
- 更新 README、部署/回滚说明和变更记录，声明平台预创建成员、每设备授权及旧流程不兼容。
- 在未发布迁移中，于 `device_authorizations` 表删除后删除 `DeviceCodeStatus` 类型；Prisma schema 中不存在该枚举。
- 增加发布契约测试，覆盖上述协议、部署、破坏性变更和迁移顺序。

## TDD 与验证证据

- 红：`npx vitest run test/auth/device-grant-protocol.test.ts` 初次运行 5/5 失败，原因是协议仍引用 `/api/v1/auth/device/code`、发布文档未更新、迁移缺少枚举删除。
- 绿：同一命令随后通过，5/5 用例通过。
- 定向验证：`npx vitest run test/auth test/admin/device-grant-connect.test.ts test/admin/device-grant-management.test.ts test/admin/device-grant-views.test.ts test/http/audit-interceptor.test.ts test/gateway/access-policy.test.ts` 通过，17 个文件、128 个用例。
- Prisma：`npm run db:generate` 通过。
- 全量：`npm run verify` 通过：类型检查、覆盖率、构建、管理后台构建和许可证检查全部通过；Vitest 为 73 通过文件、1 个预期跳过文件、438 通过用例、1 个预期跳过用例。管理后台构建仅报告既有的大 chunk 建议，未失败。

## 扫描结果与解释

执行 `rg -n -S "(Invitation|DeviceAuthorization|device/code|device/approve|invitations/accept)" apps packages docs README.md`：

- `apps/` 与 `packages/` 无命中，README 和发布协议无旧流程。
- 设计文档第 328–329 行命中，是明确列出要删除的模型和端点，不是兼容协议。
- 历史实施计划第 697 行命中，是删除旧服务方法的计划；第 1053 行是本扫描命令本身。两者均非运行时或面向客户端的协议。

执行 `rg -n -S "(tokenHash|refreshTokenHash|grant-secret)" apps/admin apps/api/src | Sort-Object`：

- `apps/admin` 无 `tokenHash`、`refreshTokenHash` 或 `grant-secret` 命中；浏览器页只在组件局部变量中短暂使用 fragment 令牌以预览和唤起 UCLI，既不渲染到 DOM，也不写日志或 serializer（由既有连接页测试覆盖）。
- `auth.service.ts` 的 3 处命中只用于以 refresh token 摘要查询及条件更新轮换。
- `device-grants.service.ts` 的 6 处命中只用于创建时摘要持久化、兑换时摘要查找/事务锁定、以及 refresh token 摘要持久化。
- 命中中没有 serializer、日志或审计输出；原始 grant token、`tokenHash` 和 `refreshTokenHash` 不会进入这些边界。

`git diff --check` 未发现空白错误；其输出仅包含 Git 对本仓库 CRLF 自动转换的工作区提示。

## 迁移警告

迁移会删除 `invitations`、`device_authorizations` 和 `DeviceCodeStatus`，并撤销已有设备，因此必须在 `./install.sh update` 前执行标准数据库备份（开发仓库为 `./scripts/backup.ps1`，Linux 包使用既有平台备份流程）。旧表删除后无法仅回滚应用二进制；回退必须同时恢复升级前数据库备份和上一版应用镜像。

## 客户端交接清单

客户端仓库应以 `docs/ucli-client-registration-upgrade.md` 与 `docs/ucli-client-protocol.md` 为共同交接材料，并完成：

- `ucli://` 处理器和设置页完整链接解析；确认页必须先 preview 后 redeem。
- 单服务端连接替换、持久化 `installationId`、10 分钟同安装重试。
- refresh token 仅入系统安全存储、原子轮换；原始 grant token 不落盘、不记录。
- redeem、refresh、bootstrap 的 `authorization.expiresAt`/`serverTime` 同步及到期提醒。
- 稳定错误映射，并只降级服务端模型、技能和后续能力，保持本地功能和数据可用。

客户端实现不属于本服务端分支。
