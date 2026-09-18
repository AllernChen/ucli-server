# 0.7.1 — 管理员修改员工登录邮箱

状态：2026-09-19 已部署公司服务器（10.44.100.100），基础设施、迁移与受保护路由验收通过；首次登录真实账号交互验收待确认。功能源提交 `6171649`（管理员改邮箱）与首次登录引导提交（基于 0.7.0 部署后主线），发布源提交 `29759da`。

## 变更范围

- 新增 `PATCH /api/v1/admin/users/:id/email`：管理员修改员工登录邮箱。校验：仅平台/组织管理员、目标须为当前组织成员、**禁止修改自己的邮箱**（防笔误自锁，与角色自改禁令同一防线）；邮箱全局唯一冲突返回 409；大小写与空白归一化。
- 语义：邮箱仅为登录标识，本变更不递增 `tokenVersion`——已登录网页会话与设备访问不受影响，员工随后以新邮箱登录。审计记录修改前后邮箱。
- 用户详情页新增「修改邮箱」抽屉。
- 数据库新增 1 条迁移（18 条总计）：`accounts.pending_credential_change` 布尔列，存量默认 false；无新依赖、无网关/协议变更。

## 背景与用法

0.7.0 业务初始化采用占位邮箱（平台无邮件功能，邮箱仅作登录账号且此前创建后不可改）。本功能提供双通道：管理员随时改（用户详情「修改邮箱」）；员工首次登录被强制引导设置自有新密码并可选把占位邮箱换为真实邮箱（管理员设置过初始密码的账号自动进入引导；完成前个人中心不可用，完成后以新凭据重新登录）。设备会话与无密码账号不受影响。

## 已完成验证

typecheck、全量单测 783 项通过（仅剩既知 Git Bash tar 环境用例）；覆盖 updateEmail 全分支与首次登录引导全分支（成功/保留邮箱/错密码 401/标记已清 401/短密码 400/重复邮箱 409/设备会话 403/管理员置位与清位）。CI 于推送后运行完整 verify。

## 发布操作流程

1. CI 绿后构建 `ucli-server-runtime:0.7.1` / `ucli-server-web:0.7.1` 离线包。
2. 依照 [0.7.0 发布记录](release-0.7.0.md) 同一流程升级（本版含 1 条迁移，18 条总计）：备份 → `VERSION=0.7.0`→`0.7.1` → `./install.sh update` → 健康与镜像验收；升级后用任一初始密码账号登录验证引导流程。

## 公司服务器升级记录（2026-09-19）

- 门禁：推送 `main` 后 CI run `35343350958` 三个 Job（`verify` / `group-integration` / `docker-build`）全部通过。
- 离线包：`ucli-server_0.7.1_20260918_29759da.tar.gz`（SHA-256 `e0acc80e8b1f3ed59ed0d7c0f418a54bcaa72d18639b2799b44064a80d000432`）；远端解包后 `SHA256SUMS` 八项全部通过，包内无 `.env` 或凭据文件。
- 升级前预检：生产仍为 0.7.0 / `831e477`，API/Gateway healthy，Compose v2 `2.29.7`，外部网络 `config_default` 与 `ai-bot-cowork-deploy` 均存在，`/data` 剩余 18T；迁移基线 17 条且 up to date。
- 升级前备份：`/data/ucli-server/backups/production-070-831e477-before-071-29759da-20260918-2358/`。数据库 `ucli.dump` SHA-256 `ca6b2d8140ae06175e22019f3d4f3301add90f44dd9e9cf256031621a517b06a`；0.7.0 runtime/web 镜像归档 SHA-256 `50afc5120875e0c66143cb1906aff70c113d5a0baa2445410d3d54f0c9be2f71`；`conf/.env` 仅保存哈希，未复制或展示内容。
- 配置与迁移：`conf/.env` 仅做字节级 `VERSION=0.7.0`→`0.7.1` 替换，升级后哈希与预计算一致；`MASTER_KEY` 未触碰、未展示。`./install.sh update` 先加载镜像再迁移后启动，唯一新增迁移 `20260918115240_account_pending_credential_change` 应用成功，迁移总数 17 → 18，迁移后 schema up to date。
- 验收：API/Gateway `/healthz` 均 `status=ok` 且 PostgreSQL/Redis `ok`；四容器运行 0.7.1 镜像，API/Gateway healthy；运行镜像 ID 与 `RELEASE` 一致（runtime `sha256:dc8fb3afcb94…`、web `sha256:a328cc79497a…`）；外部页面 `http://10.44.100.100/` HTTP 200；无凭据探测 `/api/v1/auth/me`、`/api/v1/auth/initial-credentials`、`/api/v1/admin/users/:id/email` 均 401，确认新路由存在且受保护。
- 回滚边界：正式回滚必须恢复上述升级前数据库备份、加载 `previous-images-0.7.0.tar.gz`，并继续使用同一生产 `MASTER_KEY`，三者作为整体单元执行，不单独回滚应用二进制。
- 待办：使用真实初始密码账号完成登录后的首次引导交互验收（设置新密码、可选换邮箱、重新登录）。
