# 0.9.6 — 跨组织单元抽调攻坚项目

状态：2026-09-28 已部署公司服务器并通过基础设施与 API 健康验收；管理员密码已轮换导致登录 401，浏览器/API 人工验收待有效凭证后补做。

## 变更范围

- 项目挂靠放宽：手工建项目的挂靠校验从遗留 `type='REGION'` 切换到收敛后口径 `org_type IN ('REGION','EXECUTIVE')`，公司经营层（EXECUTIVE）可承载业务类攻坚项目；职能部门与遗留项目组仍不可挂靠。
- 跨组织单元抽调治理：向项目添加不属于挂靠单元的成员仅限平台管理员（403 文案 `Platform administrator required to add cross-unit members`）；单元内加人维持组织管理员权限；移除成员自动撤销项目 Key 的行为不变。
- 新增成员候选接口 `GET /api/v1/admin/projects/:id/member-candidates`：全组织活跃成员搜索（姓名/邮箱模糊匹配），返回归属组织单元（含 primary 标注）与 `inRegion` 标记，排除已有项目成员，确定性分页。
- 组织单元 `kind` 过滤支持逗号分隔多值（`kind=REGION,EXECUTIVE`），单值传参向后兼容。
- 管理端：新建项目挂靠选项纳入公司经营层；项目详情加成员改为跨单元可搜索选择器，候选人展示归属单元，组织管理员视角跨单元候选置灰并提示，候选加载带代次守卫。
- 零 schema 迁移：成员资格、员工 Key、项目预算、网关校验全部复用既有机制。

## 验证

- `npm run verify` 全绿：typecheck、935 项测试通过（含 PostgreSQL 集成测试）、覆盖率门槛、后端与管理端构建、license 检查。
- 全部 6 个实现任务经过规格符合性与代码质量两阶段审查，最终整体审查通过。
- 设计文档：`docs/superpowers/specs/2026-09-27-cross-unit-taskforce-projects-design.md`。

## 发布件

- 离线包：`F:\projects\ucli-server\releases\ucli-server_0.9.6_20260927_4f6f7b4.tar.gz`
- 离线包大小：`208,654,393` 字节
- 离线包 SHA-256：`b380f4bbd30a7c374b8edcfe85d1b4148d4cfe23559e5b908189a86ded021ef3`
- Runtime 镜像：`ucli-server-runtime:0.9.6`
  `sha256:ef7108bddcb429574cb090fd4dd91a3e2e7124843ae7d8f2fbc2b803b2cd41de`
- Web 镜像：`ucli-server-web:0.9.6`
  `sha256:e867fd34678a966f18de47cd9fcc1ea6698e39ebcaedc86d37d0dbb6ed852feb`
- 包内校验通过；未包含 `.env`、数据库备份、凭据或私钥。
- 构建门禁：`npm ci` + `npm run verify` 全绿（935 项测试，含 PostgreSQL 集成测试）。

## 公司部署记录

- 部署时间：2026-09-28。
- 目标：`http://10.44.100.100`，部署目录 `/data/ucli-server`。
- 升级前版本：`0.9.5`（源码提交 `77451f7f8caedf0ed1b7ec5714f8f6994bdb0aa9`）。
- 升级后版本：`0.9.6`（源码提交 `4f6f7b4145040675e9ea910eb010cdbb9c1961eb`）。
- 数据库迁移：`No pending migrations`（本版零迁移）；升级前备份 `/data/ucli-server/backups/ucli_pre_0.9.6_20260927_215952.dump`，与上一版镜像成对保留。
- 迁移前数据修复（经授权的一行更新）：`usage_groups` 中"研发部"遗留 `type='REGION'` 与收敛后 `org_type='FUNCTIONAL'` 不一致，已将 `type` 对齐为 `DEPARTMENT`；S9 核对由 1 行归零。该行名下仅 `DEPT-RD` 部门预算项目，无业务项目受影响。
- `conf/.env` 仅 `VERSION` 行由 `0.9.5` 改为 `0.9.6`，其余行经遮蔽比对逐字节一致；`MASTER_KEY` 等密钥未触碰。
- 健康验收：4 个应用容器均为 0.9.6 镜像且运行镜像 ID 与 `RELEASE` 逐一吻合；`/healthz` 与 `/gateway/healthz` 均 `status:ok`（postgres/redis 依赖 ok）。
- 待补验收：管理员密码已轮换，登录 401，浏览器与 API 人工验收待有效凭证后执行（管理端"项目管理"新建项目应出现公司经营层选项、项目详情加成员为跨单元可搜索选择器）。

## 已知事项

- GitHub Actions CI（run `36318597523` 起）因 `quay.io/minio/minio` 仓库拒绝匿名拉取导致 storage 相关测试失败，与本版改动无关（功能代码对应 job 全绿）；测试镜像源切换另行处理。
- 服务器 `/data/ucli-server/images/` 仍保留 0.7.0–0.9.5 历史镜像 tar，`install.sh update` 每次会全部重载（约 1 分钟，无害）；后续可择期清理。
