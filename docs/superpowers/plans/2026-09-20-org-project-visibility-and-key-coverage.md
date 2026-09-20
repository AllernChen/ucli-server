# Organization Project Visibility and Key Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make organization and project pages show budget and usage progress, let each person securely view all owned project keys in Profile, and backfill one active project key for every active organization member on every active project owned by that organization.

**Architecture:** Extend the existing 0.9.0 organization/project APIs with batched budget and usage summaries, add a web-session/self-password key reveal endpoint beside the existing administrator reveal endpoint, and add an idempotent coverage script that synchronizes project membership and keys without exposing plaintext. No database schema change is expected.

**Tech Stack:** NestJS 11, Prisma 6 / PostgreSQL, Vue 3 `<script setup>`, Vitest, existing envelope encryption and employee key services. No new dependencies.

## Global Constraints

- Release version is `0.9.1`.
- No new npm dependencies.
- No Prisma schema migration is expected unless implementation discovers a hard blocker.
- Preserve production `MASTER_KEY`; never print or copy it.
- Never print a complete employee API key in logs, test output, audit metadata, or a response summary.
- Organization budget progress is aggregated from active projects owned by the organization.
- Runtime project budget remains authoritative; organization summaries are read-only aggregates.
- Personal key reveal requires:
  - web login;
  - key ownership;
  - current account password verification;
  - `Cache-Control: no-store`;
  - audit without plaintext.
- Every newly generated key remains project-bound and recoverable through encrypted storage.
- Coverage backfill is idempotent:
  - one active key per account per project;
  - preserve existing keys and owners;
  - do not revoke or overwrite old keys;
  - discard generated plaintext in the backfill process.
- Active primary organization members are targets.
- Skip `LEGACY_PROJECT` organizations.
- Include both:
  - `BUSINESS` projects under region organizations;
  - `DEPARTMENT` budget projects under functional/executive organizations.
- Accounts without a web password cannot use Profile even if they have keys. Password bootstrap is therefore an explicit operational step.

## Verified 0.9.0 Production Baseline

- Production runs 0.9.0.
- Organization model and department budget projects are deployed.
- Department budget projects each have ¥100 initial total budget.
- Eleven department members already have department project keys.
- Active legacy unbound keys are zero.
- Current user list reports 40 accounts and all 40 report `hasPassword=false` in the organization user list.
- Therefore, ordinary employees need initial web passwords before they can log in to Profile and view their own keys.

## Target Calculation Rules

### Organization Budget Aggregate

For each organization, aggregate its active projects:

```text
projectCount
budgetProjectCount
unlimitedProjectCount
totalLimitCny
spentCny
reservedCny
occupiedCny = spentCny + reservedCny
availableCny = max(totalLimitCny - occupiedCny, 0)
usagePercent = occupiedCny / totalLimitCny
alertProjectCount
```

Rules:

- Zero-limit and unlimited projects are still counted.
- If any project is unlimited, aggregate display includes `unlimitedProjectCount`; percentage is not meaningful for that portion.
- A project is alerting when:
  - occupied ≥ limit; or
  - occupied ≥ 80% of limit.

### Organization Usage Aggregate

For each organization, aggregate usage logs whose `budget_project_id` belongs to one of its active projects over the last 30 days:

```text
requests
totalTokens = sum(inputTokens + outputTokens)
costCny = sum(costUsd)
lastUsedAt
activeAccounts
```

`costUsd` is the existing persisted procurement CNY field despite its legacy name; expose it as `costCny`.

### Project Overview Summary

For each project:

```text
budget summary
memberCount
ownerCount
owners
activeKeyCount
last30dRequests
last30dTotalTokens
last30dCostCny
lastUsedAt
```

---

### Task 1: Organization Budget Progress and Usage Summaries

**Files:**

- Modify: `apps/api/src/org-units.service.ts`
- Modify: `apps/api/src/org-units.controller.ts` if response typing requires it
- Test: `test/integration/org-units.test.ts`

**Interfaces:**

```ts
type OrganizationBudgetSummary = {
  projectCount: number
  budgetProjectCount: number
  unlimitedProjectCount: number
  totalLimitCny: string
  spentCny: string
  reservedCny: string
  occupiedCny: string
  availableCny: string
  usagePercent: number | null
  alertProjectCount: number
}

type OrganizationUsageSummary = {
  requests: number
  totalTokens: string
  costCny: string
  activeAccounts: number
  lastUsedAt: string | null
}
```

- [ ] Write failing PostgreSQL tests proving:
  - organization list returns aggregate budget progress;
  - multiple projects are summed correctly;
  - reserved and spent amounts are both included in occupied amount;
  - unlimited projects are counted but do not create a false finite percentage;
  - organization detail includes last-30-day usage;
  - one organization's projects do not leak into another organization;
  - queries remain batched rather than one request per organization.
- [ ] Implement batched project loading by organization IDs.
- [ ] Reuse `readProjectBudgets` for project budget summaries.
- [ ] Aggregate usage with one Prisma `groupBy` over `budgetProjectId`.
- [ ] Convert Decimal and BigInt values to JSON-safe strings/numbers at the service boundary.
- [ ] Add `budget` and `usage` to:
  - organization list rows;
  - organization detail;
  - each project returned by `GET /admin/org-units/:id/projects`.
- [ ] Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:5432/ucli_test'
npm test -- test/integration/org-units.test.ts
npm run typecheck
```

- [ ] Commit: `feat: 组织汇总项目预算与用量`

---

### Task 2: Organization UI Budget Progress and Overview Usage

**Files:**

- Modify: `apps/admin/src/views/OrgUnits.vue`
- Modify: `apps/admin/src/views/OrgUnitDetail.vue`
- Test: `test/admin/org-units.test.ts`

**Interfaces:**

- Consumes Task 1 API fields.

- [ ] Write failing component tests for:
  - list column `预算进度`;
  - total budget, occupied, available, and percentage;
  - `不限额` display when unlimited projects exist;
  - alert styling at ≥80%;
  - overview cards for project count, total budget, occupied, available, last-30-day requests, tokens, and cost;
  - project table columns for budget and usage.
- [ ] In `OrgUnits.vue`, add:

```text
预算进度
¥occupied / ¥total
progress bar
percentage
alert badge
```

- [ ] In `OrgUnitDetail.vue` overview, add summary cards:

```text
关联项目
项目预算合计
已用 / 预占
可用额度
近 30 天请求
近 30 天 Token
近 30 天采购成本
最后使用时间
```

- [ ] In the organization projects table, show per-project:

```text
额度
已用 / 预占 / 可用
近 30 天请求
近 30 天成本
有效 Key
```

- [ ] Run:

```powershell
npm test -- test/admin/org-units.test.ts
npm run admin:build
```

- [ ] Commit: `feat: 组织页面展示预算进度`

---

### Task 3: Project Overview Budget, Members, and Usage

**Files:**

- Modify: `apps/api/src/projects.service.ts`
- Modify: `apps/api/src/projects.controller.ts` only if a new response shape requires it
- Modify: `apps/admin/src/projects.ts`
- Modify: `apps/admin/src/views/ProjectDetail.vue`
- Test: `test/integration/projects.test.ts`
- Test: `test/admin/projects.test.ts`

**Interfaces:**

```ts
type ProjectOverviewSummary = {
  memberCount: number
  ownerCount: number
  owners: Array<{ accountId: string; displayName: string }>
  activeKeyCount: number
  usage: {
    requests: number
    totalTokens: string
    costCny: string
    lastUsedAt: string | null
  }
}
```

- [ ] Write failing API tests proving project detail includes:
  - member and owner counts;
  - owner names;
  - active key count;
  - last-30-day request/token/cost summary;
  - correct organization scoping.
- [ ] Extend `projectSelect` or the detail query with bounded relations/counts.
- [ ] Batch project usage aggregation in the detail query path.
- [ ] Write failing component tests proving Project overview shows:
  - budget total;
  - spent / reserved / available;
  - budget progress bar;
  - member count;
  - owner names;
  - active key count;
  - last-30-day requests, tokens, and cost;
  - project type and owner organization.
- [ ] Implement overview cards before the existing basic information list.
- [ ] Keep the existing budget tab for detailed application and ledger workflows.
- [ ] Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:5432/ucli_test'
npm test -- test/integration/projects.test.ts test/admin/projects.test.ts
npm run typecheck
npm run admin:build
```

- [ ] Commit: `feat: 项目概述展示预算与人员`

---

### Task 4: Personal Key List and Self-Service Plaintext Reveal

**Files:**

- Modify: `apps/api/src/employee-keys.dto.ts`
- Modify: `apps/api/src/employee-keys.service.ts`
- Modify: `apps/api/src/employee-keys.controller.ts`
- Modify: `apps/admin/src/components/EmployeeKeysPanel.vue`
- Test: `test/integration/employee-api-keys.test.ts`
- Test: `test/admin/employee-keys.test.ts`
- Test: `test/integration/employee-key-http.mjs`

**Interfaces:**

```http
GET  /api/v1/me/api-keys
POST /api/v1/me/api-keys/:id/reveal
```

```ts
export class RevealOwnEmployeeKeyDto {
  password: string
}
```

Response:

```ts
{
  id: string
  secret: string
}
```

- [ ] Write failing service tests covering:
  - owner can reveal own recoverable key with correct password;
  - wrong password returns 401;
  - another account's key returns 404;
  - device credential cannot call the endpoint;
  - revoked/disabled/deleted/expired keys return conflict or unauthorized consistently;
  - legacy non-recoverable key returns 409;
  - response header is `Cache-Control: no-store`;
  - audit action records self reveal without plaintext.
- [ ] Implement `revealOwn(actor, id, password)`.
- [ ] Require:
  - `actor.deviceId` absent;
  - `key.accountId === actor.sub`;
  - active account and membership;
  - argon2 verification of the current account password.
- [ ] Add a small in-process failure throttle:
  - maximum 5 failed password attempts per account in 5 minutes;
  - reset after success;
  - do not store the attempted password.
- [ ] Add `POST /me/api-keys/:id/reveal`.
- [ ] Keep administrator reveal endpoint unchanged.
- [ ] Write failing component tests proving own-mode Profile:
  - lists all own project keys;
  - groups or clearly labels project and organization;
  - opens key detail;
  - asks for “当前登录密码” rather than administrator password;
  - reveals and copies plaintext;
  - clears plaintext when closing the drawer;
  - shows a safe message for non-recoverable legacy keys.
- [ ] Implement the reveal drawer in `EmployeeKeysPanel.vue` using the own endpoint when `adminMode` is false.
- [ ] Run:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:5432/ucli_test'
$env:TEST_REDIS_URL='redis://127.0.0.1:6379'
npm test -- test/integration/employee-api-keys.test.ts test/admin/employee-keys.test.ts
npm run build
node --import tsx test/integration/employee-key-http.mjs
```

- [ ] Commit: `feat: 个人中心安全查看项目Key`

---

### Task 5: Organization Project Membership and Key Coverage Backfill

**Files:**

- Create: `scripts/org-project-access-coverage.mjs`
- Create: `scripts/org-project-access-coverage.d.mts`
- Modify: `Dockerfile`
- Test: `test/deploy/org-project-access-coverage.test.ts`

**Interfaces:**

```ts
export function plannedCoverage(input: {
  organizations: Array<{
    id: string
    name: string
    members: Array<{ accountId: string; displayName: string }>
    projects: Array<{ id: string; name: string }>
    existingProjectMembers: Array<{ projectId: string; accountId: string }>
    existingActiveKeys: Array<{ projectId: string; accountId: string }>
  }>
}): {
  targetRelations: number
  missingProjectMembers: number
  missingActiveKeys: number
  alreadyCoveredRelations: number
  byOrganization: Array<{
    organizationId: string
    organizationName: string
    missingProjectMembers: number
    missingActiveKeys: number
  }>
}
```

CLI:

```text
node scripts/org-project-access-coverage.mjs --dry-run
node scripts/org-project-access-coverage.mjs --apply
```

- [ ] Write failing unit tests for `plannedCoverage`, including:
  - all members × all active projects;
  - existing project members preserved;
  - existing active keys preserved;
  - no target for legacy organizations;
  - one missing key per missing account/project relation;
  - idempotent second run returns zero missing.
- [ ] Implement a read/write Prisma script with explicit `--apply`; default is dry-run.
- [ ] Target active organizations whose `orgType` is:
  - `REGION`;
  - `FUNCTIONAL`;
  - `EXECUTIVE`.
- [ ] Target active projects whose `category` is:
  - `BUSINESS`;
  - `DEPARTMENT`.
- [ ] Target active primary organization members.
- [ ] For each missing relation:
  - upsert `ProjectMember.role=CONTRIBUTOR`;
  - preserve any existing `OWNER` role.
- [ ] For each account/project without an active key:
  - generate `ucli_sk_...`;
  - store hash, hint, and recoverable ciphertext;
  - write create audit;
  - discard plaintext immediately.
- [ ] Key name:

```text
${organizationName}-${projectName}-${accountDisplayName}
```

- [ ] Output counts and org/project names only; never output plaintext.
- [ ] Add the script to the runtime image:

```dockerfile
COPY --from=build /app/scripts ./scripts
```

- [ ] Run against an isolated 0.9.0 production backup:

```powershell
$env:DATABASE_URL='postgresql://postgres@127.0.0.1:5432/ucli_org_coverage_rehearsal'
$env:MASTER_KEY='<local-rehearsal-master-key>'
node scripts/org-project-access-coverage.mjs --dry-run
node scripts/org-project-access-coverage.mjs --apply
node scripts/org-project-access-coverage.mjs --dry-run
```

Expected second dry-run:

```text
missingProjectMembers=0
missingActiveKeys=0
```

- [ ] Commit: `feat: 补齐组织项目成员Key覆盖`

---

### Task 6: Web Password Bootstrap Decision and Safe Distribution

**Files:**

- Create or modify a script only if this task is explicitly approved for execution.
- Test: only if a script is implemented.

Current fact:

```text
40/40 listed organization accounts have hasPassword=false
```

Without passwords, employees cannot log in to Profile even after key coverage is complete.

Recommended approach:

- [ ] Generate a random initial password for each active account without `passwordHash`.
- [ ] Hash with argon2.
- [ ] Set:

```text
passwordHash = generated hash
pendingCredentialChange = true
tokenVersion += 1
```

- [ ] Force first-login credential update using the existing 0.7.1 flow.
- [ ] Write a local one-time distribution CSV:

```text
displayName,email,initialPassword
```

- [ ] Protect the file with restrictive local permissions.
- [ ] Do not commit it.
- [ ] Do not print values in logs.
- [ ] Delete or move to offline secure storage after distribution.
- [ ] Record counts only in release documentation.

Boundary:

This task creates user credentials and must be explicitly confirmed before production execution. It is not required for issuing project keys, but it is required for employees to use Profile to view those keys.

---

### Task 7: Full Verification and 0.9.1 Release

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Create: `docs/release-0.9.1.md`

- [ ] Set version to `0.9.1`.
- [ ] Run full local gate:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:5432/ucli_test'
$env:TEST_REDIS_URL='redis://127.0.0.1:6379'
npm run verify
```

- [ ] Run organization coverage rehearsal from the newest production backup.
- [ ] Build:

```powershell
docker build --target runtime -t ucli-server-runtime:0.9.1 .
docker build --target admin -t ucli-server-web:0.9.1 .
```

- [ ] Assemble offline package with `RELEASE` and `SHA256SUMS`.
- [ ] Confirm package contains no `.env`, credentials, private keys, or database backups.
- [ ] Commit and push.
- [ ] Wait for:
  - verify;
  - group-integration;
  - docker-build.

---

### Task 8: Production Upgrade and Coverage Application

**Use:** `.agents/skills/deploy-ucli-company-server/SKILL.md`.

- [ ] Preflight 0.9.0 health and exact release.
- [ ] Create paired database and 0.9.0 image backup.
- [ ] Upload and verify the 0.9.1 offline package.
- [ ] Run only:

```sh
./install.sh update
```

- [ ] Verify:
  - API health;
  - Gateway health;
  - PostgreSQL / Redis;
  - four application containers;
  - exact image IDs.
- [ ] Run coverage dry-run in the API container:

```sh
docker exec ucli-server-api node scripts/org-project-access-coverage.mjs --dry-run
```

- [ ] Review missing relation/key counts.
- [ ] Apply:

```sh
docker exec ucli-server-api node scripts/org-project-access-coverage.mjs --apply
```

- [ ] Run dry-run again and require:

```text
missingProjectMembers=0
missingActiveKeys=0
```

- [ ] If Task 6 is approved, execute password bootstrap and securely distribute initial passwords.
- [ ] Browser acceptance:
  - organization list budget progress;
  - organization overview usage;
  - project overview budget/member/key cards;
  - Profile own key list;
  - own password-protected reveal and copy;
  - first-login forced credential update where applicable.
- [ ] Update release documentation and push final deployment record.

## Rollback

0.9.1 expects no schema migration, but coverage application changes project members and creates keys.

Preferred failure recovery:

1. keep 0.9.1 containers healthy;
2. do not revoke newly created keys;
3. fix forward.

If a full rollback is required:

1. restore the pre-0.9.1 database backup;
2. restore 0.9.0 runtime and web images;
3. preserve the original `MASTER_KEY`;
4. verify health.
