# 0.8.1 — 用量组区域项目明细与员工 Key 查看

状态：2026-09-19 已部署公司服务器并通过生产烟测。实现源提交 `b7d86b7816091b33ed437e65d893ee671e8eae11`，CI run `35447698262` 三 Job 全绿。

## 变更范围

- 用量组首页新增「关联项目」列，展示每个区域的 active 项目数量和项目名称。
- 区域行支持折叠展开：
  - 项目额度；
  - 已用 / 预占 / 可用金额；
  - 职责成员数量；
  - 项目负责人；
  - 有效项目 Key 数量；
  - 「查看 Key」直达项目 Key 页签。
- 项目 Key 列表补充状态、最后使用时间和安全详情抽屉。
- 详情仅展示密钥尾号与安全元数据；完整密钥仍只在创建时展示一次。
- 后端用量组列表一次性批量返回项目预算、成员、负责人和 Key 汇总，避免前端展开时额外请求。

## 验证

- 新增 PostgreSQL 集成测试覆盖区域项目数量、预算、负责人和有效 Key。
- 新增管理端组件测试覆盖项目数量、折叠明细、查看 Key 跳转和 Key 详情。
- `npm run typecheck`、focused tests、真库集成测试、`npm run admin:build` 通过。

## 公司服务器部署记录（2026-09-19）

- 离线包：`ucli-server_0.8.1_20260919_b7d86b7.tar.gz`
- 包 SHA-256：`ca214d53b53d493884dd9cede2debff7456fb69a19ffac82dd097a352a8583cc`
- 远端 8 项 `SHA256SUMS` 全部通过，包内无 `.env`。
- 升级前备份：`/data/ucli-server/backups/production-080-1e86705-before-081-b7d86b7-20260919/`
- 数据库备份 SHA-256：`01fe1c209965657ff6645bd5a2f2d0b6eead6c7bd6157ae2e8e6661a1c69710e`
- 0.8.0 镜像归档 SHA-256：`a3dbb1ece1f6bc780adfb1afefce4e2aaa69a4afda2309610803f8c447d785e6`
- `conf/.env` 仅替换 `VERSION=0.8.0` → `0.8.1`；`MASTER_KEY` 未读取、未展示、未修改。
- 本版无新增迁移；`./install.sh update` 确认 19 条迁移均无待应用。
- 部署后四容器运行 0.8.1，API/Gateway healthy，PostgreSQL/Redis 均 `ok`，外部页面 HTTP 200。
- 管理端只读烟测确认 7 个区域均返回项目汇总；抽查 `贵州区域 / 贵州-贵州` 返回项目额度、负责人和项目 Key 列表。
