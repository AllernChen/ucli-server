# 跨组织单元抽调攻坚项目设计

状态：设计已与需求方确认（2026-09-27），待实现。

## [S1] 背景与问题

实际工作中会从各组织抽调成员组成攻坚项目。0.9.0「组织项目收敛」后的现状（`origin/main`，0.9.5）：

- 公司为**单一 `Organization`**，内部组织以 `UsageGroup.orgType`（EXECUTIVE/FUNCTIONAL/REGION/LEGACY_PROJECT）表达，即"组织单元"。
- 项目成员资格、员工 Key、网关校验的外键全部钉在公司级 `Organization` 上，**跨组织单元成员在数据层已可行**：`addMember`（`apps/api/src/projects.service.ts`）只校验候选人是本公司任一活跃组织单元的成员，不要求属于项目挂靠单元。
- 个人中心"我的项目"（`me-projects.service.ts`）的可见性 OR 条件（项目成员 或 区域单元成员）已覆盖被抽调成员。

真正的缺口只有两处：

1. **挂靠缺口**：手工建项目 `region()` 校验强制 `type='REGION'`，项目只能挂业务区域，挂不上公司经营层（EXECUTIVE）。
2. **前端缺口**：`ProjectDetail.vue` 加成员候选人只取 `/org-units/${regionId}/members`（仅本单元、写死 limit=100），跨单元成员界面上选不到。

## [S2] 目标与非目标

**目标**：平台管理员可创建挂靠公司经营层的攻坚项目，从任意组织单元抽调成员、签发项目 Key、设置独立预算（经营层专项承担）；抽调关系手动开始/结束。

**非目标**（本期不做）：

- 借调期与到期自动回收（已确认手动退出）。
- 跨单元抽调审批流（已确认仅平台管理员操作）。
- 按成员归属组织单元拆分项目用量报表（数据已具备，列为后续可选）。
- 跨公司级 `Organization` 的成员资格（复合外键保持不动）。
- 不改 `archive` 不撤 Key 的现状，收尾顺序以操作约定保障（见 [S7]）。

## [S3] 总体方案

攻坚项目 = **挂靠 EXECUTIVE 组织单元的 BUSINESS 类项目**。成员资格、员工 Key（要求非 VIEWER 项目成员）、项目预算（TOTAL/MONTHLY、调整台账、申请批复）、网关实时校验、个人中心可见性全部复用现有机制。

**零 schema 迁移**：`ProjectMember`/`EmployeeApiKey` 复合外键指向公司级 `Membership`，跨单元成员无需任何数据层改动。

## [S4] 挂靠放宽

`projects.service.ts` `region()` 的原生 SQL 校验从

```sql
AND type = 'REGION'
```

改为按收敛后的权威口径 `org_type`：

```sql
AND org_type IN ('REGION', 'EXECUTIVE')
```

- FUNCTIONAL / LEGACY_PROJECT 单元仍不可挂项目；DEPARTMENT 类项目由组织自动同步创建的既有路径不受影响（`create()` 对 DEPARTMENT 的拒绝保留）。
- `enabled = true`、`archived_at IS NULL`、`FOR UPDATE` 语义保持不变。
- 同名/同码唯一约束（`@@unique([organizationId, regionId, name])` 及 code 同理）照旧生效。

## [S5] 跨单元成员治理

1. **新接口** `GET /api/v1/admin/projects/:id/member-candidates?q=&offset=&limit=`
   - 角色：PLATFORM_ADMIN / ORG_ADMIN（供成员选择器使用）。
   - 返回条件：公司内 ACTIVE 账号、`Membership` ACTIVE、至少属于一个活跃组织单元（enabled、未归档），**排除该项目已有成员**。
   - 每项字段：`accountId`、`displayName`、`email`、`orgUnits[]`（`id`/`name`/`orgType`/`isPrimary`）、`inRegion`（是否属于项目挂靠单元；EXECUTIVE 项目对经营层成员为 true）。
   - `q` 匹配姓名或邮箱，默认分页沿用现有 `PageQueryDto` 口径；组织作用域与其他 admin 接口一致（`organizationId = actor.organizationId`）。
2. **权限收紧**（落实"跨单元拉人仅平台管理员"）：`addMember` 增加判断——候选人**不属于项目挂靠单元**（跨单元）时要求 `PLATFORM_ADMIN`，否则 403；**单元内**加人维持 ORG_ADMIN 可用。其余 `mutate`/审计/DEPARTMENT 拦截逻辑不动。
3. `removeMember` 现有行为保持：移除成员自动撤销该项目上的有效 Key。

## [S6] 前端改动（apps/admin）

1. **建项目表单**（`views/Projects.vue`）：区域选项来源 `/api/v1/admin/org-units?kind=REGION` 扩展为 `kind=REGION,EXECUTIVE`（`kind` 过滤支持逗号分隔列表）；选项文案区分"业务区域/公司经营层"。
2. **项目详情**（`views/ProjectDetail.vue`）：加成员下拉改为可搜索选择器，数据源换为 `member-candidates`；候选人显示"姓名 · 邮箱 · 归属单元（primary 标注）"；ORG_ADMIN 视角下跨单元（`inRegion=false`）候选人置灰并提示需平台管理员操作。角色选项 OWNER/CONTRIBUTOR/VIEWER 不变。

## [S7] 操作流程与收尾约定

1. 平台管理员建项目：挂公司经营层，填编码/名称，设项目预算。
2. 拉人：candidates 搜索 → 加为 OWNER/CONTRIBUTOR → 按现有规则签发项目 Key。
3. 攻坚期间：成员在个人中心"我的项目"可见；用量与预算消耗实时归集本项目，不从原部门预算扣减。
4. 收尾（**顺序必须为**）：先逐个移除成员（自动撤 Key），处理完预算预占/待核对后归档项目。注意现有 `archive` 仅校验未结算预算条目、**不撤 Key**（见 [S2] 非目标）。

## [S8] 测试与验收

- 挂靠：EXECUTIVE 可建；FUNCTIONAL / LEGACY_PROJECT 拒绝；停用/归档单元拒绝；DEPARTMENT 手工创建仍拒绝。
- 治理：ORG_ADMIN 跨单元加人 403；PLATFORM_ADMIN 跨单元可加；单元内 ORG_ADMIN 可加；DEPARTMENT 项目成员操作仍被自动同步拦截。
- candidates：排除已有项目成员；过滤非活跃账号/成员关系；`q` 与分页；`inRegion` 标记正确。
- 回归：跨单元成员 `me-projects` 可见性；员工 Key 签发与网关校验不回归。
- 门禁：`npm run verify` 全绿（typecheck、覆盖率门槛、后端与管理端构建、license）。

## [S9] 风险与回退

- **风险**：`org_type` 口径替换 `type` 后，若存在历史数据 `type='REGION'` 但 `org_type` 非 REGION 的行，会失去挂靠资格。0.9.0 收敛迁移已统一 `org_type`，上线前用一条只读 SQL 核对两侧集合一致即可。
- **回退**：改动仅一处校验、一个只读新接口与前端选择器，回退即还原校验与前端数据源，无数据迁移、无不可逆变更。

## [S10] 现状依据（代码事实，0.9.5 `origin/main`）

- `apps/api/src/projects.service.ts`：`create()` 调 `region()` 校验 `type='REGION'`；`addMember` 校验任一活跃单元成员后 upsert `ProjectMember`；`removeMember` 撤 Key；`setStatus('ARCHIVED')` 仅挡未结算预算、不撤 Key；`assertAdmin` 允许 PLATFORM_ADMIN/ORG_ADMIN。
- `apps/api/src/me-projects.service.ts`：`list` 的 OR 可见性（项目成员 或 区域单元成员），region 过滤 `orgType IN ['REGION','FUNCTIONAL','EXECUTIVE']`。
- `prisma/schema.prisma`：`UsageGroup.type`（DEPARTMENT/PROJECT/REGION）与 `orgType`（EXECUTIVE/FUNCTIONAL/REGION/LEGACY_PROJECT）双列并存；`Project.regionId` 复合外键指向 `(id, organizationId)`；`ProjectMember`/`EmployeeApiKey` 复合外键钉公司级 `Membership`。
- `apps/admin/src/views/Projects.vue`：区域选项 `/org-units?kind=REGION&limit=100`；`views/ProjectDetail.vue`：候选人 `/org-units/${regionId}/members?limit=100`。
- 0.9.0 部门预算项目（`DEPT-EXEC` 等）已挂 EXECUTIVE/FUNCTIONAL，证明展示与查询链路兼容非 REGION 挂靠。
