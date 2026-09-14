# 用量组、员工 API Key 与网关预算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 在当前任务内顺序执行，不自动派发子代理。

**Goal:** 员工持有固定归属用量组的 API Key，即可从兼容 AI CLI 调用有权使用的模型；公司统一按实际人民币采购成本控制组预算并追踪员工使用。

**Architecture:** 复用组织、用户、设备授权、现有模型路由与分时采购成本。增加用量组及员工凭据，通过统一网关身份和目录服务执行权限交集；PostgreSQL 记录组预算预占与结算，Redis 保留现有速率及 token 配额。所有新增功能在本仓库实现，UCLI 客户端依合同另行验收。

**Tech Stack:** TypeScript、NestJS、Prisma/PostgreSQL、Redis、decimal.js、Vue 3、Vitest；使用当前 package.json 中已有依赖。

**Spec:** `docs/superpowers/specs/2026-09-14-group-model-access-budget-design.md`

## Global Constraints

- 平台面向公司内部，按人民币采购成本管理，不计算员工销售价格。
- 员工可以加入多个组，一个组可以有多名员工。
- 平台签发员工 API Key；每个 Key 固定属于一个员工和一个组。
- 公司采购的渠道密钥始终由服务端保管。
- 一期使用现有 PostgreSQL、Redis 和应用部署，不新增服务或依赖。
- 0 表示不能使用；不限额必须显式选择，不能把空值或零隐含解释为不限额。
- 金额控制完成前，新的 Key 入口只在测试环境启用，不提前开放生产有限预算场景。
- `projectId` 是不可信客户端上下文，不能作为预算或权限归属；新字段统一用 `groupId`。
- 员工 API Key 仅用于网关，不能调用管理 API 或获取网页登录会话。
- 各 HTTP 入口都必须使用共享权限与身份逻辑，包括 client/bootstrap。
- 不加入新协议转换器；Gemini 仅保留当前 Chat 文本转换能力。
- 不触碰 `.agents/` 及 `docs/superpowers/specs/2026-09-03-protocol-converter-design.md` 等既有未跟踪工作。
- 本计划的发布步骤是未来发布指引；执行开发不自动触发服务器部署、组织强制迁移或上游付费测试。

## 阶段和代码边界

| 阶段 | 任务 | 可验收产出 |
| --- | --- | --- |
| 一 | 1–3 | 数据约束、组/成员/模型管理、共享权限判断 |
| 二 | 4–5 | 员工 Key 生命周期、设备/Key 身份统一、双目录与 CLI 接入合同 |
| 三 | 6–7 | 人民币预算原子预占、幂等结算、故障恢复与路由计费 |
| 四 | 8–10 | 管理端与个人页、使用统计、设备迁移及端到端验收 |

### 执行记录（2026-09-14）

- 阶段一（Tasks 1–3）已实现于 `codex/group-access`，工作目录 `.worktrees/group-access`；未合并、未部署、未连接公司数据库。
- 增加组/成员/模型管理 API、永久撤销、组内模型权限交集、共享 bootstrap/网关目录，以及后续 Key/预算所需数据约束。管理员仍使用现有组织身份，设备 groupId 每次从数据库读取，不采信 JWT 附带组字段。
- 金额字段只是存储基础：本阶段不签发员工 API Key、不执行组预算扣费、不开放设备分组迁移 UI。下一步 Tasks 4–5；预算完成前不得开放新的生产 Key 入口。
- 最小实现调整：`ModelCatalogService.assertAllowed` 接收网关已读取的模型，避免重复查询价格与协议数据；组成员校验返回带模型白名单的组记录。管理端没有既有“组权限预览”入口，本阶段不增加新页面。
- 批量成员撤销沿用已有 link → grant 锁序；发现并发创建新链接或数据库死锁时回滚重试，最终凭据撤销和审计在同一事务。分组凭据签发尚未开放，后续签发必须先取得 `lockUsageGroup` 再校验成员。
- 真实数据库用例位于 `test/integration`；编译后的 HTTP 验证：`npm run build` 后执行 `node --import tsx test/integration/group-http.mjs`。两者均要求显式、仅本地 `ucli_test*` 的 `TEST_DATABASE_URL`；CI 已增加专用 PostgreSQL job。
- 基线问题：设备授权测试含已过期的固定日期，已固定该用例时钟。Docker 的 nginx 健康测试仍因无法拉取 `node:24-alpine` 被阻断，不记为通过；Compose 配置测试单独复测通过。
- 验证命令：`npm run typecheck`、`npm run build`、`npm run admin:build`、`npm run licenses:check`；带测试库运行 `npx vitest run --coverage --exclude test/deploy/nginx-health-route.test.ts --maxWorkers=4`。精确结果以本阶段最终交付消息为准。
- 最终本地结果：91 个测试文件、600 项测试通过，覆盖范围内行覆盖率 94.60%；编译产物 HTTP 验证通过。先用旧客户端写入设备用量日志、再应用新迁移，确认日志、设备归属和人民币 8 位精度保留。
- Prisma 全库比对仍提示原有渠道表两条外键和采购规则一条索引的命名差异（早期表重命名/名称截断），本次未修改这些对象；新增组结构已在真实数据库验证。部署 nginx 用例单独复测仍受 Docker Hub 鉴权连接超时阻断。

### 第二阶段执行记录（2026-09-14）

- Tasks 4–5 已实现：员工 Key 创建、列表、编辑、停启、永久撤销/软删除及个人查询/撤销；网关使用专用认证，设备与 Key 的身份分开构建。控制面仍只接受 JWT，个人 Key 接口拒绝设备 JWT。
- Key 创建/生命周期操作先锁组，与成员移除采用相同顺序；只返回创建时明文，列表和审计不包含明文或摘要。请求每次检查账号、组织、成员、组和 Key 状态。
- 两个模型目录共享权限判断；Anthropic 目录按 Messages 过滤，直接响应 limit 参数，不重定向。调用日志从可信身份填入 Key/设备/组字段；只向上游透传 Anthropic version/beta，认证信息使用采购渠道密钥。
- `EMPLOYEE_API_KEYS_ENABLED` 默认 false，已写入示例环境和 Compose 传参；仅在隔离自动测试内启用。尚未实现组预算、管理 UI 或生产迁移，不得据此打开生产入口。
- 本地模拟上游的编译产物 HTTP 测试新增 `test/integration/employee-key-http.mjs`，已加入 CI 专用集成 job；覆盖三个协议、Chat 流式、日志 CNY 成本/归属、默认关闭、控制面隔离与撤销。
- 外部 CLI 配置依据已再次核对官方文档，见 `docs/employee-api-access.md`；真实 Claude Code/OpenCode 客户端和付费渠道未实测。
- 最终验证：93 个测试文件、616 项测试通过，覆盖范围内行覆盖率 94.42%；类型检查、服务端构建、管理端构建、许可证检查及两套编译产物 HTTP 测试均通过。沿用上阶段排除的 nginx Docker 健康测试（镜像拉取受阻），不计为通过；管理端现有 Analytics 大包告警未处理。
- 最终交付继续保留在 `codex/group-access`，不自动合并、推送或部署。下一阶段从 Tasks 6–7（组预算与请求生命周期结算）继续。

### 第三阶段执行记录（2026-09-14）

- Tasks 6–7 的预算核心和网关接入已实现于 `codex/group-access`，沿用现有迁移结构，无新增数据库迁移、依赖或生产服务变更。
- 新增组预算查询、配置、当前/默认额度调整、分页账目及人工对账 API。CNY 保留八位精度；同组统一行锁序，日志和预算同事务，operationId/requestId 幂等，人工终态优先。多路由校正要求显式分摊，更新日志、路由成本和组汇总并保留原值审计。
- 网关复用既有身份、模型权限、候选路由和价格解析；有组请求由 `apps/gateway/src/group-request.ts` 管理持久生命周期，无组设备保持旧路径。所有新 Key 默认关闭，不开放公司服务器。
- 输出上限实际写入三种协议的请求，预占考虑缓存和推理的较高费率。组请求一期只放行可估价文本/函数工具；不限额不额外开放未支持计费类型。Responses 的缓存/推理 usage 映射已补齐，未定价缓存写入保留待核对。
- 路由重试发送前持久记录意图；可能计费时追加预占。已知多路由费用合计入账，未知费用继续占额，缺终止事件或客户端取消不当作免费。PG 结算失败重试一次，仍失败保留预占供恢复/人工核对。
- Redis 增加请求/策略级幂等标记、恢复快照及有版本的人工成本校正。先 PG 提交再同步 Redis，Worker 每分钟重试；孤立未发送预占释放，已发送的转待核对。并发槽位与未确认费用分别释放，标记扫描采用有界 SCAN（高量时改索引）。
- 新增真实 PG 并发/回滚/月界/微额/人工校正测试，真实 Redis 重放/孤立恢复/校正测试，模拟上游正常/流式/中断/重试多次计费/数据库故障测试；HTTP 验证包含零预算拒绝和管理参数/组织隔离。CI 专用集成 job 增加 Redis。
- 已单独复测 nginx Docker 健康测试，仍因 Docker Hub 的 `node:24-alpine` 鉴权连接超时阻断，不记为通过。最终验证结果见下方交付记录；未做真实 CLI 或付费渠道测试。
- CI verify 任务也已配置专用 PG/Redis 并执行迁移；无测试库时账本测试会跳过且覆盖率不足，不能当作完整验证。未降低覆盖率阈值或排除新增领域代码。
- 最终本地验证：97 个测试文件、634 项测试通过，覆盖范围内行覆盖率 95.19%；类型检查、服务端/管理端构建、许可证检查、两套编译产物 HTTP 测试和 Worker 编译产物依赖注入/关闭检查通过。恢复测试注入的单条 Redis 故障不会阻断其他账目；测试中的故障告警为预期结果。保留原有 Analytics 大包告警和上述 Docker 用例阻断。
- 开发留在现有 worktree，不合并、推送或部署。第四阶段 Tasks 8–10（管理 UI、统计对账、设备迁移及最终验收）尚未开始。

下方保留原始任务细分与目标提交方式；完成状态以上方各阶段执行记录为准。

新服务沿用 `apps/api/src/*.{service,controller,dto}.ts`，不引入一层通用 Repository。只有 API、网关、Worker 共同使用的领域代码放入 packages。

| 文件 | 职责 |
| --- | --- |
| `packages/security/src/gateway-auth.ts` | 网关专用认证，区分设备 JWT 与员工 API Key |
| `packages/security/src/group-access.ts` | 组织内的有效组与成员校验；管理员签发和网关共用 |
| `packages/gateway-core/src/model-catalog.service.ts` | bootstrap 和网关目录的共享查询、模型权限与协议过滤 |
| `packages/quota/src/group-budget.ts` | 金额校验、周期标识和可用额度纯逻辑 |
| `packages/quota/src/group-budget.service.ts` | PostgreSQL 原子预算、预占、结算与恢复 |
| `apps/api/src/usage-groups.*.ts` | 组、成员、模型白名单与预算管理 API |
| `apps/api/src/employee-keys.*.ts` | 员工 Key 管理 API，明文只返回创建调用 |
| `apps/admin/src/views/UsageGroups.vue`、`UsageGroupDetail.vue` | 组列表、详情及预算配置 |
| `apps/admin/src/components/EmployeeKeysPanel.vue` | 用户详情与个人页复用的 Key 列表及生命周期操作 |
| `apps/admin/src/views/MyAccess.vue` | 已有网页登录员工的接入说明、自己的 Key 和用量 |

## Task 1: 向前兼容的数据结构和约束

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/202609140001_group_access_budget/migration.sql`
- Create: `test/groups/group-schema.test.ts`
- Create: `test/integration/group-storage.test.ts`
- Create: `test/integration/database.ts`
- Modify: `.github/workflows/ci.yml`

**数据字段合同：**

| 对象 | 新字段或约束 |
| --- | --- |
| Organization | `requireDeviceGroup Boolean @default(false)` |
| UsageGroup | id、organizationId、name、type(DEPARTMENT/PROJECT)、enabled、archivedAt、description、budgetMode(TOTAL/MONTHLY)、budgetTimezone、unlimited、defaultLimitCny Decimal(20,8)、createdAt、updatedAt |
| GroupMember | organizationId、groupId、accountId、joinedAt、removedAt；(groupId,accountId) 唯一，移除保留记录 |
| GroupModelAccess | organizationId、groupId、publicModelId；(groupId,publicModelId) 唯一 |
| EmployeeApiKey | id、organizationId、groupId、accountId、name、secretHash 唯一、secretHint、createdById、createdAt、expiresAt、disabledAt、revokedAt、deletedAt、lastUsedAt |
| GroupBudgetPeriod | id、organizationId、groupId、periodKey、timezone、unlimited、limitCny、spentCny、reservedCny、alertedThreshold；(groupId,periodKey) 唯一 |
| GroupBudgetEntry | id、organizationId、groupId、periodId、requestId 可空、operationId 唯一、kind(REQUEST/LIMIT_ADJUSTMENT/COST_ADJUSTMENT)、status、accountId、credentialType、credentialId、reservedCny、settledCny、startedAt、updatedAt、dispatchedAt、leaseUntil、snapshot JSON、reason、actorAccountId |
| DeviceGrant | groupId 可空，旧行不强制回填 |
| UsageLog | groupId、apiKeyId、credentialType 默认 DEVICE、actorSnapshot JSON；deviceId 改为可空 |
| RouteAttempt | costCny Decimal(20,8) 可空、usageSnapshot JSON 可空、billingState(CONFIRMED/ESTIMATED/UNKNOWN/NO_CHARGE) 可空 |

`GroupBudgetEntry.status`：RESERVED、SETTLED、RELEASED、RECONCILIATION_REQUIRED。只有 REQUEST 行允许 requestId，并以部分唯一索引保证同一 requestId 一个预算请求记录；operationId 用于调整操作重试去重。金额非负约束针对限额、已用和预占，COST_ADJUSTMENT 的变化量放 snapshot，调整后汇总不得负数。

跨组织关系使用复合外键，例如组的 `(id,organizationId)` 和成员的 `(organizationId,accountId)` 引用既有 Membership。员工 Key 引用同组织的组和员工；groupId/accountId 后续不允许更新。审计、预算及日志关联使用 RESTRICT，不做级联删除。UsageLog 约束为 DEVICE 必须有 deviceId 且无 apiKeyId，API_KEY 必须有 apiKeyId、groupId 且无 deviceId。

- [ ] 写失败测试，检查旧设备日志可保留、跨组织 Key 拒绝、同 requestId 预算记录不重复。集成用例通过 `test/integration/database.ts` 提供 `withTestDatabase(run: (db: PrismaClient) => Promise<void>): Promise<void>`：只允许环境变量 `TEST_DATABASE_URL`，数据库名称必须以 `ucli_test` 开头；不读取生产 `.env`，不自动 DROP/RESET 数据库。每个测试用随机组织和 id，测试库可由 CI PostgreSQL 服务整体回收。

```ts
it('keeps device history while adding API key attribution', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  expect(schema).toContain('model EmployeeApiKey')
  expect(schema).toContain('model GroupBudgetEntry')
  expect(schema).toMatch(/requireDeviceGroup\s+Boolean\s+@default\(false\)/)
})
```

- [ ] 运行 `npm test -- test/groups/group-schema.test.ts`，确认新增模型/约束尚不存在时失败。
- [ ] 写 Prisma 模型与新增 SQL。核心日志约束形态如下，迁移不删除旧行：

```sql
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_credential_shape" CHECK (
  ("credential_type" = 'DEVICE' AND "device_id" IS NOT NULL AND "api_key_id" IS NULL)
  OR ("credential_type" = 'API_KEY' AND "device_id" IS NULL AND "api_key_id" IS NOT NULL AND "group_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "group_budget_request_once"
ON "group_budget_entries" ("request_id") WHERE "kind" = 'REQUEST';
```

- [ ] 在隔离测试库顺序部署全部迁移；运行 `npm run db:generate`、`npm run typecheck`、存储约束集成测试。CI 增加 PostgreSQL 服务及 `TEST_DATABASE_URL`，仅集成 job 配置测试库；不能用 mock 验证并发约束。
- [ ] 仅提交本任务文件，commit：`feat: add group access and budget storage`。

## Task 2: 用量组管理与成员撤销

**Files:**
- Create: `apps/api/src/usage-groups.dto.ts`
- Create: `apps/api/src/usage-groups.service.ts`
- Create: `apps/api/src/usage-groups.controller.ts`
- Create: `packages/security/src/group-access.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/device-grants.service.ts`
- Create: `test/groups/usage-groups.test.ts`

**Interfaces:**

```ts
type GroupIdentity = { organizationId: string; accountId: string; groupId: string }
// 位于 group-access.ts；在给定事务/PrismaService 上校验。
assertActiveGroupMember(db: Prisma.TransactionClient, identity: GroupIdentity): Promise<void>
// 位于 usage-groups.service.ts；actor 包含已验证的组织和管理员身份。
removeMember(actor: AuthPrincipal, groupId: string, accountId: string): Promise<void>
replaceModels(actor: AuthPrincipal, groupId: string, publicModelIds: string[]): Promise<void>
```

API 前缀 `/api/v1/admin/usage-groups`。支持 GET/POST、GET/PATCH/DELETE `:id`、POST `:id/enable|disable`、GET/POST `:id/members`、DELETE `:id/members/:accountId`、GET/PUT `:id/models`。DELETE 组做归档并阻止再次启用。列表支持 q、type、status、offset、limit（1–200）。名称 1–120、说明最多 2000，UUID/枚举/重复模型 ID 在 DTO 边界验证。模型白名单可引用平台可维护模型，但详情必须展示禁用/未发布造成的实际不可用。

- [ ] 写失败用例：跨组织成员拒绝；移出组后 Key 永久撤销、设备授权和未兑换链接不可复活；空模型允许清单合法但没有调用权限。

```ts
it('requires explicit active group membership', async () => {
  const db = { groupMember: { findFirst: vi.fn().mockResolvedValue(null) } }
  await expect(assertActiveGroupMember(db as any, {
    organizationId: 'org-a', accountId: 'employee-a', groupId: 'group-b'
  })).rejects.toMatchObject({ status: 403 })
})
```

- [ ] 执行 `npm test -- test/groups/usage-groups.test.ts` 确认失败。
- [ ] 所有写操作在组织范围内；移出组在同一事务锁住组/成员，再设置 removedAt、撤销 EmployeeApiKey、删除或撤销 DeviceGrant 与活动 DeviceGrantLink，清除其 secretEncrypted，撤销 Device。复用设备服务已有生命周期代码，先列出所有 grant/link 锁调用者，统一锁顺序，避免批量移除和兑换死锁。

```ts
await transaction.employeeApiKey.updateMany({
  where: { organizationId, groupId, accountId, revokedAt: null },
  data: { revokedAt: now }
})
```

- [ ] 重加成员仅清除 removedAt 并更新 joinedAt；不会清除旧凭据 revokedAt。签发 Key/设备授权与成员移除采用同一组/成员锁顺序，防止移除时并发签发漏撤销。
- [ ] 执行上述测试及 `test/auth/device-grant-link-lifecycle.test.ts`、`test/auth/device-grant-lifecycle.test.ts`；提交 `feat: manage usage groups and membership lifecycle`。

## Task 3: 统一模型目录和权限交集

**Files:**
- Modify: `packages/gateway-core/src/access-policy.ts`
- Create: `packages/gateway-core/src/model-catalog.service.ts`
- Modify: `apps/gateway/src/gateway.service.ts`
- Modify: `apps/api/src/client.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/gateway/src/app.module.ts`
- Modify: `test/gateway/access-policy.test.ts`
- Modify: `test/gateway/gateway.service.test.ts`
- Create: `test/gateway/model-catalog.test.ts`

**Interfaces:**

```ts
type CatalogIdentity = ModelAccessPrincipal & { groupId: string | null }
type CatalogModel = { id: string; displayName: string; contextSize: number; protocols: GatewayProtocol[] }
canAccessGroupModel(modelId: string, groupModels: readonly string[] | null): boolean
ModelCatalogService.list(identity: CatalogIdentity, protocol?: GatewayProtocol): Promise<CatalogModel[]>
ModelCatalogService.assertAllowed(identity: CatalogIdentity, modelId: string, protocol: GatewayProtocol): Promise<void>
```

`groupModels === null` 只用于迁移期经过认证的未分组设备；有组但没有模型时传空数组。groupId 只从服务端身份取得。管理端模型权限预览也调用同一模型判断。

- [ ] 在已有权限测试补充新组空白名单与不相关组规则：

```ts
it('does not borrow another group model grant', () => {
  expect(canAccessGroupModel('model-b', ['model-a'])).toBe(false)
  expect(canAccessGroupModel('model-a', [])).toBe(false)
  expect(canAccessGroupModel('model-a', ['model-a'])).toBe(true)
})
```

- [ ] 执行 `npm test -- test/gateway/access-policy.test.ts test/gateway/model-catalog.test.ts` 确认失败。
- [ ] 在共享代码实现白名单并与 `canAccessModel` 做 AND，不修改旧 policy OR 语义：

```ts
export function canAccessGroupModel(id: string, allowed: readonly string[] | null): boolean {
  return allowed === null || allowed.includes(id)
}
```

- [ ] 抽取当前 bootstrap 与 GatewayService.models 的重复数据库查询到 ModelCatalogService；调用权限使用相同逻辑，列表按 id 稳定排序。返回静态 protocols，健康/熔断变化不改变协议声明。按协议过滤发生在服务端，不由客户端自行扩大范围。
- [ ] 测试 bootstrap 与目录一致、无组兼容、预算为零仍可查目录、未授权直接请求被拒绝；运行 `npm run typecheck`，提交 `feat: share group-aware model catalog and authorization`。

## Task 4: 员工 API Key 与网关认证

**Files:**
- Create: `apps/api/src/employee-keys.dto.ts`
- Create: `apps/api/src/employee-keys.service.ts`
- Create: `apps/api/src/employee-keys.controller.ts`
- Create: `packages/security/src/gateway-auth.ts`
- Modify: `packages/security/src/auth.ts`（仅抽取可复用的 JWT 状态校验，不让管理 AuthGuard 接受 API Key）
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/gateway/src/app.module.ts`
- Modify: `apps/gateway/src/gateway.controller.ts`
- Modify: `apps/gateway/src/gateway.service.ts`
- Create: `test/auth/employee-api-keys.test.ts`
- Create: `test/auth/gateway-auth.test.ts`

**Interfaces:**

```ts
type GatewayIdentity = {
  sub: string; organizationId: string; role: AuthPrincipal['role']; groupId: string | null
} & (
  { credentialType: 'DEVICE'; deviceId: string; apiKeyId?: never }
  | { credentialType: 'API_KEY'; apiKeyId: string; deviceId?: never }
)
extractGatewayCredential(headers: Record<string, string | string[] | undefined>): string
EmployeeKeysService.create(actor: AuthPrincipal, accountId: string,
  input: { name: string; groupId: string; expiresAt: string | null }): Promise<{ id: string; secret: string; secretHint: string }>
GatewayAuthGuard.canActivate(context: ExecutionContext): Promise<boolean>
```

API：GET/POST `/api/v1/admin/users/:accountId/api-keys`；PATCH/DELETE `/api/v1/admin/employee-api-keys/:id`；POST `:id/enable|disable|revoke`；GET `/api/v1/me/api-keys`；POST `/api/v1/me/api-keys/:id/revoke`。me 路径只接受现有网页登录 JWT（非设备、非 API Key）。新增创建响应和目录响应均 no-store。请求名长 1–120、expiresAt 为 null 或未来时间；员工和组不可 PATCH。

- [ ] 写失败测试：相同双头允许、不同双头拒绝，API Key 无法访问管理接口，账号/组织/成员/组/凭据任一失效均阻止请求。Key 原文/摘要不得出现在列表与审计。

```ts
it('rejects conflicting credentials instead of picking one', () => {
  expect(() => extractGatewayCredential({
    authorization: 'Bearer ucli_sk_a', 'x-api-key': 'ucli_sk_b'
  })).toThrow()
  expect(extractGatewayCredential({
    authorization: 'Bearer ucli_sk_a', 'x-api-key': 'ucli_sk_a'
  })).toBe('ucli_sk_a')
})
```

- [ ] 执行 `npm test -- test/auth/employee-api-keys.test.ts test/auth/gateway-auth.test.ts` 确认失败。
- [ ] 复用 tokens.ts 的随机值和 hash，不引入新密钥加密方案：

```ts
const secret = `ucli_sk_${createOpaqueToken()}`
const stored = { secretHash: hashOpaqueToken(secret), secretHint: opaqueTokenHint(secret) }
```

- [ ] GatewayAuthGuard 通过明确前缀区分 API Key 与 JWT；不允许未知失败凭据退回匿名模式。设备身份保留原有授权、tokenVersion、成员角色检查；API Key 身份每次从数据库加载角色与状态，不信任调用头里的 groupId。当前未分组设备只在组织未强制迁移时放行。
- [ ] GatewayController 换用专用 guard，并以 credentialType 替代四个 deviceId 硬检查；GatewayService 所有日志写入统一从身份选取 deviceId/apiKeyId/groupId。新增环境开关 `EMPLOYEE_API_KEYS_ENABLED` 默认 false；Key 正式请求放开依赖 Task 7 预算完成。
- [ ] 跑上述测试和 `test/auth/device-grant-auth-matrix.test.ts`、`test/gateway/gateway.controller.test.ts`；提交 `feat: issue scoped employee API keys for gateway access`。

## Task 5: Anthropic 模型发现与 CLI 合同

**Files:**
- Modify: `apps/gateway/src/gateway.controller.ts`
- Modify: `apps/gateway/src/gateway.service.ts`
- Modify: `packages/gateway-core/src/relay.ts`
- Modify: `test/gateway/gateway.controller.test.ts`
- Modify: `test/gateway/relay.test.ts`
- Create: `docs/employee-api-access.md`
- Modify: `docs/ucli-client-protocol.md`
- Modify: `docs/ucli-client-model-protocol-upgrade.md`

**Interfaces:**

```ts
GatewayController.anthropicModels(request: { principal: GatewayIdentity }): Promise<{
  data: Array<{ id: string; display_name: string }>
}>
```

- [ ] 用两个模型准备控制器测试，模拟同组分别具备 Chat 和 Messages 能力；验证 Anthropic 目录只包含 Messages，并向目录服务传入可信组身份与 `anthropic_messages`。

```ts
it('forwards Anthropic beta features with their request bodies', async () => {
  // 加入现有 describe('upstream relay')，复用其中的 cost 快照。
  let captured: Record<string, string> = {}
  const fetcher = async (_url: URL | RequestInfo, init?: RequestInit) => {
    captured = init?.headers as Record<string, string>
    return new Response('{"usage":{"input_tokens":1,"output_tokens":1}}', { status: 200 })
  }
  const headers = { 'anthropic-beta': 'test-beta', 'anthropic-version': '2023-06-01' }
  await relayRequest({
    candidates: [{ channelId: 'c', channelModelId: 'cm', keyId: 'k',
      baseUrl: 'https://up.example', upstreamModel: 'claude-test',
      apiKey: 'upstream-secret', protocol: 'anthropic_messages', maxRetries: 0, timeoutMs: 1000, cost }],
    body: { model: 'public', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
    incomingHeaders: headers, fetcher: fetcher as typeof fetch
  })
  expect(captured).toMatchObject({ ...headers, 'x-api-key': 'upstream-secret' })
  expect(captured.authorization).toBeUndefined()
})
```

- [ ] 运行 `npm test -- test/gateway/gateway.controller.test.ts test/gateway/relay.test.ts`，验证当前缺少 anthropic-beta 透传时失败。
- [ ] 新增 `@Get('anthropic/v1/models')`，对目录设置 `@Header('Cache-Control', 'no-store')`。允许 `?limit=1000`，一次返回完整过滤后清单；不向供应商发模型发现请求，不重定向，不新增公共健康信息泄露渠道细节。
- [ ] GatewayService 到 relayRequest 只新增 anthropic-beta 允许透传；仍由服务端写上游供应商认证头，绝不把员工 Key 传给上游。

```ts
if (candidate.protocol === 'anthropic_messages' && incomingHeaders?.['anthropic-beta']) {
  headers['anthropic-beta'] = incomingHeaders['anthropic-beta']
}
```

- [ ] 接入文档给出 OpenAI Base URL `/gateway/v1` 和 Anthropic Base URL `/gateway/anthropic`；两者使用同一员工 Key。Claude Code discovery 开关、ID 筛选和 OpenCode 自定义 provider 清单的版本依据链接到设计第 7 节；用环境变量占位，不写真实 Key。明示 Chat/Responses/Messages 不自动互转，工具能力以实际测试为准。
- [ ] 使用本地 mock 上游测试目录隔离与 headers；提交 `feat: add protocol-filtered gateway discovery for AI CLIs`。

## Task 6: 持久化组预算核心

**Files:**
- Create: `packages/quota/src/group-budget.ts`
- Create: `packages/quota/src/group-budget.service.ts`
- Create: `test/quota/group-budget.test.ts`
- Create: `test/integration/group-budget.test.ts`
- Modify: `apps/api/src/usage-groups.dto.ts`
- Modify: `apps/api/src/usage-groups.service.ts`
- Modify: `apps/api/src/usage-groups.controller.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**

```ts
budgetPeriodKey(mode: 'TOTAL' | 'MONTHLY', timezone: string, at: Date): string
availableCny(limit: string, spent: string, reserved: string): string
type BudgetReservation = { id: string; requestId: string; periodId: string; groupId: string; reservedCny: string }
GroupBudgetService.reserve(input: {
  requestId: string; identity: GatewayIdentity & { groupId: string };
  startedAt: Date; estimateCny: string; snapshot: Prisma.InputJsonObject
}): Promise<BudgetReservation>
GroupBudgetService.settle(reservation: BudgetReservation, input: {
  actualCny: string; usage: Prisma.UsageLogUncheckedCreateInput
}): Promise<{ exceeded: boolean }>
GroupBudgetService.release(reservation: BudgetReservation, reason: string): Promise<void>
GroupBudgetService.markDispatched(reservation: BudgetReservation, leaseUntil: Date): Promise<void>
GroupBudgetService.markUncertain(reservation: BudgetReservation, reason: string): Promise<void>
GroupBudgetService.extend(reservation: BudgetReservation, additionalCny: string,
  attemptSnapshot: Prisma.InputJsonObject): Promise<BudgetReservation>
GroupBudgetService.recoverExpired(now: Date): Promise<{ released: number; uncertain: number }>
```

金额全程 Decimal/string，不经 Number。`periodKey=TOTAL` 或使用 `Intl.DateTimeFormat(...,{timeZone,year:'numeric',month:'2-digit'}).formatToParts()` 拼出的 `YYYY-MM`，无需新时区库。period 行首次创建从组默认额度快照，用唯一键处理并发创建。请求按开始周期结算，结算不再次按当前时间选周期。

- [ ] 写失败纯逻辑用例：

```ts
it('uses Shanghai month boundaries and retains small costs', () => {
  expect(budgetPeriodKey('MONTHLY', 'Asia/Shanghai', new Date('2026-09-30T16:00:00Z'))).toBe('2026-10')
  expect(availableCny('0.00000003', '0.00000001', '0.00000001')).toBe('0.00000001')
})
```

- [ ] 执行 `npm test -- test/quota/group-budget.test.ts` 确认失败；增加真实 PostgreSQL 并发测试：额度 1 元，同时预占两笔 0.75 元，只有一笔成功。用 Task 1 的 withTestDatabase，事务隔离不能由内存 mock 替代。
- [ ] 实现 availableCny 和周期函数；事务先锁组再锁周期、请求条目，所有预算修改采用相同顺序。预占检查式为 `unlimited OR spent_cny + reserved_cny + estimate <= limit_cny`；增加汇总和创建 REQUEST 条目同一事务。

```ts
return new Decimal(limit).minus(spent).minus(reserved).toFixed(8)
```

- [ ] settle 在事务中锁请求记录；SETTLED 直接返回原结果，重复内容不一致返回冲突。更新 spent/reserved、写 usageLog、更新 REQUEST 状态同事务完成。日志已有同 requestId 则核验归属/金额，不做第二次增量。release 只处理确认未计费且仍 RESERVED 的记录。
- [ ] 管理 API 增加 GET `:id/budget`、PATCH `:id/budget-config`、POST `:id/budget-adjustments`、GET `:id/budget-entries`、POST `:id/budget-entries/:entryId/reconcile`。调整必须携带 operationId、原因（1–2000）和 Decimal 字符串；额度调整区分 CURRENT/DEFAULT，不能调低于 spent+reserved。未知请求可用实际金额对账或有证据地释放，每次记录原值/新值/操作人。
- [ ] reconcile 后同事务更新 usageLog 的校正成本并保留原始快照/调整审计，防止日志汇总与预算汇总分叉。后续正常结算不得覆盖人工已确认的最终值。临时停用/撤销不妨碍在途账目结算。
- [ ] 验证月界、零/不限额、微小金额、并发调额度、重复结算/调整、状态冲突、失败事务回滚、孤立预占恢复。金额达到 80/100 阈值时更新周期 alertedThreshold，并写同事务审计；告警失败不影响已成功结算。
- [ ] 提交 `feat: persist atomic group budget reservations and settlements`。

## Task 7: 网关接入预算与流式故障恢复

**Files:**
- Modify: `apps/gateway/src/gateway.service.ts`
- Modify: `apps/gateway/src/app.module.ts`
- Modify: `packages/gateway-core/src/relay.ts`
- Modify: `packages/gateway-core/src/stream-usage.ts`
- Modify: `packages/gateway-core/src/cost-schedule.ts`
- Modify: `packages/quota/src/redis-quota.ts`
- Modify: `apps/worker/src/app.module.ts`
- Modify: `apps/worker/src/worker.service.ts`
- Modify: `test/gateway/gateway.service.test.ts`
- Modify: `test/gateway/relay.test.ts`
- Create: `test/integration/group-gateway.test.ts`

**Interfaces:** 延续 Task 6 的 GroupBudgetService。relayRequest 现有 signal 参数接入客户端取消。RelayResult.attempts 增加每次 usage/cost/billingState；为路由尝试加入 `beforeAttempt(candidate, attemptIndex): Promise<void>` 回调，确保发送前持久记录 dispatch 意图和所需预占。

- [ ] 基于已有流式 Response mock 写失败测试：请求双 finish/close 事件只记一笔组成本；数据库提交失败留下预占；API Key 的日志无 deviceId。

```ts
// 追加到已有 gateway.service.test.ts 流式结束用例；预算服务注入 vi.fn。
// 在测试实际触发 finish 和 close 后检查共享结算入口拿到的可信身份。
expect(budget.settle).toHaveBeenCalledTimes(1)
const settlement = budget.settle.mock.calls[0][1]
expect(settlement.usage.credentialType).toBe('API_KEY')
expect(settlement.usage.apiKeyId).toBe(principal.apiKeyId)
expect(settlement.usage.groupId).toBe(principal.groupId)
expect(settlement.usage.deviceId ?? null).toBeNull()
```

- [ ] 执行 `npm test -- test/gateway/gateway.service.test.ts test/gateway/relay.test.ts` 确认新的事件/预算断言失败。
- [ ] 在共享 relay 路径先做模型权限和请求格式校验，再确定服务端输出上限并写回各协议对应字段：Chat 的 max_tokens/max_completion_tokens、Responses 的 max_output_tokens、Messages 的 max_tokens。拒绝负数、非整数、超模型上下文范围或矛盾参数；不把默认 4096 只用于估价而不传上游。
- [ ] 对有组请求执行 Redis 既有限制，再调用 groupBudget.reserve；失败释放 Redis 预占。用量、缓存、推理各类价格采用 cost-schedule 的已解析候选快照；缺价不能视为免费。多模态等无法可靠估价的有限预算调用返回稳定 unsupported_budget_estimation 错误；普通文本与可序列化工具参数保守估算。
- [ ] 发送前 markDispatched，leaseUntil 依据超时加宽限；长流定期续租。不要持有数据库事务等待上游。客户端取消传 AbortSignal，并停止继续重试；已发出上游请求结果不明确时 markUncertain，不误 release。
- [ ] 路由重试先判定前一次是否确认未计费；可能已计费时保留该尝试预占，额外 reserve 增量后才能再发下一次。reserve 增量实现为同一请求记录的受锁追加方法 `extend(reservation, additionalCny, attemptSnapshot)`，并加入 Task 6 同级并发测试。每次路由费用分别入 RouteAttempt；总成本在 usageLog 与预算结算一致。
- [ ] 在途内存回调可能丢失，GroupBudgetService.recoverExpired 被现有 Worker 定时调用；已 dispatch 的过期预占转待核对，不能自动清零。未 dispatch 的确认未发送记录可以释放。settle/recover 按同一锁顺序竞争，延迟终态到达待核对记录时可完成结算，已经人工终结则不重复写。
- [ ] 为组请求给既有 Redis 预占增加 server requestId 级幂等标记与可恢复的 key/estimate 快照。先提交 PG 费用和日志，再按幂等 settle Lua 更新 Redis；失败保留待同步标记，Worker 重试。拒绝请求释放同样去重，避免恢复时双扣或双释放。日志精度仍八位，旧 Redis 微单位转换明确向上预占，不把它作为组金额账本。
- [ ] 实测并发竞争、流中断、缺 usage、月切换、切渠道、多次计费、PG/Redis 短暂中断和 worker 恢复。通过前保持 EMPLOYEE_API_KEYS_ENABLED=false；完成后仅本地测试配置启用。
- [ ] 提交 `feat: enforce group budgets across gateway request lifecycle`。

## Task 8: 管理端、员工接入页与生命周期操作

**Files:**
- Create: `apps/admin/src/views/UsageGroups.vue`
- Create: `apps/admin/src/views/UsageGroupDetail.vue`
- Create: `apps/admin/src/views/MyAccess.vue`
- Create: `apps/admin/src/components/EmployeeKeysPanel.vue`
- Create: `apps/admin/src/usage-groups.ts`
- Modify: `apps/admin/src/views/UserDetail.vue`
- Modify: `apps/admin/src/views/DeviceGrants.vue`
- Modify: `apps/admin/src/main.ts`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/api/src/users.service.ts`
- Modify: `apps/api/src/auth.controller.ts`（新增受网页登录认证保护的 GET me）
- Create: `test/admin/usage-groups.test.ts`
- Create: `test/admin/employee-keys.test.ts`

**Interfaces:** `GET /api/v1/auth/me` 返回 `{id,displayName,organizationId,role}`，由服务端认证 principal 生成。前端导航据此显示管理/个人入口，不以解析未验证 JWT 内容决定安全权限。后端继续独立鉴权。

- [ ] 使用既有 Vue Test Utils 模式写失败测试：空成员、零预算、操作失败可重试、选择不同组创建 Key、关闭明文显示后不再恢复、员工不能看到他人 Key。

```ts
it('distinguishes zero budget from unlimited', () => {
  expect(budgetLabel({ unlimited: false, limitCny: '0.00000000' })).toContain('0.00')
  expect(budgetLabel({ unlimited: true, limitCny: '0.00000000' })).toBe('不限额')
})
```

- [ ] 运行 `npm test -- test/admin/usage-groups.test.ts test/admin/employee-keys.test.ts` 确认失败。
- [ ] 在 usage-groups.ts 导出 `budgetLabel({unlimited,limitCny}): string`，有限值复用现有 currency.ts 的人民币展示；复用 Drawer、ConfirmDialog、Pagination、toast 和 api helper。提交按钮请求中禁用，显示字段错误，名称搜索/分页保持当前筛选。
- [ ] 组详情按概览/成员/模型/预算/用量组织；模型选择显示协议和被现有策略限制的原因。预算表单明确 TOTAL/MONTHLY、当前额度/下周期默认、显式不限额、时区和调整原因，显示处理中预占及待核对。
- [ ] EmployeeKeysPanel 供管理员创建/修改/启停/撤销和个人页查看/撤销。创建成功只在内存保存 secret，关闭/卸载时清空；不写 localStorage，不提供再次查看按钮。轮换是先创建新 Key 再显式撤销旧 Key，不误作原值恢复。
- [ ] 个人页复用登录会话，默认无密码员工不自动开通网页账号。登录已有账号可查看自己 Key；管理员在用户详情代管无密码员工。提供不含真实密钥的可复制 CLI 配置，使用环境变量引用。
- [ ] 运行上述交互测试及 `npm run admin:build`；提交 `feat: add group and employee API key management views`。

## Task 9: 用量日志、组预算和统计对账

**Files:**
- Modify: `apps/api/src/usage.controller.ts`
- Modify: `apps/api/src/analytics.dto.ts`
- Modify: `apps/api/src/analytics.service.ts`
- Modify: `packages/usage/src/analytics-types.ts`
- Modify: `apps/admin/src/views/Usage.vue`
- Modify: `apps/admin/src/views/Analytics.vue`
- Modify: `apps/admin/src/views/UsageGroupDetail.vue`
- Modify: `test/usage/usage.controller.test.ts`
- Modify: `test/analytics/analytics.service.test.ts`
- Create: `test/integration/group-cost-reconciliation.test.ts`

**Interfaces:** 新增 filters `groupId`、`apiKeyId`、`credentialType`，维度 `group`、`apiKey`。新增 `costCny` 输出；旧 `costUsd` 保留为同数值兼容别名并显式标注 CNY。新 API 不再引入 Usd 字段。

- [ ] 补充失败测试：MEMBER 传他人 accountId 或 groupId 不能扩大范围；历史无组行保留；一笔成本跨不同维度汇总金额一致。

```ts
const filter = service.resolveFilter({ sub: 'me', organizationId: 'org-a', role: 'MEMBER' }, {
  accountId: 'other', groupId: 'group-a'
})
expect(filter).toMatchObject({ organizationId: 'org-a', accountId: 'me', groupId: 'group-a' })
```

- [ ] 运行 `npm test -- test/usage/usage.controller.test.ts test/analytics/analytics.service.test.ts` 确认失败。
- [ ] 所有新 SQL 过滤保持参数化，维度映射使用白名单。连接组和 Key 时是多对一，不能直接 join GroupMember 引发重复汇总。API Key 按 apiKeyId 统计，不能把 nullable deviceId 当唯一凭据身份。

```ts
if (filter.groupId) conditions.push(Prisma.sql`u.group_id = ${filter.groupId}::uuid`)
if (filter.apiKeyId) conditions.push(Prisma.sql`u.api_key_id = ${filter.apiKeyId}::uuid`)
```

- [ ] 费用采用结算后的统一值与价格快照；费用校正保留审计，并同步 Task 6 账本。若一次请求多个渠道有计费，渠道成本分析用 RouteAttempt 成本，请求量指标仍按 requestId 去重；待核对成本单列，不能当作已结算零元成功。
- [ ] 日志展示员工姓名快照、组、Key 名称/尾号或设备、实际渠道及模型、价格时段、人民币成本和估算状态。员工转组或重命名不重算历史归属。
- [ ] 用固定上游价格样本对照组/员工/Key/模型/渠道及总览总成本；运行针对测试、typecheck、admin:build，提交 `feat: analyze usage by group and employee credential`。

## Task 10: 设备归组迁移、CLI 端到端验证与交付

**Files:**
- Modify: `apps/api/src/device-grants.dto.ts`
- Modify: `apps/api/src/device-grants.service.ts`
- Modify: `apps/api/src/device-grants.controller.ts`
- Modify: `apps/api/src/auth.service.ts`
- Modify: `apps/api/src/organizations.controller.ts`
- Modify: `apps/admin/src/views/DeviceGrants.vue`
- Modify: `apps/admin/src/views/Organizations.vue`
- Create: `scripts/rehearse-group-access-migration.ps1`
- Create: `test/integration/employee-gateway-e2e.test.ts`
- Create: `test/deploy/group-access-migration.test.ts`
- Create: `docs/employee-gateway-acceptance.md`
- Modify: `docs/employee-api-access.md`
- Modify: `README.md`

**迁移合同：** 提供组织未归组有效设备统计与清单；首次给 groupId=null 的现有授权归组允许带审计 PATCH，旧设备无需重新兑换。已经有组的授权不能修改组，需重新签发。所有新授权在组织强制模式下必选组，兑换与刷新重新检查组状态。

- [ ] 写失败测试：旧设备在 requireDeviceGroup=false 下保留原行为，true 后无组拒绝；有组总是执行组权限和预算；未分配有效设备不允许开启强制开关。

```ts
// 在现有设备认证测试 harness 上验证组织切换的拒绝原因。
await expect(guard.canActivate(context)).rejects.toMatchObject({
  response: expect.objectContaining({ code: 'group_required' })
})
```

- [ ] 演练脚本只接受明确的本地 `TEST_DATABASE_URL`，默认只做检查；导入使用带 organizationId/accountId/grantId/groupId 的映射，先预览、再原子校验归属。禁止连接或修改公司服务器中间件。
- [ ] 强制启用检查与签发/归组在同一组织锁范围执行，防止检查通过后又签发无组设备。处于切换前的在途请求按开始快照结算，切换后的新请求才采用新规则。
- [ ] E2E 用本地 mock 上游和真实测试 PG/Redis：管理员创建员工及 A/B 组 → 分别授权模型 → 分配小额预算 → 创建 Key → 两个目录 → 普通/流式对话 → 工具调用与结果回传 → 日志及余额验证 → 并发耗尽 → 401/403/429 错误验证 → 撤销 Key → UCLI 设备回归。
- [ ] 在 README 列出三种实际公开协议和内部 Gemini 限制。将各 CLI 验收结果标明版本、上游协议和请求 ID；未安装或未配置的 CLI 标“未实测”，不能凭模型目录成功宣布完整兼容。真实渠道的付费测试仅在明确授权后执行。
- [ ] 最终运行 `npm run verify`；在 CI 测试 PostgreSQL/Redis 上运行 `npm test -- test/integration`。若现有基线失败，记录原始证据并区分此次变化，不调低覆盖率掩盖失败。
- [ ] 保存验收记录，提交 `test: verify employee gateway access budgets and migration`。交付写明本地验证结果、剩余外部 CLI 验证条件；不自动合并、推送或部署。

## 计划自检记录

- 身份、组权限、两个模型目录、bootstrap、设备刷新、管理接口隔离：Tasks 2–5、10。
- 组生命周期与凭据撤销、明文只展示一次、跨组织约束：Tasks 1、2、4、8。
- 总额/月额度、零/不限额、CNY 精度、并发/幂等/异常恢复、调额度与对账：Tasks 6、7、9。
- 管理页面、个人页的无密码账号边界、统计与历史保留：Tasks 8、9。
- CLI 协议、发现端点、工具调用、路由重试与成本、迁移和发布边界：Tasks 5、7、10。
- 未创建新框架、第三方依赖、组织树、支付系统或通用协议转换器。

当前阶段一至三已实现；阶段四尚未开始。源码完成不代表生产发布，验证结果与未完成边界见各阶段执行记录。
