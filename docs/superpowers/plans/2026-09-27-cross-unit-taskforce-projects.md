# 跨组织单元抽调攻坚项目 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让平台管理员可创建挂靠公司经营层（EXECUTIVE）的攻坚项目，从任意组织单元抽调成员（跨单元加人仅平台管理员），管理端可全局搜索候选人。

**Architecture:** 零 schema 迁移。三处小改：`ProjectsService.region()` 挂靠校验按 `org_type` 放宽；`addMember` 增加跨单元权限收紧 + 新增只读 `member-candidates` 接口；管理端两个视图换数据源。设计文档见 `docs/superpowers/specs/2026-09-27-cross-unit-taskforce-projects-design.md`（下称 spec，`[Sn]` 锚点沿用其编号）。

**Tech Stack:** NestJS（flat controller/service/dto）、Prisma（PostgreSQL）、Vue 3 `<script setup>`、Vitest（后端集成测试用 `TEST_DATABASE_URL` 门控 PostgreSQL；前端组件测试 happy-dom）。

## Global Constraints

- 提交信息中文、说明 why，前缀 `feat:` / `test:` / `docs:` / `chore:`。
- TypeScript strict；**不新增任何依赖**（`npm run licenses:check` 是门禁）。
- **无 Prisma schema 迁移**（spec S3：零 schema 迁移）。
- 不改动网关、packages/*、预算结算逻辑（spec S2 非目标）。
- 权威组织口径是 `usage_groups.org_type`（EXECUTIVE/FUNCTIONAL/REGION/LEGACY_PROJECT）；`type` 是遗留列（spec S4/S10）。
- 集成测试门控：`describe.skipIf(!process.env.TEST_DATABASE_URL)`；本地跑法见 Task 1 Step 1。
- 测试 HTTP 一律 Node fetch，禁止 PowerShell `Invoke-RestMethod`（AGENTS.md）。
- 主目录 `node_modules` 是 v0.3.x 时代安装的，**动手前先 `npm install`**。
- 收尾顺序约定（spec S7）：先移除成员（自动撤 Key）再归档项目；本期不改 `archive` 行为。

---

### Task 1: 挂靠放宽——EXECUTIVE 可承载业务项目

**Covers:** S4, S3

**Files:**
- Modify: `apps/api/src/projects.service.ts`（`region()` 方法，约 L108-121）
- Modify: `test/integration/projects.test.ts`（新增用例 + 10 处 fixture 补 `orgType`）
- Modify: `test/integration/project-budget.test.ts:15`、`test/analytics/project-dimensions.test.ts:13`（fixture 补 `orgType`）

**Interfaces:**
- Consumes: `OrgUnitsService.create(actor, { name, kind })`（已存在）；`withTestDatabase` / `createOrganization`（`test/integration/database.ts`）。
- Produces: `region()` 语义变更——`org_type IN ('REGION','EXECUTIVE')`。Task 2/3 的测试依赖此语义创建 EXECUTIVE 挂靠项目。

- [ ] **Step 0: 环境准备（一次性）**

```powershell
npm install
docker compose -f docker-compose.dev.yml up -d postgres
docker exec ucli-server-postgres-1 psql -U ucli -d ucli -c "CREATE DATABASE ucli_test_taskforce"
$env:DATABASE_URL = 'postgresql://ucli:ucli-change-me@127.0.0.1:5432/ucli_test_taskforce'
$env:TEST_DATABASE_URL = $env:DATABASE_URL
npx prisma migrate deploy
```

Expected: migrate deploy 输出全绿（`All migrations have been applied`）。容器名如不同，用 `docker ps` 确认（dev compose 项目名 `ucli-server`）。库表结构在后续 Task 复用，`TEST_DATABASE_URL` 每个新 shell 会话都要重设。

- [ ] **Step 1: 写失败测试（新用例 + fixture 补齐）**

`test/integration/projects.test.ts` 新增用例（放在 `creates projects under an active region...` 之后）：

```ts
  it('allows executive org units to host task-force projects while functional units stay rejected', async () => {
    await withTestDatabase(async db => {
      const { actor } = await createOrganization(db)
      const organizations = new OrgUnitsService(db as PrismaService)
      const service = new ProjectsService(db as PrismaService)
      const executive = await organizations.create(actor, { name: '公司经营层', kind: 'EXECUTIVE' })
      const functional = await organizations.create(actor, { name: '研发部', kind: 'FUNCTIONAL' })

      const project = await service.create(actor, {
        ownerOrgUnitId: executive.id, category: 'BUSINESS', code: 'TF-2026', name: '跨单元攻坚'
      })
      expect(project).toMatchObject({ regionId: executive.id, category: 'BUSINESS' })

      await expect(service.create(actor, {
        ownerOrgUnitId: functional.id, code: 'TF-FUNC', name: '职能挂靠'
      })).rejects.toMatchObject({ status: 404 })
    })
  })
```

同时给本文件及另外两个文件里所有**裸 `db.usageGroup.create({ data: { ..., type: 'REGION' } })`** 补上 `orgType: 'REGION'`（否则 region() 改列后这些 fixture 会因默认 `LEGACY_PROJECT` 而 404）。精确位置（行号以当前 main 为准）：

- `test/integration/projects.test.ts`：L31、L87、L101（外组织区域也要补）、L117、L142、L169、L170、L196、L230、L253
- `test/integration/project-budget.test.ts`：L15
- `test/analytics/project-dimensions.test.ts`：L13

改法一致（以 L31 为例）：

```ts
      const region = await db.usageGroup.create({ data: {
        organizationId: actor.organizationId, name: '广东-省厅区域', type: 'REGION', orgType: 'REGION'
      } })
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run test/integration/projects.test.ts
```

Expected: 新用例 FAIL（`rejects toMatchObject { status: 404 }` 落空——EXECUTIVE 挂靠当前被拒，实际抛 404 而期望成功）；其余用例 PASS。

- [ ] **Step 3: 改 region() 校验**

`apps/api/src/projects.service.ts` 的 `region()`，将 `AND type = 'REGION'` 一行改为：

```ts
  private async region(db: Prisma.TransactionClient, organizationId: string, regionId: string) {
    const regions = await db.$queryRaw<Array<{ id: string, name: string }>>(Prisma.sql`
      SELECT id, name FROM usage_groups
      WHERE id = ${regionId}::uuid
        AND organization_id = ${organizationId}::uuid
        AND org_type IN ('REGION', 'EXECUTIVE')
        AND enabled = true
        AND archived_at IS NULL
      FOR UPDATE
    `)
    const region = regions[0]
    if (!region) throw new NotFoundException('Region usage group not found')
    return region
  }
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npx vitest run test/integration test/analytics
```

Expected: 全部 PASS（含补齐 orgType 的 12 处 fixture 用例）。

- [ ] **Step 5: 提交**

```powershell
git add apps/api/src/projects.service.ts test/integration/projects.test.ts test/integration/project-budget.test.ts test/analytics/project-dimensions.test.ts
git commit -m "feat: 项目挂靠放宽至公司经营层

攻坚项目需要挂靠 EXECUTIVE 组织单元走经营层专项预算。挂靠校验从遗留
type 列切换到收敛后的 org_type 口径，REGION/EXECUTIVE 可挂靠；测试
fixture 同步补齐 orgType。"
```

---

### Task 2: addMember 跨单元权限收紧

**Covers:** S5.2, S5.3

**Files:**
- Modify: `apps/api/src/projects.service.ts`（`addMember`，约 L150-167）
- Modify: `test/integration/projects.test.ts`（更新既有跨部门用例 + 新增收紧用例）

**Interfaces:**
- Consumes: Task 1 的 EXECUTIVE 挂靠能力。
- Produces: `addMember` 新增行为——候选人不属于项目挂靠单元时仅 `PLATFORM_ADMIN` 可加（403 文案 `Platform administrator required to add cross-unit members`）；单元内加人 ORG_ADMIN 不变。Task 5 前端置灰逻辑依赖 `member-candidates.inRegion`（Task 3）与此规则对应。

- [ ] **Step 1: 更新既有用例 + 写失败测试**

`test/integration/projects.test.ts` 中既有用例 `uses an organization owner, filters categories, and allows explicit cross-department collaborators`（L52-79）当前以 ORG_ADMIN 身份把工程部成员加进区域项目——收紧后会 403。将其 L71-74 段替换为：

```ts
      await organizations.addMember(actor, engineering.id, account.id)
      const platformActor = { organizationId: actor.organizationId, sub: actor.sub,
        role: 'PLATFORM_ADMIN' as const, tokenVersion: 1 }
      await expect(projects.addMember(actor, project.id, { accountId: account.id, role: 'CONTRIBUTOR' }))
        .rejects.toMatchObject({ status: 403 })
      await projects.addMember(platformActor, project.id, { accountId: account.id, role: 'CONTRIBUTOR' })
      const detail = await projects.detail(actor, project.id)
      expect(detail.members).toHaveLength(1)
```

（其后原有的 DEPARTMENT 409 断言保持不变。）再新增专项用例：

```ts
  it('lets organization administrators add only in-region members to projects', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const organizations = new OrgUnitsService(db as PrismaService)
      const service = new ProjectsService(db as PrismaService)
      const region = await organizations.create(actor, { name: '广东-市局', kind: 'REGION' })
      const project = await service.create(actor, { ownerOrgUnitId: region.id, code: 'IN-REGION', name: '区域内项目' })

      await organizations.addMember(actor, region.id, account.id)
      await service.addMember(actor, project.id, { accountId: account.id, role: 'CONTRIBUTOR' })
      const detail = await service.detail(actor, project.id)
      expect(detail.members.map(member => member.accountId)).toEqual([account.id])
    })
  })
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run test/integration/projects.test.ts
```

Expected: FAIL——被改写的既有用例在 `projects.addMember(actor, ...)` 处仍成功（未抛 403）。

- [ ] **Step 3: 实现收紧**

`addMember` 中，紧跟现有 `organizationMember` 校验之后、`projectMember.upsert` 之前插入：

```ts
      const inRegion = await db.groupMember.findFirst({ where: {
        organizationId: actor.organizationId, groupId: project.regionId, accountId: input.accountId, removedAt: null,
        group: { enabled: true, archivedAt: null, organization: { enabled: true } },
        membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } }
      } })
      if (!inRegion && actor.role !== 'PLATFORM_ADMIN') {
        throw new ForbiddenException('Platform administrator required to add cross-unit members')
      }
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npx vitest run test/integration
```

Expected: 全部 PASS（重点：`employee-project-keys`、`employee-api-keys`、`me-projects` 等既有加成员用例未回归——它们都是单元内加人或平台管理员场景；若有 403 回归，检查该用例的 fixture 是否把成员加进了项目挂靠单元）。

- [ ] **Step 5: 提交**

```powershell
git add apps/api/src/projects.service.ts test/integration/projects.test.ts
git commit -m "feat: 跨组织单元加项目成员收紧为平台管理员专属

抽调场景下跨单元成员资格代表组织间借调，须由平台管理员操作；单元内
加人维持组织管理员权限，收尾撤 Key 行为不变。"
```

---

### Task 3: member-candidates 只读接口

**Covers:** S5.1

**Files:**
- Modify: `apps/api/src/projects.dto.ts`（新增 `ProjectMemberCandidatesQueryDto`）
- Modify: `apps/api/src/projects.service.ts`（新增 `memberCandidates` 方法）
- Modify: `apps/api/src/projects.controller.ts`（新增 GET 路由，置于 `@Post(':id/members')` 附近）
- Test: `test/integration/projects.test.ts`

**Interfaces:**
- Consumes: Task 1 挂靠能力；`PageQueryDto`（`apps/api/src/catalog.dto.ts`，`limit=50`/`offset=0`）。
- Produces: `GET /api/v1/admin/projects/:id/member-candidates?q=&offset=&limit=` → `{ items, total, offset, limit }`，每项 `{ accountId, displayName, email, inRegion, orgUnits: [{ id, name, orgType, isPrimary }] }`。Task 5 前端与组件测试直接消费此结构（类型名 `MemberCandidate`）。

- [ ] **Step 1: 写失败测试**

`test/integration/projects.test.ts` 新增：

```ts
  it('lists cross-unit member candidates with affiliation and in-region flags', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const organizations = new OrgUnitsService(db as PrismaService)
      const service = new ProjectsService(db as PrismaService)
      const executive = await organizations.create(actor, { name: '公司经营层', kind: 'EXECUTIVE' })
      const engineering = await organizations.create(actor, { name: '工程部', kind: 'FUNCTIONAL' })
      const project = await service.create(actor, { ownerOrgUnitId: executive.id, code: 'TF-CAND', name: '攻坚候选' })
      await service.addMember({ ...actor, role: 'PLATFORM_ADMIN' }, project.id, { accountId: account.id, role: 'CONTRIBUTOR' })

      const outsider = await db.account.create({ data: { email: `outsider-${randomUUID()}@example.invalid`, displayName: '跨单元工程师' } })
      await db.membership.create({ data: { organizationId: actor.organizationId, accountId: outsider.id, role: 'MEMBER' } })
      await organizations.addMember(actor, engineering.id, outsider.id)
      const insider = await db.account.create({ data: { email: `insider-${randomUUID()}@example.invalid`, displayName: '经营层成员' } })
      await db.membership.create({ data: { organizationId: actor.organizationId, accountId: insider.id, role: 'MEMBER' } })
      await organizations.addMember(actor, executive.id, insider.id)

      const result = await service.memberCandidates(actor, project.id, Object.assign(
        new ProjectMemberCandidatesQueryDto(), { limit: 50, offset: 0 } ))
      expect(result.total).toBe(2)
      const outsiderRow = result.items.find(item => item.accountId === outsider.id)
      expect(outsiderRow).toMatchObject({ displayName: '跨单元工程师', inRegion: false })
      expect(outsiderRow!.orgUnits).toEqual([expect.objectContaining({ name: '工程部', orgType: 'FUNCTIONAL', isPrimary: true })])
      expect(result.items.find(item => item.accountId === insider.id)).toMatchObject({ inRegion: true })

      const searched = await service.memberCandidates(actor, project.id, Object.assign(
        new ProjectMemberCandidatesQueryDto(), { q: '跨单元', limit: 50, offset: 0 } ))
      expect(searched.items.map(item => item.accountId)).toEqual([outsider.id])
    })
  })
```

文件头部 import 增加：`import { ProjectMemberCandidatesQueryDto } from '../../apps/api/src/projects.dto.js'`（`randomUUID` 已由现有 import 提供）。注意已有项目成员（`account`）不得出现在候选中——用例隐含断言 `total === 2`（排除了 account）。

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run test/integration/projects.test.ts
```

Expected: FAIL，`service.memberCandidates is not a function`。

- [ ] **Step 3: 实现 DTO + service + controller**

`apps/api/src/projects.dto.ts` 追加：

```ts
export class ProjectMemberCandidatesQueryDto extends PageQueryDto {
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 200) q?: string
}
```

`apps/api/src/projects.service.ts` 新增方法（import 处补 `ProjectMemberCandidatesQueryDto`）：

```ts
  async memberCandidates(actor: AuthPrincipal, id: string, query: ProjectMemberCandidatesQueryDto) {
    this.assertAdmin(actor)
    const project = await this.prisma.project.findFirst({ where: { id, organizationId: actor.organizationId } })
    if (!project) throw new NotFoundException('Project not found')
    const existing = await this.prisma.projectMember.findMany({ where: { projectId: id }, select: { accountId: true } })
    const excluded = new Set(existing.map(member => member.accountId))
    const rows = await this.prisma.groupMember.findMany({ where: {
      organizationId: actor.organizationId, removedAt: null,
      group: { enabled: true, archivedAt: null, organization: { enabled: true } },
      membership: { status: 'ACTIVE', account: { status: 'ACTIVE',
        ...(query.q ? { OR: [
          { displayName: { contains: query.q, mode: 'insensitive' as const } },
          { email: { contains: query.q, mode: 'insensitive' as const } }
        ] } : {}) } } },
      select: { accountId: true, isPrimary: true,
        group: { select: { id: true, name: true, orgType: true } },
        membership: { select: { account: { select: { displayName: true, email: true } } } } } })
    const byAccount = new Map<string, { accountId: string; displayName: string; email: string;
      orgUnits: Array<{ id: string; name: string; orgType: string; isPrimary: boolean }>; inRegion: boolean }>()
    for (const row of rows) {
      if (excluded.has(row.accountId)) continue
      const entry = byAccount.get(row.accountId) ?? { accountId: row.accountId,
        displayName: row.membership.account.displayName, email: row.membership.account.email, orgUnits: [], inRegion: false }
      entry.orgUnits.push({ id: row.group.id, name: row.group.name, orgType: row.group.orgType, isPrimary: row.isPrimary })
      if (row.group.id === project.regionId) entry.inRegion = true
      byAccount.set(row.accountId, entry)
    }
    const items = [...byAccount.values()]
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .slice(query.offset, query.offset + query.limit)
    return { items, total: byAccount.size, offset: query.offset, limit: query.limit }
  }
```

`apps/api/src/projects.controller.ts` 在 `@Get(':id/members')` 之前插入（import 补 `ProjectMemberCandidatesQueryDto`）：

```ts
  @Get(':id/member-candidates') memberCandidates(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string,
    @Query() query: ProjectMemberCandidatesQueryDto) { return this.projects.memberCandidates(req.principal, id, query) }
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npx vitest run test/integration/projects.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add apps/api/src/projects.service.ts apps/api/src/projects.controller.ts apps/api/src/projects.dto.ts test/integration/projects.test.ts
git commit -m "feat: 项目成员候选接口支持跨单元搜索

管理端选择器只能看到项目挂靠单元的成员，抽调需要全组织候选。新接口返回
活跃成员的归属单元与 inRegion 标记，排除已有成员，供跨单元选择器消费。"
```

---

### Task 4: org-units kind 过滤支持逗号分隔

**Covers:** S6.1

**Files:**
- Modify: `apps/api/src/org-units.dto.ts:6-10`（`OrgUnitPageQueryDto.kind`）
- Modify: `apps/api/src/org-units.service.ts`（`list` 的 kind where，约 L70）
- Test: `test/integration/org-unit-members.test.ts`

**Interfaces:**
- Consumes: `OrgUnitType` enum（@prisma/client）。
- Produces: `GET /api/v1/admin/org-units?kind=REGION,EXECUTIVE` 一并返回两类单元；单值 `kind=REGION` 向后兼容。Task 5 的 `loadOrganizations` 消费此格式。

- [ ] **Step 1: 写失败测试**

`test/integration/org-unit-members.test.ts` 新增用例（import 该文件已具备的 `OrgUnitsService`、`withTestDatabase`、`createOrganization` 依赖；若缺 `OrgUnitPageQueryDto` 则从 `../../apps/api/src/org-units.dto.js` 补 import）：

```ts
  it('accepts comma-separated kinds for project owner pickers', async () => {
    await withTestDatabase(async db => {
      const { actor } = await createOrganization(db)
      const service = new OrgUnitsService(db as PrismaService)
      await service.create(actor, { name: '公司经营层', kind: 'EXECUTIVE' })
      await service.create(actor, { name: '研发部', kind: 'FUNCTIONAL' })
      await service.create(actor, { name: '广东-市局', kind: 'REGION' })

      const combined = await service.list(actor.organizationId, Object.assign(
        new OrgUnitPageQueryDto(), { kind: ['REGION', 'EXECUTIVE'] as OrgUnitType[] }))
      expect(combined.items.map(item => item.name).sort()).toEqual(['公司经营层', '广东-市局'])
      const single = await service.list(actor.organizationId, Object.assign(
        new OrgUnitPageQueryDto(), { kind: ['REGION'] as OrgUnitType[] }))
      expect(single.items.map(item => item.name)).toEqual(['广东-市局'])
    })
  })
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run test/integration/org-unit-members.test.ts
```

Expected: FAIL——当前 `kind` 是单枚举，`where orgType: ['REGION','EXECUTIVE']` 传数组与 `OrgUnitType` 不匹配导致查询为空（`toEqual(['公司经营层','广东-市局'])` 落空）。

- [ ] **Step 3: 实现**

`apps/api/src/org-units.dto.ts`：import 增加 `IsArray`（`ArrayUnique` 已有）；`kind` 改为：

```ts
export class OrgUnitPageQueryDto extends PageQueryDto {
  @IsOptional() @Transform(({ value }) => typeof value === 'string'
    ? value.split(',').map((item: string) => item.trim()).filter(Boolean) : value)
  @IsArray() @ArrayUnique() @IsEnum(OrgUnitType, { each: true }) kind?: OrgUnitType[]
  @IsIn(['active', 'disabled', 'archived', 'all']) status: 'active' | 'disabled' | 'archived' | 'all' = 'active'
  @IsOptional() @IsString() @Length(1, 200) q?: string
}
```

`apps/api/src/org-units.service.ts` `list()` 中 `...(query.kind ? { orgType: query.kind } : {})` 改为：

```ts
      ...(query.kind?.length ? { orgType: { in: query.kind } } : {}),
```

- [ ] **Step 4: 跑测试确认通过 + 检查其他 kind 消费方**

```powershell
npx vitest run test/integration test/admin
```

并执行 `rg "kind=|query.kind|kind:" apps/` 确认其余调用方（如 `Usage.vue`、Dashboard）传的是单值字符串——单值经 Transform 仍成数组，向后兼容。

Expected: 全部 PASS；无调用方需要改动。

- [ ] **Step 5: 提交**

```powershell
git add apps/api/src/org-units.dto.ts apps/api/src/org-units.service.ts test/integration/org-unit-members.test.ts
git commit -m "feat: 组织单元 kind 过滤支持逗号分隔

建项目表单需要同时拉取区域与公司经营层作为挂靠选项；单值传参保持兼容。"
```

---

### Task 5: 管理端——挂靠选项与跨单元成员选择器

**Covers:** S6.1, S6.2

**Files:**
- Modify: `apps/admin/src/projects.ts`（新增 `MemberCandidate` 类型）
- Modify: `apps/admin/src/views/Projects.vue`（`loadOrganizations` L26-29、新建对话框文案与选项）
- Modify: `apps/admin/src/views/ProjectDetail.vue`（候选人数据源、搜索框、置灰逻辑、`/auth/me` 取角色）
- Test: `test/admin/projects.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `member-candidates` 响应结构；Task 4 的 `kind=REGION,EXECUTIVE`；`/api/v1/auth/me` 的 `role` 字段（`Usage.vue:70` 既有模式）。
- Produces: 无（末端 UI）。

- [ ] **Step 1: 写失败组件测试**

`test/admin/projects.test.ts` 修改第三个用例（`supports member management and platform administrator submit-and-approve`）的 mock：为 `/auth/me` 与 `member-candidates` 增加分支，并把候选下拉改为新结构：

```ts
    if (url.includes('/auth/me')) return { role: 'ORG_ADMIN' }
    if (url.includes('member-candidates')) return { items: [
      { accountId: 'employee-2', displayName: '区域成员', email: 'member@example.invalid', inRegion: true,
        orgUnits: [{ id: 'region-1', name: '广东-市局', orgType: 'REGION', isPrimary: true }] },
      { accountId: 'employee-3', displayName: '跨单元工程师', email: 'taskforce@example.invalid', inRegion: false,
        orgUnits: [{ id: 'unit-eng', name: '工程部', orgType: 'FUNCTIONAL', isPrimary: true }] }
    ], total: 2, offset: 0, limit: 100 }
```

（`url.includes('/members')` 分支保留，注意放在 `member-candidates` 分支之后不会误吞——`member-candidates` 不含 `/members` 子串，两者顺序无关。）断言追加：

```ts
  expect(wrapper.get('[aria-label="选择项目成员"]').element.querySelector('option[value="employee-3"]')!.disabled).toBe(true)
  expect(wrapper.text()).toContain('工程部')
```

并在该文件第一个用例（列表）中，将 `loadOrganizations` 的断言加进去（需在 mock 中补 `url.includes('org-units')` 返回 `{ items: [...], ...page }`，含 `orgType` 字段）：

```ts
  expect(state.url).toMatch(/kind=REGION(%2C|,)EXECUTIVE/)
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run test/admin/projects.test.ts
```

Expected: FAIL——候选 mock 分支未被请求（仍请求 `org-units/${regionId}/members`），断言落空。

- [ ] **Step 3: 实现前端**

`apps/admin/src/projects.ts` 追加：

```ts
export type MemberCandidate = {
  accountId: string
  displayName: string
  email: string
  inRegion: boolean
  orgUnits: Array<{ id: string; name: string; orgType: string; isPrimary: boolean }>
}
```

`Projects.vue` `loadOrganizations` 改为：

```ts
async function loadOrganizations() {
  try { organizations.value = (await api<Page<any>>('/api/v1/admin/org-units?kind=REGION,EXECUTIVE&limit=100')).items ?? [] }
  catch { organizations.value = [] }
}
```

新建对话框选项显示区分（`{{ org.orgType === 'EXECUTIVE' ? '公司经营层' : '区域' }} · {{ org.name }}`），Drawer 描述文案改为"项目归属区域部门或公司经营层，并使用独立项目预算"，空选项"请选择所属组织"。

`ProjectDetail.vue`：

1. 头部补 `const role = ref('')`、`const memberQuery = ref('')`，`onMounted` 内加 `try { role.value = (await api<any>('/api/v1/auth/me')).role || '' } catch { role.value = '' }`；
2. 候选加载从 `api(`/api/v1/admin/org-units/${loadedProject.regionId}/members?limit=100`)` 换为：

```ts
api<Page<MemberCandidate>>(`/api/v1/admin/projects/${route.params.id}/member-candidates?limit=100${memberQuery.value ? `&q=${encodeURIComponent(memberQuery.value)}` : ''}`)
```

3. 模板：成员表单加搜索输入 `<input v-model="memberQuery" aria-label="搜索候选人" placeholder="姓名或邮箱">` 与搜索按钮（点击重跑候选加载）；选项改为：

```html
<option v-for="candidate in candidates.items" :key="candidate.accountId" :value="candidate.accountId"
  :disabled="!candidate.inRegion && role !== 'PLATFORM_ADMIN'">
  {{ candidate.displayName }} · {{ candidate.email }} · {{ candidate.orgUnits.map(unit => unit.name + (unit.isPrimary ? '（主）' : '')).join('/') }}
</option>
```

4. 表单下方加提示 `<p v-if="role === 'ORG_ADMIN'" class="state">跨单元候选人需平台管理员添加</p>`（样式沿用 `forms.css` 既有 `state` 类）。候选刷新函数抽为 `loadCandidates()` 供搜索按钮与初始加载共用。

- [ ] **Step 4: 跑测试确认通过**

```powershell
npx vitest run test/admin/projects.test.ts
```

Expected: PASS（含新增的置灰与归属单元展示断言）。

- [ ] **Step 5: 提交**

```powershell
git add apps/admin/src/projects.ts apps/admin/src/views/Projects.vue apps/admin/src/views/ProjectDetail.vue test/admin/projects.test.ts
git commit -m "feat: 管理端支持经营层挂靠与跨单元候选选择器

抽调攻坚项目从全组织搜索候选人并展示归属单元；组织管理员视角跨单元
候选人置灰并提示需平台管理员，新建项目挂靠选项纳入公司经营层。"
```

---

### Task 6: 全量验证与 spec 状态收口

**Covers:** S8, S9

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-cross-unit-taskforce-projects-design.md`（状态行）

**Interfaces:**
- Consumes: Task 1-5 全部产出。
- Produces: `npm run verify` 全绿的可发布状态。

- [ ] **Step 1: 上线前数据核对（spec S9）**

对**生产库**只读核对遗留 `type` 列与新 `org_type` 口径一致性（本步骤只读，不修改生产）：

```powershell
docker exec -e PGPASSWORD=<生产密码> ucli-prod-postgres-1 psql -U ucli -d ucli -c "SELECT id, name FROM usage_groups WHERE type = 'REGION' AND org_type <> 'REGION';"
```

Expected: 0 行。若非 0 行，停止并上报（存在 type=REGION 但 org_type 非 REGION 的历史行，需先修数据）。

- [ ] **Step 2: 全量门禁**

```powershell
$env:DATABASE_URL = 'postgresql://ucli:ucli-change-me@127.0.0.1:5432/ucli_test_taskforce'
$env:TEST_DATABASE_URL = $env:DATABASE_URL
npm run verify
```

Expected: typecheck、全部测试（含集成）、覆盖率门槛、后端与管理端构建、license 检查全绿。

- [ ] **Step 3: 更新 spec 状态并提交**

spec 首行状态改为：

```markdown
状态：已实现并通过 `npm run verify`（2026-09-27）。收尾操作顺序与上线核对见 [S7]/[S9]。
```

```powershell
git add docs/superpowers/specs/2026-09-27-cross-unit-taskforce-projects-design.md
git commit -m "docs: 攻坚项目设计标记已实现"
```

---

## 收尾操作约定（部署后提醒，非本计划任务）

攻坚结束顺序：**先逐个移除成员（自动撤 Key）→ 处理完预算预占/待核对 → 再归档项目**（spec S7；`archive` 现状不撤 Key）。
