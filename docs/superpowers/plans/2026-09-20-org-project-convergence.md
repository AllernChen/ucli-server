# Organization and Project Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the product-level “usage group / region” model with one organization model, put all runtime budgets and employee keys on projects, and provide department-budget projects for functional departments and the executive team.

**Architecture:** Use a compatibility-first upgrade. Existing `usage_groups`, `group_members`, and `projects.region_id` storage remains for rollback safety, while new APIs and UI expose organization and owner-organization semantics. Runtime authorization becomes project-centric: organization membership identifies a person’s primary department, project membership authorizes work, and every new employee key requires a project. Legacy usage-group APIs become read-only compatibility surfaces until old keys are replaced.

**Tech Stack:** NestJS 11, Prisma 6 / PostgreSQL, Vue 3 `<script setup>`, Vitest, existing project-budget and employee-key services. No new npm dependencies.

## Global Constraints

- Release version is `0.9.0`; this is a schema and domain-model upgrade.
- Every Prisma schema change ships with a migration; no new dependencies.
- Product terminology is “组织 / 部门 / 项目”; do not expose “区域” or “用量组” as separate concepts.
- Organization kinds are exactly `EXECUTIVE`, `FUNCTIONAL`, `REGION`, `LEGACY_PROJECT`.
- Project categories are exactly `BUSINESS`, `DEPARTMENT`.
- An account has at most one active organization membership.
- `REGION` organizations own `BUSINESS` projects.
- Each `FUNCTIONAL` / `EXECUTIVE` organization owns exactly one active `DEPARTMENT` project.
- Department-project membership synchronizes from organization membership.
- Business-project membership is explicit; cross-department collaborators are allowed.
- Every newly issued employee key binds to a project and the holder must be a project member.
- Runtime budget is project budget only; organization pages show aggregates only.
- Platform administrators may submit and approve their own project-budget application, marked `selfApproved`.
- Legacy group budget/application flows are frozen for new submissions and retained as history.
- Preserve production `MASTER_KEY`; never print or copy it.
- Gateway request and response bodies remain in memory only and are never logged or persisted.
- Rollback restores the pre-upgrade database, both 0.8.2 images, and the original `MASTER_KEY` as one unit.
- Production spelling is `罗晰伊` (`luo01@ucli.local`); requirement text `罗乔伊` is treated as this account. If a different person is intended, stop before migration.

## Verified Production Baseline

- Production 0.8.2 runs source commit `ea787cd7a8a02ccae2288b13e10d654f652188f0`.
- Eight rows are currently typed `REGION`: seven business regions plus `研发部`.
- `研发部` must become `FUNCTIONAL`.
- Active multi-organization accounts include 陈旭均, 曹庆杰, 何雪岚, 李健, 罗晰伊, 苗美静, 石教帅, 王宇, and 姚依林.
- Current `lijian` 503 is `model_protocol_unavailable`: client protocol is `OPENAI_CHAT`, but `deepseek-v4-flash` currently publishes only `ANTHROPIC_MESSAGES` and `OPENAI_RESPONSES`.

## Target Data

| Organization | Kind | Members |
| --- | --- | --- |
| 公司经营层 | `EXECUTIVE` | 李健, 罗晰伊, 王宇 |
| 研发部 | `FUNCTIONAL` | 陈旭均, 姚依林, 何雪岚, 石教帅 |
| 工程部 | `FUNCTIONAL` | 曹庆杰, 陈程浩, 汪力波, 苗美静 |
| Seven business regions | `REGION` | Their remaining single-primary members |
| Historical `PROJECT` groups | `LEGACY_PROJECT` | No active organization membership |

Department projects:

| Code | Name | Owner |
| --- | --- | --- |
| `DEPT-EXEC` | 公司经营层-部门预算 | 公司经营层 |
| `DEPT-RD` | 研发部-部门预算 | 研发部 |
| `DEPT-ENG` | 工程部-部门预算 | 工程部 |

All department projects start at zero budget. A platform administrator explicitly submits and approves their initial totals.

---

### Task 1: Organization and Project Schema Migration

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/202609200001_org_project_convergence/migration.sql`
- Test: `test/deploy/org-convergence-schema.test.ts`

**Interfaces:**

- Produces `UsageGroup.orgType`, `Project.category`, `ProjectBudgetApplication.selfApproved`, and two partial unique indexes.

- [ ] Write a failing schema test asserting: both new enums exist; old `UsageGroupType` and physical `region_id` remain; migration creates `org_unit_one_active_membership_where_removed_null` and `one_department_project_per_owner_where_active`; migration contains no `DROP TABLE` or `DROP COLUMN`.
- [ ] Add Prisma definitions:

```prisma
enum OrgUnitType {
  EXECUTIVE
  FUNCTIONAL
  REGION
  LEGACY_PROJECT
}

enum ProjectCategory {
  BUSINESS
  DEPARTMENT
}
```

Add `orgType OrgUnitType @default(LEGACY_PROJECT) @map("org_type")` to `UsageGroup`, `category ProjectCategory @default(BUSINESS)` to `Project`, and `selfApproved Boolean @default(false) @map("self_approved")` to `ProjectBudgetApplication`.

- [ ] Write an additive migration that creates the enum types and columns, maps current `REGION` rows except `研发部` to `REGION`, maps `研发部` and `DEPARTMENT` rows to `FUNCTIONAL`, maps `PROJECT` rows to `LEGACY_PROJECT`, and idempotently creates `工程部` and `公司经营层`.
- [ ] In the same migration, close active memberships in historical `PROJECT` groups with `removed_at = now()`, move the explicit target members to their target organizations, close their other active organization memberships, and fail if any active duplicate remains. Never delete membership history.
- [ ] Create the three department projects with `category='DEPARTMENT'`, `region_id=<owner organization id>`, status `ACTIVE`, and budget mode `TOTAL`; insert their organization members as `CONTRIBUTOR`.
- [ ] Copy `研发验收组` model access to 公司经营层, 研发部, and 工程部 with `ON CONFLICT DO NOTHING`.
- [ ] Create:

```sql
CREATE UNIQUE INDEX org_unit_one_active_membership_where_removed_null
ON group_members (organization_id, account_id) WHERE removed_at IS NULL;

CREATE UNIQUE INDEX one_department_project_per_owner_where_active
ON projects (organization_id, region_id)
WHERE category = 'DEPARTMENT' AND status = 'ACTIVE';
```

- [ ] Run `npm run db:generate`, the new test, and `npm run typecheck`.
- [ ] Commit: `feat: 增加组织与项目分类模型`.

---

### Task 2: Migration Rehearsal and Verifier

**Files:**

- Create: `scripts/verify-org-convergence.mjs`
- Test: `test/deploy/org-convergence-migration.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces a read-only verifier with `expectedOrganizationSnapshot(input)` and CLI exit code 0 only when the snapshot is correct.

- [ ] Write a failing test using the exact target: 1 executive organization, 2 functional organizations, 7 regions, 3 department projects, and 0 active duplicate members.
- [ ] Implement the verifier to query active duplicates, organization kinds, target members, and department projects. Require an explicit rehearsal database URL and print only counts/names.
- [ ] Restore the newest production backup to an isolated database, run `npx prisma migrate deploy`, then run the verifier.
- [ ] Expected output: `active duplicate members=0`, executive=1, functional=2, region=7, department projects=3.
- [ ] Commit: `test: 演练组织项目收敛迁移`.

---

### Task 3: Organization API

**Files:**

- Create: `apps/api/src/org-units.dto.ts`, `apps/api/src/org-units.controller.ts`, `apps/api/src/org-units.service.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/usage-groups.controller.ts`
- Test: `test/integration/org-units.test.ts`

**Interfaces:**

```http
GET/POST /api/v1/admin/org-units
GET/PATCH /api/v1/admin/org-units/:id
GET/POST/DELETE /api/v1/admin/org-units/:id/members...
POST /api/v1/admin/org-units/:id/head
GET /api/v1/admin/org-units/:id/projects
GET/PUT /api/v1/admin/org-units/:id/model-access
```

- [ ] Write failing tests for kind filtering, summaries, department project visibility, admin-only mutation, and 409 on `LEGACY_PROJECT` mutation.
- [ ] Implement DTOs with `kind` limited to the four organization types and existing page/search conventions.
- [ ] Implement list/detail/create/update. Creating `EXECUTIVE` or `FUNCTIONAL` automatically creates its department project; `REGION` does not. Public API never creates `LEGACY_PROJECT`.
- [ ] Return active member/project/key counts, model count, department project ID, and aggregate business-project budget for regions.
- [ ] Keep old `/usage-groups` reads for compatibility, but return 409 from legacy mutation paths after convergence.
- [ ] Run focused integration tests and typecheck.
- [ ] Commit: `feat: 提供组织管理接口`.

---

### Task 4: Primary Membership and Department Sync

**Files:**

- Modify: `apps/api/src/org-units.service.ts`, `apps/api/src/projects.service.ts`
- Test: `test/integration/org-unit-members.test.ts`

**Interfaces:**

```ts
addMember(actor, orgUnitId, accountId): Promise<OrgMemberSummary>
removeMember(actor, orgUnitId, accountId): Promise<{ accountId: string; revokedDepartmentKeyCount: number }>
setHead(actor, orgUnitId, accountId): Promise<{ accountId: string; role: 'HEAD' }>
```

- [ ] Write failing tests covering move-to-new-primary, department member upsert, department member removal, department key revocation, business membership isolation, and legacy mutation rejection.
- [ ] Add member transactionally: lock organization, validate account, close prior active membership, upsert target membership, and synchronize functional/executive department project membership.
- [ ] Remove member transactionally: close organization membership, remove department project membership, revoke active keys bound only to that department project, and audit the operation.
- [ ] Ensure business project memberships survive primary-organization changes.
- [ ] Run focused tests and typecheck.
- [ ] Commit: `feat: 收敛员工主部门并同步部门项目`.

---

### Task 5: Organization-Owned Projects and Project Members

**Files:**

- Modify: `apps/api/src/projects.dto.ts`, `apps/api/src/projects.service.ts`, `apps/api/src/projects.controller.ts`
- Test: `test/integration/projects.test.ts`

**Interfaces:**

- API exposes `ownerOrgUnitId`, physically mapped to current `regionId`.
- Project API supports `category`, `ownerOrgUnitId`, and member roles `OWNER | CONTRIBUTOR | VIEWER`.

- [ ] Write failing tests: business owner must be `REGION`; department owner must be functional/executive; department projects cannot be manually created; candidate members default to owner organization; cross-department add works; department member mutations are synchronized-only; project owner is a `ProjectMember.role='OWNER'`.
- [ ] Update `CreateProjectDto` to require `ownerOrgUnitId`, `category='BUSINESS'`, `code`, and `name`.
- [ ] List/detail responses use `ownerOrgUnit` and `category`; preserve `regionId` only as a compatibility field if needed by old clients.
- [ ] Business project member additions allow owner-organization members by default and active cross-organization members by explicit administrator action; mark `crossDepartment`.
- [ ] Department project member endpoints reject manual mutation with 409 and point operators to organization membership.
- [ ] Run project integration tests and typecheck.
- [ ] Commit: `feat: 完善组织项目与成员管理`.

---

### Task 6: Project-Only Employee Keys

**Files:**

- Modify: `apps/api/src/employee-keys.dto.ts`, `apps/api/src/employee-keys.service.ts`, `apps/api/src/employee-keys.controller.ts`, `packages/security/src/gateway-auth.ts`
- Test: `test/integration/employee-project-keys.test.ts`, `test/security/gateway-project-auth.test.ts`

**Interfaces:**

```ts
export class CreateEmployeeKeyDto {
  name: string
  projectId: string
  expiresAt?: string | null
}
```

- [ ] Write failing tests: `projectId` required; `groupId` rejected; key holder must be active project member; `VIEWER` cannot receive keys; physical `groupId` derives from `project.regionId`; department and cross-department keys work; gateway rejects key after membership removal.
- [ ] Refactor creation transaction to load project, require `ACTIVE`, validate owner organization and membership, derive `groupId`, then preserve existing hash/ciphertext/audit logic.
- [ ] Refactor gateway authentication to require active key, account, organization, project, owner organization, and current project membership. Do not trust `groupId` alone.
- [ ] Run focused integration/security tests and typecheck.
- [ ] Commit: `feat: 员工Key收敛到项目成员`.

---

### Task 7: Project Budget Applications and Self-Approval

**Files:**

- Modify: `apps/api/src/projects.dto.ts`, `apps/api/src/projects.controller.ts`, `packages/quota/src/project-budget.service.ts`
- Test: `test/integration/project-budget.test.ts`

**Interfaces:**

```http
POST /api/v1/admin/projects/:id/budget-applications
POST /api/v1/admin/projects/:id/budget-applications/:applicationId/decision
POST /api/v1/admin/projects/:id/budget-applications/submit-and-approve
```

- [ ] Write failing tests: owner submits; department head submits department application; platform admin submits any project; contributor rejects; platform admin approves own application; `selfApproved=true` only when applicant equals decider; submit-and-approve is atomic; legacy group applications frozen.
- [ ] Allowed submitters: `PLATFORM_ADMIN`, `ORG_ADMIN`, business project `OWNER`, and owner organization `HEAD` for department projects.
- [ ] Use explicit total semantics: `requestedTotalCny` and `approvedTotalCny`; approved total is the resulting project total, never an increment.
- [ ] Extend existing project adjustment/application linking to persist `selfApproved`.
- [ ] Implement platform-admin submit-and-approve in one transaction, requiring reason and final total.
- [ ] Run focused tests and typecheck.
- [ ] Commit: `feat: 完善项目预算申请与自批复`.

---

### Task 8: Organization UI

**Files:**

- Create: `apps/admin/src/views/Organizations.vue`, `apps/admin/src/views/OrganizationDetail.vue`, `apps/admin/src/organizations.ts`
- Modify: `apps/admin/src/main.ts`, `apps/admin/src/App.vue`
- Test: `test/admin/organizations.test.ts`

**Interfaces:**

- Routes: `/org-units`, `/org-units/:id`.

- [ ] Write failing component tests for kind labels/filters, summaries, functional department project, region business projects, member/project tables, and read-only legacy organizations.
- [ ] Implement list columns: 组织, 类型, 负责人, 成员, 关联项目, 有效 Key, 部门预算项目, 操作. Hide legacy by default.
- [ ] Implement detail tabs: 概览, 成员, 项目, 项目人员关联, 模型权限, 预算, 用量.
- [ ] Functional/executive budget tab opens its department project and exposes current/used/reserved/available plus application actions. Region budget tab is aggregate-only.
- [ ] Replace visible 用量组 navigation with 组织管理; redirect legacy route where practical.
- [ ] Run admin tests/build and commit: `feat: 新增组织管理界面`.

---

### Task 9: Project and User UI

**Files:**

- Modify: `apps/admin/src/views/Projects.vue`, `apps/admin/src/views/ProjectDetail.vue`, `apps/admin/src/views/UserDetail.vue`, `apps/admin/src/projects.ts`
- Test: `test/admin/projects.test.ts`, `test/admin/user-detail.test.ts`

- [ ] Write failing tests: owner organization dropdown replaces raw UUID input; category filters; department label; member add/remove; owner selection; cross-department badge; user primary organization/projects; self-approval badge.
- [ ] Project list adds 类型, 所属部门, 成员, 有效 Key, 预算, 已用/可用.
- [ ] Project detail member tab supports employee select, role select, add, remove, and set owner.
- [ ] Budget tab shows 当前总额度, 申请后目标总额, 新增额度, application history, decision person, self-approval, and linked ledger.
- [ ] Platform administrator sees both 提交 and 提交并批复.
- [ ] Run admin tests/build and commit: `feat: 完善项目成员与预算界面`.

---

### Task 10: Identity and Analytics Language

**Files:**

- Modify: `apps/api/src/me-projects.service.ts`, `apps/api/src/profile.controller.ts`, `apps/api/src/analytics.service.ts`, `apps/api/src/usage-query.ts`, `apps/admin/src/views/Profile.vue`, `apps/admin/src/views/Analytics.vue`
- Test: `test/integration/me-projects.test.ts`, `test/analytics/analytics.service.test.ts`, `test/admin/profile.test.ts`

- [ ] Write failing tests: personal list includes department and business projects; responses expose owner organization; analytics dimension is organization/project; historical group data maps to legacy organization; UI no longer uses new “区域/用量组” wording.
- [ ] Keep historical `group_id` data untouched and map it to organization for display.
- [ ] Personal grouping becomes 我的组织, 我的部门预算项目, 我的业务项目.
- [ ] Run focused tests/typecheck and commit: `feat: 统一身份与分析组织视图`.

---

### Task 11: Full Verification and 0.9.0 Package

**Files:**

- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`
- Create: `docs/release-0.9.0.md`

- [ ] Set version to `0.9.0`.
- [ ] Run full `npm run verify` with explicit local PostgreSQL and Redis test URLs.
- [ ] Re-run migration rehearsal from the newest production backup.
- [ ] Build `ucli-server-runtime:0.9.0` and `ucli-server-web:0.9.0`.
- [ ] Assemble the documented offline layout, generate `RELEASE` and `SHA256SUMS`, verify all hashes, and ensure no `.env` or credentials are packaged.
- [ ] Commit/push `chore: 准备0.9.0组织项目收敛发布` and wait for verify, integration, and Docker CI jobs.

---

### Task 12: Production Upgrade and Acceptance

**Use:** `.agents/skills/deploy-ucli-company-server/SKILL.md` and its company-server reference.

- [ ] Preflight 0.8.2 health, exact release, networks, space, old image availability, and successful backup rehearsal.
- [ ] Create paired database/image/config backup and verify hashes.
- [ ] Upload and verify the 0.9.0 package, then run only `./install.sh update`.
- [ ] Verify all four containers use exact 0.9.0 image IDs; API/gateway health and both dependencies are `ok`.
- [ ] Verify organization snapshot: executive=1, functional=2, region=7, department projects=3, active duplicates=0, and all named members are in their target organizations.
- [ ] Before replacement-key issuance, resolve protocol compatibility by publishing `OPENAI_CHAT` for `deepseek-v4-flash` or switching clients to `OPENAI_RESPONSES` / `ANTHROPIC_MESSAGES`.
- [ ] Platform administrator submits and approves initial budgets for all three department projects; verify self-approval badges.
- [ ] For each legacy-key user: verify membership, issue project key, perform a small billable request, confirm project attribution, then revoke old key.
- [ ] Browser acceptance: organization list/detail, project members/owner, project keys, budget self-approval, user organization/project view, analytics dimensions.
- [ ] Record source commit, CI, migration, package/backup hashes, image IDs, organization snapshot, protocol decision, key replacement count, and browser acceptance in `docs/release-0.9.0.md`; commit and push.

## Rollback Plan

Binary-only rollback is invalid. On failure, restore the pre-upgrade database and both 0.8.2 images, retain the original `MASTER_KEY`, and verify 0.8.2 health. If failure occurs after replacement keys and department usage, prefer a forward fix because rollback also removes new project usage/budget history.

## Deferred 0.10.0 Cleanup

Do not physically rename `usage_groups` / `region_id`, drop old enums or group-budget tables, delete legacy APIs/groups/keys, or remove historical rows in 0.9.0. Wait until all active keys are project keys, all new budget submissions are project-based, organization analytics is accepted, and one full business cycle has passed.
