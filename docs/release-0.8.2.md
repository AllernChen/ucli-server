# 0.8.2 — 员工 Key 明文查看与用量组成员项目视图

状态：2026-09-19 已部署公司服务器并通过生产烟测。实现源提交 `ea787cd7a8a02ccae2288b13e10d654f652188f0`，CI run `35451039830` 三 Job 全绿。

## 变更范围

- 员工 Key 新增安全明文查看能力：
  - 数据库新增 `employee_api_keys.secret_ciphertext`、`secret_iv`、`secret_tag` 三个可空密文列；
  - 新签发 Key 在保留 SHA-256 认证哈希和尾号的同时，另用 `MASTER_KEY` 保存 AES-256-GCM 可恢复密文；
  - `POST /api/v1/admin/employee-api-keys/:id/reveal` 仅限网页管理员，必须验证当前管理员登录密码；
  - 响应带 `Cache-Control: no-store`，成功解密写入审计，不记录明文；
  - 项目 Key 详情默认只显示尾号；输入密码验证后可查看和复制完整 Key，关闭抽屉即清空明文。
- 存量 23 把当前有效项目 Key 已使用一次性发放清单回填：
  - 回填前逐条用 SHA-256 哈希校验明文与数据库记录一致；
  - 校验通过后用生产 `MASTER_KEY` 加密入库；
  - 容器与服务器上的明文清单副本已立即删除；
  - 生产 `MASTER_KEY` 未读取到日志、未展示、未修改。
- 用量组详情新增「关联项目」页签：
  - 项目额度、已用 / 预占 / 可用；
  - 职责成员数量、负责人；
  - 有效 Key 数量；
  - 「查看 Key」直达项目 Key 页签。
- 用量组成员列表增强：
  - 新增「所属项目」，来源区分 `职责` 与 `Key`；
  - 新增近 30 天组内用量：请求数、Token、采购成本、最后使用时间。

## 验证

- PostgreSQL 集成测试覆盖：
  - 新 Key 同时保存认证哈希与可恢复密文；
  - 列表不泄漏明文或密文字段；
  - 非管理员、错误密码、旧格式 Key 分别返回 403 / 401 / 409；
  - 正确密码可解密返回明文并写入不含明文的审计；
  - 一次性回填脚本仅在哈希匹配时加密旧 Key；
  - 区域项目汇总和成员项目 / 用量扩展。
- 管理端组件测试覆盖：
  - Key 默认只显示尾号；
  - 密码验证后才显示明文；
  - 可复制明文；
  - 切换查看另一把 Key 时自动清空上一把明文；
  - 用量组详情项目页签和成员项目 / 用量列。
- HTTP 集成测试覆盖 reveal 端点、`no-store` 与错误密码语义。
- 本地完整 `npm run verify` 通过：144 个测试文件、904 个用例，覆盖率 94.43% statements / 85.67% branches。
- CI `verify`、`group-integration`、`docker-build` 三 Job 全绿。

## 数据库变更

- 新增迁移：`202609190002_employee_key_revealable_secrets`
- 迁移内容：为 `employee_api_keys` 增加三个可空密文列。
- 本版共 20 条迁移；生产升级时仅应用上述 1 条新增迁移。

## 发布件

- 离线包：`ucli-server_0.8.2_20260919_ea787cd.tar.gz`
- 包 SHA-256：`3a6bb69ac2aabdf30e1f4d800732132d2a6132d0c46ce0f4235042bab407fcfc`
- 包内 8 项 `SHA256SUMS` 全部通过；
- 包内不包含 `.env`、凭据、SSH 私钥或数据库备份。

## 公司服务器部署记录（2026-09-19）

- 升级前版本：0.8.1，源提交 `b7d86b7816091b33ed437e65d893ee671e8eae11`
- 升级前备份：
  - `/data/ucli-server/backups/production-081-f6012db-before-082-ea787cd-20260919/`
  - 数据库备份 SHA-256：`d62536c1252cf8f6e8e4c3decbc5a8376485cd7be4f208201ab8acf105285e0b`
  - 0.8.1 镜像归档 SHA-256：`abbd167c3455a64283b8a3d2b743405cf139233d7793458542b20d420d0d72b5`
- `conf/.env` 仅替换 `VERSION=0.8.1` → `0.8.2`；`MASTER_KEY` 保持原值。
- `./install.sh update` 先加载数据库迁移，再重建应用容器；迁移 `202609190002` 成功应用。
- 运行镜像：
  - `ucli-server-runtime:0.8.2` = `sha256:3682930c464338c73c9d77f33d755e7ac9139f07f273e6f531bf13f39ffce5e0`
  - `ucli-server-web:0.8.2` = `sha256:427a347bb8dbc4eca168ccee1829db2c6b65a17d4617d5656b6a0ee65608f2ff`
- API / Gateway health 均 `ok`，PostgreSQL / Redis 均 `ok`，Worker 与 Web 正常运行，外部页面 HTTP 200。

## 生产烟测

- 当前有效项目 Key：23 把；
- 可恢复项目 Key：23 把；
- 抽样密码验证 reveal 成功，明文格式正确；烟测输出未包含完整 Key；
- 7 个区域均返回项目汇总；
- 抽查 `贵州区域`：
  - 关联项目 1 个；
  - 项目预算存在；
  - 成员 6 人；
  - 抽样成员关联项目 1 个；
  - 成员请求数 / Token / 采购成本 / 最后使用时间字段齐备。
- 一次性回填输出：`matched=23, encrypted=23, alreadyRecoverable=0`。

## 已知边界

- 早期未保存可恢复密文的历史 Key 无法从哈希反推出明文。当前 23 把有效项目 Key 已全部回填；2 把仍在使用但未绑定项目的旧 Key 无法明文查看，如需查看应签发替代 Key 并同步使用者。
- 本地一次性发放清单仍包含明文 Key，完成人工分发后应离线保存或安全删除。
