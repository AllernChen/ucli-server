# 区域用量组、项目管理与项目预算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 13 个项目型用量组收敛为 7 个业务区域组，新增项目管理与项目预算，并通过项目化员工 API Key 让 AI CLI 无需额外请求头即可完成项目归因和预算扣减。

**Architecture:** `UsageGroup` 只作为区域访问边界；`Project` 挂在区域下并拥有独立预算账本。员工 API Key 同时绑定区域和项目，网关从 Key 解析项目并调用项目预算服务；区域页面仅汇总下属项目，不参与扣费。

**Tech Stack:** NestJS + Prisma + PostgreSQL + Vue 3 `<script setup>`；复用现有员工 Key、网关、预算结算、审计和管理端基础设施，不新增运行时依赖。

## Global Constraints

- 不新增 npm 依赖。
- TypeScript strict mode 必须通过。
- Prisma schema 变更必须附带 `prisma/migrations/` 迁移。
- 不使用 `X-UCLI-Project-Id` 做预算归因；项目必须来自员工 Key 或设备授权声明。
- 区域不设预算池；项目预算是唯一业务扣费主体。
- 每次可计费请求必须归属项目，不允许区域未归档项目消耗。
- 网关请求/响应正文仍只能留在内存，不得写日志、账本或审计。
- 完整员工 Key 只在创建响应中返回一次，不写应用日志和审计 metadata。
- 历史用量日志不重算、不改写；旧项目组通过 `Project.sourceGroupId` 映射。
- 提交信息使用中文并说明原因，前缀 `feat:` / `test:` / `docs:` / `chore:`。
- 每个任务完成时运行该任务列出的 focused tests；最终运行 `npm run verify` 和真库集成测试。

---

### Task 0: 固化设计文档与执行基线

**Files:**

- Create: `docs/superpowers/specs/2026-09-19-region-usage-group-project-budget-design.md`
- Create: `docs/superpowers/plans/2026-09-19-region-usage-group-project-budget.md`
- Create: `output/region-project-reorganization/人员分组名单-v2.md`

**Interfaces:**

- Produces: 后续任务的领域决策合同：7 区域、项目预算为主、项目化 Key、无项目请求头。

- [x] **Step 1: 核对设计决策**

确认设计文档开头包含：

```md
| 区域粒度 | 采用 **7 个业务区域**，不合并为省份级 4 区 |
| 预算主体 | **项目预算为主**；区域不设独立预算池，只做项目汇总 |
| 项目归因 | 区域内请求 **必须归属一个项目**，不允许“区域未分配项目”消耗 |
| 项目访问 | **区域成员默认可选区域内全部项目** |
| 项目 Key | 区域成员默认拥有区域内全部项目的 Key 资格；实际密钥仍需签发并一次性展示 |
| 请求头方案 | **不采用 `X-UCLI-Project-Id` 请求头选择项目**；项目归因必须内嵌在凭据中 |
```

- [x] **Step 2: 核对名单统计**

在 `output/region-project-reorganization/人员分组名单-v2.md` 中确认：

```text
人员-区域归属：46 条
默认项目 Key 资格：108 个「人员 × 区域内项目」组合
现有需替换 Key：23 把
```

- [x] **Step 3: 检查文档质量**

Run:

```powershell
git diff --check
Select-String -Path docs/superpowers/specs/2026-09-19-region-usage-group-project-budget-design.md -Pattern 'TBD|TODO|待定'
```

Expected: `git diff --check` 无输出；`Select-String` 无匹配。

- [x] **Step 4: Commit**

```powershell
git add docs/superpowers/specs/2026-09-19-region-usage-group-project-budget-design.md docs/superpowers/plans/2026-09-19-region-usage-group-project-budget.md
git commit -m "docs: 设计区域项目化用量与预算方案"
```

`output/` 是本地交付材料，不提交。

---

### Task 1: 数据库 schema 与迁移基础

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/202609190001_region_projects_project_budgets/migration.sql`
- Test: `test/deploy/region-project-schema.test.ts`

**Interfaces:**

- Produces:
  - `UsageGroupType.REGION`
  - `Project` / `ProjectMember` Prisma models
  - `ProjectBudgetPeriod` / `ProjectBudgetEntry` / `ProjectBudgetApplication`
  - `EmployeeApiKey.projectId`
  - `DeviceGrant.projectId`
  - `UsageLog.budgetProjectId`

- [x] **Step 1: 写失败的结构测试**

创建 `test/deploy/region-project-schema.test.ts`：

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('region and project budget schema', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  const migration = readFileSync(
    join(process.cwd(), 'prisma/migrations/202609190001_region_projects_project_budgets/migration.sql'),
    'utf8'
  )

  it('adds region usage groups and first-class projects', () => {
    expect(schema).toContain('REGION')
    expect(schema).toContain('model Project {')
    expect(schema).toContain('model ProjectMember {')
    expect(migration).toContain('CREATE TABLE "projects"')
    expect(migration).toContain('CREATE TABLE "project_members"')
  })

  it('binds credentials and usage logs to budget projects', () => {
    expect(schema).toContain('projectId String? @map("project_id") @db.Uuid')
    expect(schema).toContain('budgetProjectId String? @map("budget_project_id") @db.Uuid')
    expect(migration).toContain('ALTER TABLE "employee_api_keys" ADD COLUMN     "project_id" UUID')
    expect(migration).toContain('ALTER TABLE "device_grants" ADD COLUMN     "project_id" UUID')
    expect(migration).toContain('ALTER TABLE "usage_logs" ADD COLUMN     "budget_project_id" UUID')
  })

  it('creates durable project budget tables', () => {
    expect(schema).toContain('model ProjectBudgetPeriod {')
    expect(schema).toContain('model ProjectBudgetEntry {')
    expect(schema).toContain('model ProjectBudgetApplication {')
    expect(migration).toContain('CREATE TABLE "project_budget_periods"')
    expect(migration).toContain('CREATE TABLE "project_budget_entries"')
    expect(migration).toContain('CREATE TABLE "project_budget_applications"')
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```powershell
npm test -- test/deploy/region-project-schema.test.ts
```

Expected: FAIL，原因是迁移文件不存在。

- [x] **Step 3: 修改 Prisma schema**

在 `UsageGroupType` 增加 `REGION`，新增 `ProjectStatus` 与 `ProjectMemberRole` 枚举。

新增核心模型：

```prisma
model Project {
  id String @id @default(uuid()) @db.Uuid
  organizationId String @map("organization_id") @db.Uuid
  regionId String @map("region_id") @db.Uuid
  code String
  name String
  description String @default("")
  status ProjectStatus @default(ACTIVE)
  sourceGroupId String? @map("source_group_id") @db.Uuid
  budgetMode GroupBudgetMode @default(TOTAL) @map("budget_mode")
  budgetTimezone String @default("Asia/Shanghai") @map("budget_timezone")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id])
  region UsageGroup @relation(fields: [regionId, organizationId], references: [id, organizationId], onDelete: Restrict, onUpdate: Restrict)
  members ProjectMember[]
  periods ProjectBudgetPeriod[]
  applications ProjectBudgetApplication[]

  @@unique([organizationId, code])
  @@unique([organizationId, regionId, name])
  @@index([organizationId, regionId, status])
  @@map("projects")
}

model ProjectMember {
  organizationId String @map("organization_id") @db.Uuid
  projectId String @map("project_id") @db.Uuid
  accountId String @map("account_id") @db.Uuid
  role ProjectMemberRole @default(CONTRIBUTOR)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  project Project @relation(fields: [projectId, organizationId], references: [id, organizationId], onDelete: Cascade, onUpdate: Cascade)
  membership Membership @relation(fields: [organizationId, accountId], references: [organizationId, accountId], onDelete: Cascade, onUpdate: Cascade)

  @@id([projectId, accountId])
  @@index([organizationId, accountId])
  @@map("project_members")
}
```

为 `EmployeeApiKey`、`DeviceGrant`、`UsageLog` 增加项目关系；前两者数据库先可空，服务层对新区域凭据强制必填：

```prisma
projectId String? @map("project_id") @db.Uuid
project Project? @relation(fields: [projectId, organizationId], references: [id, organizationId], onDelete: Restrict, onUpdate: Restrict)
```

`UsageLog` 使用独立字段，保留现有客户端上下文 `projectId`：

```prisma
budgetProjectId String? @map("budget_project_id") @db.Uuid
budgetProject Project? @relation(fields: [budgetProjectId, organizationId], references: [id, organizationId], onDelete: Restrict, onUpdate: Restrict)
```

新增项目预算模型，字段语义镜像组预算表，但外键全部指向 `projects`：

```prisma
model ProjectBudgetPeriod {
  id String @id @default(uuid()) @db.Uuid
  organizationId String @map("organization_id") @db.Uuid
  projectId String @map("project_id") @db.Uuid
  periodKey String @map("period_key")
  timezone String
  unlimited Boolean @default(false)
  limitCny Decimal @default(0) @map("limit_cny") @db.Decimal(20, 8)
  spentCny Decimal @default(0) @map("spent_cny") @db.Decimal(20, 8)
  reservedCny Decimal @default(0) @map("reserved_cny") @db.Decimal(20, 8)
  alertedThreshold Int @default(0) @map("alerted_threshold")
  project Project @relation(fields: [projectId, organizationId], references: [id, organizationId], onDelete: Restrict, onUpdate: Restrict)
  entries ProjectBudgetEntry[]

  @@unique([projectId, periodKey])
  @@unique([id, organizationId, projectId])
  @@map("project_budget_periods")
}
```

`ProjectBudgetEntry` 与 `ProjectBudgetApplication` 按现有 `GroupBudgetEntry` / `GroupBudgetApplication` 的字段、索引和状态语义实现，所有 `groupId` 替换为 `projectId`。

- [x] **Step 4: 手写迁移**

迁移必须包含：

```sql
ALTER TYPE "UsageGroupType" ADD VALUE 'REGION';

CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "region_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "source_group_id" UUID,
    "budget_mode" "GroupBudgetMode" NOT NULL DEFAULT 'TOTAL',
    "budget_timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);
```

再创建 `ProjectStatus`、`ProjectMemberRole`、`project_members`、三张项目预算表、外键和索引，并添加：

```sql
ALTER TABLE "employee_api_keys" ADD COLUMN "project_id" UUID;
ALTER TABLE "device_grants" ADD COLUMN "project_id" UUID;
ALTER TABLE "usage_logs" ADD COLUMN "budget_project_id" UUID;
```

至少增加：

```sql
CREATE INDEX "projects_org_region_status_idx" ON "projects"("organization_id", "region_id", "status");
CREATE INDEX "project_budget_entries_state_idx" ON "project_budget_entries"("status", "lease_until");
CREATE INDEX "project_budget_entries_project_time_idx" ON "project_budget_entries"("organization_id", "project_id", "started_at");
CREATE INDEX "usage_logs_budget_project_time_idx" ON "usage_logs"("organization_id", "budget_project_id", "started_at");
```

`source_group_id` 只加唯一索引，不加外键；旧组会归档，但历史来源标识必须稳定。

- [x] **Step 5: 生成并验证 Prisma client**

Run:

```powershell
npm run db:generate
npm test -- test/deploy/region-project-schema.test.ts
```

Expected: 测试通过。

- [x] **Step 6: 空库迁移演练**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw 'TEST_DATABASE_URL must point to the disposable local test database' }
npx prisma migrate deploy
```

Expected: 所有迁移应用，无枚举、外键或循环依赖错误。

- [x] **Step 7: Commit**

```powershell
git add prisma/schema.prisma prisma/migrations/202609190001_region_projects_project_budgets/migration.sql test/deploy/region-project-schema.test.ts
git commit -m "feat: 增加区域项目与项目预算数据模型"
```

---

### Task 2: 项目管理 API 与区域展示契约

**Files:**

- Create: `apps/api/src/projects.dto.ts`
- Create: `apps/api/src/projects.service.ts`
- Create: `apps/api/src/projects.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/usage-groups.service.ts`
- Test: `test/integration/projects.test.ts`

**Interfaces:**

- Produces:
  - `ProjectsService.list(actor, query)`
  - `ProjectsService.create(actor, input)`
  - `ProjectsService.detail(actor, id)`
  - `ProjectsService.update(actor, id, input)`
  - `ProjectsService.setStatus(actor, id, status)`
  - `ProjectsService.members(actor, id)`
  - `ProjectsService.addMember(actor, id, input)`
  - `ProjectsService.setMemberRole(actor, id, accountId, role)`
  - `ProjectsService.removeMember(actor, id, accountId)`
- Region list response includes `projects`.

- [x] **Step 1: 写失败集成测试**

创建 `test/integration/projects.test.ts`，使用 `withTestDatabase` / `createOrganization`：

```ts
it('creates projects under a region and lists them with the region', async () => {
  const { actor } = await createOrganization(db)
  const region = await db.usageGroup.create({ data: {
    organizationId: actor.organizationId, name: '广东-省厅区域', type: 'REGION'
  } })
  const service = new ProjectsService(db as PrismaService)

  const project = await service.create(actor, {
    regionId: region.id, code: 'GD-PROV-SLT', name: '省厅', description: '省厅区域主项目'
  })

  expect(project).toMatchObject({
    regionId: region.id, code: 'GD-PROV-SLT', name: '省厅', status: 'ACTIVE'
  })
  expect((await service.list(actor, {})).items.map(item => item.id)).toEqual([project.id])
})
```

继续覆盖跨组织 404、区域不存在、项目编码唯一、项目成员必须是区域成员、停用项目不可签 Key、区域全员默认可见项目。

- [x] **Step 2: 运行测试确认失败**

Run:

```powershell
npm test -- test/integration/projects.test.ts
```

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现 DTO**

`projects.dto.ts` 核心类型：

```ts
export class ProjectPageQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID() regionId?: string
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED', 'ARCHIVED']) status?: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 200) q?: string
}

export class CreateProjectDto {
  @IsUUID() regionId!: string
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString() @Matches(/^[A-Z0-9][A-Z0-9_-]{1,59}$/) code!: string
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string
  @IsOptional() @IsString() @Length(0, 2000) description?: string
}
```

成员 DTO 使用 `accountId` 与 `OWNER | CONTRIBUTOR | VIEWER`。

- [x] **Step 4: 实现 Service**

区域校验必须是：

```ts
private async region(organizationId: string, regionId: string) {
  const region = await this.prisma.usageGroup.findFirst({
    where: { id: regionId, organizationId, type: 'REGION', enabled: true, archivedAt: null },
    select: { id: true, name: true }
  })
  if (!region) throw new NotFoundException('Region usage group not found')
  return region
}
```

`detail` 固定包含区域和项目成员。`setStatus('ARCHIVED')` 必须拒绝未结算或预留中的预算账目，保留历史 Key 和日志。

- [x] **Step 5: 注册 Controller**

路由：

```text
GET    /api/v1/admin/projects
POST   /api/v1/admin/projects
GET    /api/v1/admin/projects/:id
PATCH  /api/v1/admin/projects/:id
POST   /api/v1/admin/projects/:id/disable
POST   /api/v1/admin/projects/:id/enable
POST   /api/v1/admin/projects/:id/archive
GET    /api/v1/admin/projects/:id/members
POST   /api/v1/admin/projects/:id/members
PATCH  /api/v1/admin/projects/:id/members/:accountId
DELETE /api/v1/admin/projects/:id/members/:accountId
```

所有端点 `@Roles('PLATFORM_ADMIN', 'ORG_ADMIN')`，`:id` 与 `:accountId` 均使用 `UuidPipe`。

- [x] **Step 6: 区域列表返回项目标签**

`UsageGroupsService.list` 对 `type=REGION` 的结果批量查询：

```ts
const projects = await this.prisma.project.findMany({
  where: { organizationId, regionId: { in: regionIds }, status: 'ACTIVE' },
  select: { id: true, regionId: true, code: true, name: true, status: true },
  orderBy: [{ region: { name: 'asc' } }, { name: 'asc' }]
})
```

映射为 `group.projects = byRegion.get(group.id) ?? []`。

- [x] **Step 7: 运行测试**

Run:

```powershell
npm run db:generate
npm test -- test/integration/projects.test.ts test/integration/usage-groups.test.ts
```

Expected: 全部通过。

- [x] **Step 8: Commit**

```powershell
git add apps/api/src/projects.dto.ts apps/api/src/projects.service.ts apps/api/src/projects.controller.ts apps/api/src/app.module.ts apps/api/src/usage-groups.service.ts test/integration/projects.test.ts
git commit -m "feat: 提供区域项目管理接口"
```

---

### Task 3: 项目预算服务与预算 API

**Files:**

- Create: `packages/quota/src/project-budget-read.ts`
- Create: `packages/quota/src/project-budget.service.ts`
- Modify: `apps/api/src/projects.controller.ts`
- Modify: `apps/api/src/projects.dto.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `test/integration/project-budget.test.ts`

**Interfaces:**

- Produces:
  - `ProjectBudgetService.summary(actor, projectId)`
  - `.entries(actor, projectId, query)`
  - `.adjust(actor, projectId, input)`
  - `.reserve({ requestId, identity, startedAt, estimateCny, snapshot })`
  - `.extend(ref, additionalCny, attemptSnapshot)`
  - `.settle(ref, input)`
  - `.hold(ref, input)`
  - `.release(ref, reason)`
  - `.markDispatched(ref, leaseUntil, attempt?)`
  - `.markUncertain(ref, reason)`
  - `.recoverExpired(now)`
  - `.syncQuota(ref, quota)`
  - `.recoverQuota(quota, now)`
- `ProjectBudgetReservation` 导出为 `{ id, requestId, periodId, projectId, reservedCny }`。

- [x] **Step 1: 写失败预算测试**

测试场景：

1. `TOTAL` 项目初始额度 ¥1；
2. 请求预估 ¥0.2 时创建 `RESERVED` entry，项目 `reservedCny=0.2`；
3. 结算 ¥0.15 后 `spent=0.15`、`reserved=0`；
4. 额度不足抛出 `429 project_budget_exceeded`；
5. 重复 `requestId` 幂等返回同一 reservation；
6. 释放未派发请求后预留归零；
7. 管理员调整额度生成 `LIMIT_ADJUSTMENT` 流水；
8. 非管理员 403；
9. 跨组织项目 404。

核心断言：

```ts
await expect(service.reserve({
  requestId, identity, startedAt, estimateCny: '2', snapshot: { usage: usageBase }
})).rejects.toMatchObject({ status: 429, response: { code: 'project_budget_exceeded' } })
```

- [x] **Step 2: 运行测试确认失败**

Run:

```powershell
npm test -- test/integration/project-budget.test.ts
```

Expected: FAIL，服务不存在。

- [x] **Step 3: 实现读取汇总**

`project-budget-read.ts` 提供：

```ts
export interface ProjectBudgetSummary {
  projectId: string
  periodId: string | null
  periodKey: string
  budgetMode: 'TOTAL' | 'MONTHLY'
  budgetTimezone: string
  unlimited: boolean
  limitCny: string
  spentCny: string
  reservedCny: string
  uncertainCny: string
  availableCny: string | null
}
```

汇总规则复用 `availableCny` / `budgetPeriodKey`，但按 `project.budgetMode` 与 `project.budgetTimezone` 计算周期。

- [x] **Step 4: 实现项目预算服务**

从现有 `GroupBudgetService` 抽出或复用以下纯逻辑，不复制业务语义：

- request / operation fingerprint；
- CNY Decimal 精度；
- `RESERVED` → `SETTLED` / `RECONCILIATION_REQUIRED` / `RELEASED` 状态机；
- lease 恢复；
- Redis quota 同步标记；
- 80% / 100% 告警阈值；
- 预算调整和申请关联。

项目状态检查：

```ts
if (project.status !== 'ACTIVE') {
  throw new ForbiddenException({ code: 'project_unavailable', message: 'Project is unavailable' })
}
```

预算不足错误：

```ts
throw new HttpException({
  code: 'project_budget_exceeded',
  message: 'Project budget exceeded'
}, 429)
```

- [x] **Step 5: 暴露预算 API**

在 `projects.controller.ts` 增加：

```text
GET  /api/v1/admin/projects/:id/budget
GET  /api/v1/admin/projects/:id/budget-entries
POST /api/v1/admin/projects/:id/budget-adjustments
GET  /api/v1/admin/projects/:id/budget-applications
POST /api/v1/admin/projects/:id/budget-applications
POST /api/v1/admin/projects/:id/budget-applications/:applicationId/decision
```

预算 DTO 复用现有金额、reason、operationId 校验；调整值是批复后总额，不是增量。

- [x] **Step 6: 运行测试**

Run:

```powershell
npm test -- test/integration/project-budget.test.ts test/quota
```

Expected: 全部通过。

- [x] **Step 7: Commit**

```powershell
git add packages/quota/src/project-budget-read.ts packages/quota/src/project-budget.service.ts apps/api/src/projects.controller.ts apps/api/src/projects.dto.ts apps/api/src/app.module.ts test/integration/project-budget.test.ts
git commit -m "feat: 增加项目预算账本与接口"
```

---

### Task 4: 项目化员工 API Key

**Files:**

- Modify: `apps/api/src/employee-keys.dto.ts`
- Modify: `apps/api/src/employee-keys.service.ts`
- Modify: `apps/api/src/employee-keys.controller.ts`
- Test: `test/integration/employee-project-keys.test.ts`
- Test: `test/auth/employee-keys.test.ts`

**Interfaces:**

- `CreateEmployeeKeyDto` adds required `projectId`.
- Key summary adds `{ projectId, project: { id, code, name } }`.
- Produces `EmployeeKeysService.projectOptions(actor, accountId, regionId)`.

- [x] **Step 1: 写失败测试**

测试必须覆盖：

- 创建 Key 时项目必填；
- 项目必须属于传入区域；
- 项目必须 `ACTIVE`；
- 员工必须是该区域活动成员；
- 区域全员默认可签项目，不需要 `ProjectMember` 记录；
- Key 审计 metadata 仅包含 `accountId`、`groupId`、`projectId`，不包含 secret；
- 列表按项目筛选；
- 移出区域后自动撤销该区域项目 Key。

核心测试：

```ts
const created = await service.create(actor, member.account.id, {
  groupId: region.id, projectId: project.id, name: '广东-省厅区域-省厅-陈嘉明'
})

expect(created.projectId).toBe(project.id)
expect(created.secret.startsWith('ucli_sk_')).toBe(true)
```

- [x] **Step 2: 运行测试确认失败**

Run:

```powershell
npm test -- test/integration/employee-project-keys.test.ts test/auth/employee-keys.test.ts
```

Expected: FAIL，DTO 无 `projectId`。

- [x] **Step 3: 修改 DTO**

```ts
export class CreateEmployeeKeyDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string
  @IsUUID() groupId!: string
  @IsUUID() projectId!: string
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString({ strict: true }) expiresAt?: string | null
}
```

查询 DTO 增加：

```ts
@IsOptional() @IsUUID() projectId?: string
```

- [x] **Step 4: 修改创建与列表**

创建事务中锁定区域后校验：

```ts
const project = await db.project.findFirst({
  where: {
    id: input.projectId,
    organizationId: actor.organizationId,
    regionId: input.groupId,
    status: 'ACTIVE'
  },
  select: { id: true }
})
if (!project) throw new NotFoundException('Active project in target region not found')
```

`keySummary` / `keyListSummary` 增加 `projectId` 和 `project` 关系。审计 metadata：

```ts
{ accountId: key.accountId, groupId: key.groupId, projectId: key.projectId }
```

- [x] **Step 5: 提供项目选项**

新增：

```text
GET /api/v1/admin/users/:accountId/projects?regionId=...
GET /api/v1/me/projects?regionId=...
```

返回该员工所属活动区域下的活动项目。数据来源是区域成员关系，不查 `ProjectMember`。

- [x] **Step 6: 运行测试**

Run:

```powershell
npm test -- test/integration/employee-project-keys.test.ts test/auth/employee-keys.test.ts
```

Expected: 全部通过。

- [x] **Step 7: Commit**

```powershell
git add apps/api/src/employee-keys.dto.ts apps/api/src/employee-keys.service.ts apps/api/src/employee-keys.controller.ts test/integration/employee-project-keys.test.ts test/auth/employee-keys.test.ts
git commit -m "feat: 员工 Key 绑定项目预算归属"
```

---

### Task 5: 网关项目身份与项目预算执行

**Files:**

- Modify: `packages/security/src/gateway-auth.ts`
- Modify: `apps/gateway/src/gateway.service.ts`
- Modify: `apps/gateway/src/group-request.ts`
- Modify: `apps/gateway/src/app.module.ts`
- Test: `test/security/gateway-project-auth.test.ts`
- Test: `test/gateway/project-budget-relay.test.ts`

**Interfaces:**

- `GatewayIdentity` adds `projectId: string | null`.
- Region API-key identity has non-null `projectId`.
- Gateway calls `ProjectBudgetService` when `principal.projectId` exists.
- Usage logs persist `budgetProjectId`.

- [x] **Step 1: 写失败认证测试**

覆盖：

- 项目 Key 查询包含 `project`；
- `REGION` Key 无项目时返回 401 `invalid_api_key`；
- 项目停用 / 归档时返回 401；
- 项目不属于 Key 区域时返回 401；
- 传统 `PROJECT` / `DEPARTMENT` 存量 Key 保持兼容；
- identity 输出 `groupId` 与 `projectId`。

- [x] **Step 2: 写失败网关测试**

覆盖：

- 项目 Key 请求调用 `ProjectBudgetService.reserve`；
- `UsageLog` 写入 `budgetProjectId`；
- actor snapshot 包含 `regionName`、`projectName`、`keyName`；
- 项目预算不足返回 429；
- 请求头伪造 `X-UCLI-Project-Id` 不影响预算项目；
- 流式请求结算后 `spentCny` 等于实际成本；
- 上游失败进入 `RECONCILIATION_REQUIRED`，不丢账。

核心断言：

```ts
expect(projectBudget.reserve.mock.calls[0][0]).toMatchObject({
  identity: expect.objectContaining({ groupId: region.id, projectId: project.id })
})
expect(prisma.usageLog.create.mock.calls[0][0].data).toMatchObject({
  groupId: region.id,
  budgetProjectId: project.id
})
```

- [x] **Step 3: 运行测试确认失败**

Run:

```powershell
npm test -- test/security/gateway-project-auth.test.ts test/gateway/project-budget-relay.test.ts
```

Expected: FAIL。

- [x] **Step 4: 修改 GatewayIdentity**

```ts
export type GatewayIdentity = {
  sub: string
  organizationId: string
  role: AuthPrincipal['role']
  groupId: string | null
  projectId: string | null
} & ({ credentialType: 'DEVICE'; deviceId: string; apiKeyId?: never }
  | { credentialType: 'API_KEY'; apiKeyId: string; groupId: string; deviceId?: never })
```

API Key 查询：

```ts
include: {
  membership: true,
  group: { select: { type: true } },
  project: { select: { id: true, regionId: true, status: true } }
}
```

当 Key 所属组 `type === 'REGION'`：

```ts
if (!key.project || key.project.regionId !== key.groupId || key.project.status !== 'ACTIVE') {
  throw invalid()
}
```

- [x] **Step 5: 改造预算请求执行器**

将 `relayGroupRequest` 导出重命名为 `relayBudgetedRequest`，输入增加：

```ts
projectBudget: ProjectBudgetService
principal: GatewayIdentity & { groupId: string; projectId: string }
```

项目路径预算调用：

```ts
reservation = await projectBudget.reserve({
  requestId,
  identity: principal,
  startedAt,
  estimateCny,
  snapshot: { usage: usageBase, redis: reservations, inputTokens, outputTokens }
})
```

所有 `extend`、`markDispatched`、`settle`、`hold`、`release`、`syncQuota` 对项目路径改用 `projectBudget`。

`usageBase` 增加：

```ts
budgetProjectId: principal.projectId,
actorSnapshot: {
  employeeName: actor.displayName,
  regionName: region.name,
  projectName: project.name,
  ...(key ? { keyName: key.name, keyHint: key.secretHint } : {})
}
```

保留 `...context` 中的原始 `projectId`，但预算归因只读 `principal.projectId`。

- [x] **Step 6: GatewayService 分支**

在 `relay()` 中先处理区域+项目身份，再保留传统组路径。将 principal 类型拆为 `RegionProjectIdentity` 与 `LegacyGroupIdentity`，不得用 `as any` 掩盖类型差异。

- [x] **Step 7: 运行测试**

Run:

```powershell
npm test -- test/security/gateway-project-auth.test.ts test/gateway/project-budget-relay.test.ts test/gateway
```

Expected: 全部通过。

- [x] **Step 8: Commit**

```powershell
git add packages/security/src/gateway-auth.ts apps/gateway/src/gateway.service.ts apps/gateway/src/group-request.ts apps/gateway/src/app.module.ts test/security/gateway-project-auth.test.ts test/gateway/project-budget-relay.test.ts
git commit -m "feat: 网关按项目 Key 执行项目预算"
```

---

### Task 6: 项目化设备授权

**Files:**

- Modify: `apps/api/src/device-grants.dto.ts`
- Modify: `apps/api/src/device-grants.service.ts`
- Modify: `packages/security/src/auth.ts`
- Modify: `apps/admin/src/views/DeviceGrants.vue`
- Test: `test/auth/device-project-grants.test.ts`

**Interfaces:**

- `AuthPrincipal` adds `projectId?: string | null`.
- New region device grants require `projectId`.
- `GatewayIdentity` receives project from live grant state, not JWT claim.

- [x] **Step 1: 写失败测试**

覆盖：

- `REGION` 组新建设备授权必须选择项目；
- 项目必须属于区域且活动；
- 项目停用后 refresh / gateway 认证拒绝；
- 认证时从 `device.grant.projectId` 回读项目并覆盖 JWT 中的过期值；
- 传统项目组授权不强制项目并保持兼容；
- 授权审计记录项目 ID，不记录连接 URL 明文。

- [x] **Step 2: 运行失败测试**

Run:

```powershell
npm test -- test/auth/device-project-grants.test.ts
```

Expected: FAIL。

- [x] **Step 3: 实现授权校验**

创建 / 更新组时：

```ts
if (group.type === 'REGION') {
  if (!input.projectId) throw new BadRequestException('Project is required for a region device grant')
  const project = await transaction.project.findFirst({
    where: { id: input.projectId, organizationId, regionId: group.id, status: 'ACTIVE' }
  })
  if (!project) throw new NotFoundException('Active project in target region not found')
}
```

- [x] **Step 4: 认证回读项目**

`AuthGuard.authenticateToken` 中：

```ts
principal.projectId = null
if (principal.deviceId) {
  principal.groupId = device.grant.groupId ?? null
  principal.projectId = device.grant.projectId ?? null
}
```

区域设备必须存在有效项目：

```ts
if (group.type === 'REGION' && !principal.projectId) {
  throw new ForbiddenException({ code: 'project_required', message: 'Device must be assigned to a project' })
}
```

如果项目存在，继续查询活动项目并确认 `regionId === groupId`。

- [x] **Step 5: 运行测试**

Run:

```powershell
npm test -- test/auth/device-project-grants.test.ts test/auth/device-grant-lifecycle.test.ts
```

Expected: 全部通过。

- [x] **Step 6: Commit**

```powershell
git add apps/api/src/device-grants.dto.ts apps/api/src/device-grants.service.ts packages/security/src/auth.ts apps/admin/src/views/DeviceGrants.vue test/auth/device-project-grants.test.ts
git commit -m "feat: 设备授权绑定项目归属"
```

---

### Task 7: 统计分析和个人视角

**Files:**

- Modify: `apps/api/src/analytics.dto.ts`
- Modify: `apps/api/src/usage-query.ts`
- Modify: `apps/api/src/analytics.service.ts`
- Modify: `packages/usage/src/analytics-types.ts`
- Create: `apps/api/src/me-projects.controller.ts`
- Create: `apps/api/src/me-projects.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `test/analytics/project-dimensions.test.ts`
- Test: `test/integration/me-projects.test.ts`

**Interfaces:**

- Analytics filters add `budgetProjectId`.
- Group dimension remains region.
- Project dimension uses `UsageLog.budgetProjectId`.
- `GET /api/v1/me/projects` returns active projects in the caller's active regions.

- [x] **Step 1: 写失败测试**

覆盖：

- 新日志按 `budgetProjectId` 聚合；
- 旧日志通过 `Project.sourceGroupId` 映射到项目；
- 区域汇总等于下属项目求和；
- 原始客户端 `projectId` 不参与预算项目聚合；
- 普通成员可看自己区域的项目；
- 设备会话访问个人项目接口返回 403。

- [x] **Step 2: 运行失败测试**

Run:

```powershell
npm test -- test/analytics/project-dimensions.test.ts test/integration/me-projects.test.ts
```

Expected: FAIL。

- [x] **Step 3: 实现查询**

过滤条件：

```ts
if (filter.budgetProjectId) {
  conditions.push(Prisma.sql`u.budget_project_id = ${filter.budgetProjectId}::uuid`)
}
```

历史映射使用：

```sql
COALESCE(u.budget_project_id, p.source_group_id)
```

并按项目名称快照或 `projects.name` 展示。所有 SQL 保持参数化。

- [x] **Step 4: 实现个人项目 API**

`MeProjectsService.list(actor)`：

```ts
this.prisma.project.findMany({
  where: {
    organizationId: actor.organizationId,
    status: 'ACTIVE',
    region: {
      enabled: true, archivedAt: null,
      members: { some: { accountId: actor.sub, removedAt: null,
        membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } } } }
    }
  },
  select: {
    id: true, code: true, name: true, description: true,
    region: { select: { id: true, name: true } }
  },
  orderBy: [{ region: { name: 'asc' } }, { name: 'asc' }]
})
```

项目负责人预算权限由 `ProjectMember.role=OWNER` 判断。

- [x] **Step 5: 运行测试**

Run:

```powershell
npm test -- test/analytics/project-dimensions.test.ts test/integration/me-projects.test.ts test/analytics
```

Expected: 全部通过。

- [x] **Step 6: Commit**

```powershell
git add apps/api/src/analytics.dto.ts apps/api/src/usage-query.ts apps/api/src/analytics.service.ts packages/usage/src/analytics-types.ts apps/api/src/me-projects.controller.ts apps/api/src/me-projects.service.ts apps/api/src/app.module.ts test/analytics/project-dimensions.test.ts test/integration/me-projects.test.ts
git commit -m "feat: 统计和个人视角支持项目维度"
```

---

### Task 8: 管理端区域展示与项目管理模块

**Files:**

- Modify: `apps/admin/src/main.ts`
- Modify: `apps/admin/src/App.vue`
- Create: `apps/admin/src/projects.ts`
- Create: `apps/admin/src/views/Projects.vue`
- Create: `apps/admin/src/views/ProjectDetail.vue`
- Modify: `apps/admin/src/views/UsageGroups.vue`
- Modify: `apps/admin/src/views/UsageGroupDetail.vue`
- Modify: `apps/admin/src/components/EmployeeKeysPanel.vue`
- Test: `test/admin/projects.test.ts`
- Test: `test/admin/usage-groups.test.ts`

**Interfaces:**

- Route `/projects` lists projects.
- Route `/projects/:id` opens detail.
- Usage group list groups by region and renders project tags.
- Employee key form requires region + project.

- [x] **Step 1: 写失败组件测试**

覆盖：

- 区域列表展示项目标签；
- 项目列表按区域 / 状态 / 搜索过滤；
- 项目详情展示区域、负责人、预算、Key；
- 创建 Key 时项目必选；
- 项目预算耗尽显示风险；
- 未加载或请求失败时不显示假数据。

- [x] **Step 2: 运行失败测试**

Run:

```powershell
npm test -- test/admin/projects.test.ts test/admin/usage-groups.test.ts
```

Expected: FAIL。

- [x] **Step 3: 注册路由和导航**

`main.ts`：

```ts
{ path: '/projects', name: 'projects', component: () => import('./views/Projects.vue') },
{ path: '/projects/:id', name: 'project-detail', component: () => import('./views/ProjectDetail.vue') }
```

`App.vue` 管理员导航增加 `['projects', '项目管理']`，权限映射允许 `project-detail`。

- [x] **Step 4: 实现项目页面**

`Projects.vue` 列：

- 项目 / 编码；
- 区域；
- 负责人；
- 状态；
- 预算 / 使用率；
- Key 数；
- 近 7 天成本。

`ProjectDetail.vue` 页签：

1. `overview`：基本信息、区域、状态、预算；
2. `members`：项目职责成员；
3. `keys`：项目 Key 与批量签发入口；
4. `budget`：当前额度、账目、调整、申请；
5. `usage`：内嵌 `Usage` 并带 `budgetProjectId` 过滤。

- [x] **Step 5: 改造用量组页面**

`UsageGroups.vue`：

- 默认 `filters.type='REGION'`；
- 创建表单默认 `REGION`；
- 每行渲染：

```vue
<span v-for="project in row.projects" :key="project.id" class="tag">
  {{ project.name }}
</span>
```

`UsageGroupDetail.vue` 增加「项目」页签，列出下属项目并链接到 `/projects/:id`；预算卡片改为项目预算合计，不再暗示区域扣费。

- [x] **Step 6: 改造员工 Key 表单**

`EmployeeKeysPanel.vue`：

1. 选择区域；
2. 加载该员工在区域下的项目；
3. 项目必选；
4. Key 名称默认 `区域-项目-员工`；
5. 创建成功仅在一次性 Drawer 中展示 secret；
6. 列表增加项目列和项目筛选。

- [x] **Step 7: 运行测试和构建**

Run:

```powershell
npm test -- test/admin/projects.test.ts test/admin/usage-groups.test.ts test/admin/employee-keys.test.ts
npm run admin:build
```

Expected: 全部通过。

- [x] **Step 8: Commit**

```powershell
git add apps/admin/src/main.ts apps/admin/src/App.vue apps/admin/src/projects.ts apps/admin/src/views/Projects.vue apps/admin/src/views/ProjectDetail.vue apps/admin/src/views/UsageGroups.vue apps/admin/src/views/UsageGroupDetail.vue apps/admin/src/components/EmployeeKeysPanel.vue test/admin/projects.test.ts test/admin/usage-groups.test.ts
git commit -m "feat: 管理端支持区域项目与项目 Key"
```

---

### Task 9: 公司数据迁移与替换 Key 工具

**Files:**

- Create: `scripts/migrate-region-projects.mjs`
- Create: `scripts/migrate-region-projects.preview.md`
- Modify: `docs/release-0.8.0.md`
- Test: `test/deploy/region-project-migration.test.ts`

**Interfaces:**

- CLI:
  - `node scripts/migrate-region-projects.mjs`：干跑；
  - `node scripts/migrate-region-projects.mjs --apply`：执行；
  - `--credentials path`：管理员凭据；
  - `--output path`：新 Key 发放清单。
- Produces idempotent migration report and replacement key CSV.

- [x] **Step 1: 写失败迁移测试**

固定内置映射：

```ts
const REGION_MAPPING = [
  { region: '广东-省厅区域', projects: ['省厅', '机场', '地市'] },
  { region: '广东-市局区域', projects: ['市局', '越秀', '黄埔', '揭阳', '交警'] },
  { region: '广东-花都区域', projects: ['花都'] },
  { region: '广东-东莞区域', projects: ['东莞'] },
  { region: '北京-GAB区域', projects: ['GAB'] },
  { region: '江苏-苏州区域', projects: ['苏州'] },
  { region: '贵州-贵州', projects: ['贵州'] }
]
```

断言：

- 13 个源组全部映射且无重复；
- 7 个区域全部存在；
- 46 条人员-区域归属可由名单推导；
- 23 把旧 Key 对应 23 个替换计划；
- 预算迁移前后总额都是 `13650.00000000`；
- 干跑不发送任何 mutation 请求。

- [x] **Step 2: 运行失败测试**

Run:

```powershell
npm test -- test/deploy/region-project-migration.test.ts
```

Expected: FAIL。

- [x] **Step 3: 实现迁移脚本**

脚本流程：

1. 读取 `output/region-project-reorganization/人员分组名单-v2.md` 或内置映射；
2. 管理员登录；
3. 拉取组、成员、预算、账号、Key；
4. 干跑输出计划；
5. `--apply` 时：
   - 创建 7 个 `REGION` 用量组；
   - 复制模型白名单；
   - 添加成员并设置负责人；
   - 为 13 个源组创建 Project，写 `sourceGroupId`；
   - 读取源组当前预算并创建项目预算；
   - 为 23 把现有 Key 创建同项目新 Key；
   - 输出新 `发放清单-v2.csv`；
   - 撤销旧 Key；
   - 归档旧项目组。

脚本必须：

- 使用 `operationId` 保证预算调整幂等；
- 每个步骤前后输出计数；
- 任何一步失败即停止，不继续归档；
- 不读取或输出管理员密码；
- 不把完整 Key 写日志；
- 生成迁移审计摘要。

- [x] **Step 4: 本地真库演练**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw 'TEST_DATABASE_URL must point to the disposable local test database' }
node scripts/migrate-region-projects.mjs
node scripts/migrate-region-projects.mjs --apply --output output/region-project-reorganization/发放清单-v2.csv
```

Expected:

```text
regions=7
projects=13
region_memberships=46
replacement_keys=23
project_budget_total=13650.00000000
archived_source_groups=13
```

- [x] **Step 5: Commit**

```powershell
git add scripts/migrate-region-projects.mjs scripts/migrate-region-projects.preview.md docs/release-0.8.0.md test/deploy/region-project-migration.test.ts
git commit -m "feat: 提供区域项目迁移与替换 Key 工具"
```

---

### Task 10: 端到端验收、文档与发布准备

**Files:**

- Modify: `docs/release-0.8.0.md`
- Modify: `README.md`
- Modify: `CONTEXT.md`
- Test: all existing suites

**Interfaces:**

- Produces release readiness record with migration, API, UI, gateway, rollback, and deployment evidence.

- [x] **Step 1: 更新领域语言**

`CONTEXT.md` 增加：

```md
**区域用量组**：按业务区域组织员工、模型权限和项目的一类用量组；区域本身不扣项目预算。

**项目**：区域下的成本核算与预算主体，拥有稳定 ID、负责人、状态和项目预算。

**项目 Key**：同时绑定员工、区域和项目的员工 API Key；AI CLI 只需配置 Base URL 和 Key。
```

- [x] **Step 2: 跑后端与前端 focused tests**

Run:

```powershell
npm test -- test/deploy/region-project-schema.test.ts test/integration/projects.test.ts test/integration/project-budget.test.ts test/integration/employee-project-keys.test.ts test/security/gateway-project-auth.test.ts test/gateway/project-budget-relay.test.ts test/auth/device-project-grants.test.ts test/analytics/project-dimensions.test.ts test/integration/me-projects.test.ts
npm test -- test/admin/projects.test.ts test/admin/usage-groups.test.ts
```

Expected: 全部通过。

- [x] **Step 3: 跑全量验证**

Run:

```powershell
npm run verify
```

Expected: typecheck、coverage、build、admin build、license gate 全部通过。

- [x] **Step 4: 本地真库端到端验收**

场景：

1. 创建区域和项目；
2. 设置项目预算 ¥1；
3. 为区域成员签项目 Key；
4. 使用项目 Key 请求模型；
5. 断言日志 `groupId=region`、`budgetProjectId=project`；
6. 断言项目 `spentCny` 增加；
7. 将额度降到已消耗以下；
8. 断言新请求 429 `project_budget_exceeded`；
9. 伪造 `X-UCLI-Project-Id` 为其它项目，断言归因不变；
10. 归档项目，断言 Key 拒绝且历史日志仍可查。

- [x] **Step 5: 记录发布门禁**

`docs/release-0.8.0.md` 必须包含：

- 源提交；
- 迁移总数；
- 7 区域 / 13 项目 / 46 归属 / 23 替换 Key；
- 项目预算合计 ¥13,650；
- 本地端到端结果；
- CI 结果；
- 公司服务器部署前备份要求；
- 回滚边界。

- [x] **Step 6: Commit**

```powershell
git add docs/release-0.8.0.md README.md CONTEXT.md
git commit -m "docs: 完善区域项目预算发布说明"
```

- [x] **Step 7: 推送并等待 CI**

Run:

```powershell
git push origin main
$runId = gh run list --repo AllernChen/ucli-server --branch main --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $runId --repo AllernChen/ucli-server --exit-status
```

Expected: `verify`、`group-integration`、`docker-build` 全绿。

---

## 计划自检记录

- 7 个业务区域：Task 1、2、8、9 覆盖。
- 项目管理模块：Task 2、7、8 覆盖。
- 项目关联区域：Task 1、2、9 覆盖。
- 项目独立预算：Task 3、5、7、8、9、10 覆盖。
- 用量组区域展示：Task 2、8 覆盖。
- 区域成员默认可领项目 Key：Task 2、4、8 覆盖。
- 不使用请求头选择项目：Task 4、5、10 用正反向测试覆盖。
- 设备授权项目化：Task 6 覆盖。
- 历史数据不重算：Task 1、7、9 覆盖。
- 生产迁移与替换 Key：Task 9 覆盖。
- 请求/响应正文隐私边界：Task 3、4、5 的快照与审计约束覆盖。
