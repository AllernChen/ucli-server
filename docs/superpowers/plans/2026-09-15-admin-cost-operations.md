# 管理端用量与成本运营升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全使用日志、统计分析、用量组与服务总览，使成本可追溯、预算可解释、跨页筛选一致。

**Architecture:** 在现有查询、页面和预算记录上增量扩展。只抽取确实被分析与日志共用的只读查询片段、安全投影及日期转换，避免两套筛选或金额口径；不改网关计费写入与预算状态机。按后端指标、日志与分析、组、总览的依赖顺序交付。

**Tech Stack:** TypeScript、NestJS、Prisma／PostgreSQL、Decimal.js、Vue 3、ECharts、Vitest、Vue Test Utils（均已安装）。

**Spec:** `docs/superpowers/specs/2026-09-15-admin-cost-operations-design.md`（2026-09-15 用户已确认）。执行者先完整阅读设计与本计划。

## Global Constraints

- 所有金额均为人民币采购成本，不计算销售价格。
- 金额使用服务端 Decimal 和现有 8 位精度。
- 不新增账本、报表平台、采集服务或依赖。
- 本次不改变网关预算预估、扣减、缓存适配或结算机制，不改历史数据、价格配置、组额度、员工 Key 和生产环境。
- 不增加主机 CPU／内存／容器监控，不新增人工调账操作。
- 管理端统计默认以 Asia/Shanghai 展示与切分自然日；半开区间 `[start, end)`；API 未传时区保持 UTC；统计最多 90 天，小时分桶最多 31 天。
- 两类 CSV 都按已应用筛选导出，不限当前页，最多 5000 行；超限明确报错，不静默截断。
- 平台／组织／员工角色保持原有数据范围；用量组及预算管理仍限当前组织的管理员，服务总览仍限平台管理员。
- 开发完成后先本地验收，发布另行确认；不运行 `data/accept-041*` 等生产付费验收脚本。

## 执行位置与基线

当前设计位于 `F:/projects/ucli-server/.worktrees/group-access`，分支 main，设计提交 `7d311c7`。执行前按 worktree 技能选择隔离分支 `codex/admin-cost-operations`，包含本计划与设计；不要切换／清理根目录的其他开发分支。若改用同一目录，先按执行技能确认隔离要求，保留用户改动。

所有命令在选定工作树根目录运行。先执行 `git status --short`、`npm run typecheck` 和下列相关测试作为基线；测试命令的历史结果不作为本轮证据。先检查本地测试数据库条件：`test/integration/database.ts` 只允许本机 `ucli_test*` 数据库；缺失时明确记录未验证，不能把 skip 报成通过。

```powershell
npx vitest run test/analytics/analytics.service.test.ts test/usage/usage.controller.test.ts test/admin/group-usage.test.ts test/admin/usage-groups.test.ts
```

## 文件职责与依赖

| 文件 | 职责 |
|---|---|
| `apps/api/src/analytics.dto.ts`、`packages/usage/src/analytics-types.ts` | 兼容的查询／返回契约 |
| 新 `apps/api/src/usage-query.ts` | 只读共享过滤、请求状态 SQL、路由归属 CTE；不是报表框架 |
| `apps/api/src/analytics.service.ts` | 汇总、分桶、维度、选项和导出的同口径 SQL |
| 新 `apps/api/src/usage-detail.ts` | 请求、路由、价格与预算白名单投影及费用解释 |
| 新 `packages/usage/src/csv.ts` | 两类 CSV 的固定安全序列化 |
| `usage.controller.ts`、`analytics.controller.ts` | 原接口兼容及新分页／详情／导出入口 |
| 新 `apps/admin/src/usage-filters.ts`、新 `components/UsageFilters.vue` | 日界线、URL 与两页面共用筛选栏 |
| 新 `apps/admin/src/components/UsageDetail.vue` | 可复用的请求详情抽屉 |
| `Usage.vue`、`Analytics.vue`、`TrendChart.vue`、`api.ts` | 使用数据、联动、导出下载 |
| 新 `packages/quota/src/group-budget-read.ts` | 批量当前预算查询；复用单组 summary 与组列表，不改写入 |
| `usage-groups.service.ts`／controller／dto、`group-budget.service.ts` | 接入批量读，保留全部已审计写操作 |
| `UsageGroups.vue`、`UsageGroupDetail.vue`、`usage-groups.ts` | 组列表摘要与详情分析 |
| `monitoring.controller.ts`、`Dashboard.vue`、`apps/admin/vite.config.ts` | 总览提醒及已有健康检查、本地 Gateway 代理 |

批量预算读取放在 quota 包内，使 quota 不反向依赖 apps。预算计算写入函数保持原位置和行为。

任务顺序：1 → 2 → 3 → 4 → 5；6 可在 3 后开始，7 依赖 5、6，8 依赖 5、6，9 集成全部任务。共同查询和接口文件由同一执行者整合，禁止并行修改同一文件。

## Task 1：统一查询契约与请求状态

**Files:** Modify `apps/api/src/analytics.dto.ts`, `packages/usage/src/analytics-types.ts`, `apps/api/src/analytics.service.ts`; Create `apps/api/src/usage-query.ts`; Test `test/analytics/analytics.service.test.ts`, new `test/usage/usage-query.test.ts`。

**Interfaces:** 保留 `AnalyticsService.resolveFilter(principal, query, now?)`；委托新 `resolveUsageFilter(principal: AnalyticsPrincipal, query: UsageQueryDto, now?: Date, mode?: 'analytics'|'logs'): UsageReadFilter`。mode默认analytics；日志明细查询允许超过90天的明确起止区间，统计聚合仍最多90天，以支持查找较早的待核算请求。`UsageReadFilter` 扩展原 `AnalyticsFilter` 并保留 sessionId／projectId／requestId，新增如下类型；DTO 对每个字段做枚举、UUID、长度和日期校验。

```ts
export type RequestState = 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
export type CostState = 'CONFIRMED' | 'ESTIMATED' | 'UNKNOWN' | 'NO_CHARGE'
export interface UsageReadFilter extends AnalyticsFilter {
  timezone: 'UTC' | 'Asia/Shanghai'
  requestState?: RequestState
  billingState?: CostState
  groupScope?: 'UNGROUPED'
  keyScope?: 'NO_KEY'
  costRuleId?: string
  priceKey?: string
  allocation?: 'UNALLOCATED'
  requestId?: string
  sessionId?: string
  projectId?: string
}
```

`costRuleId` 为 UUID，`priceKey` 为 32 位小写十六进制（后续 SQL 对有限价格字段生成 md5，仅做分组标识）；allocation 为人工核算差额下钻。互斥组 ID 与 UNGROUPED、Key ID 与 NO_KEY、渠道与 UNALLOCATED 返回 400。旧 `model` 仍映射 publicModelId；同时传不同值返回 400。MEMBER 的 accountId 必须最终覆盖为 principal.sub，不能被省略选项筛选时移除。

- [ ] **1. 写失败测试：** 新增 DTO 不合法值、时区默认、90 天限制、小时限制、互斥选择、角色覆盖与参数化用例。

```ts
it('does not broaden member scope and separates time zone from timestamps', () => {
  const f = resolveUsageFilter(
    { sub: 'self', organizationId: 'own', role: 'MEMBER' },
    { accountId: 'other', organizationId: 'else', timezone: 'Asia/Shanghai',
      start: '2026-09-14T16:00:00Z', end: '2026-09-15T16:00:00Z' })
  expect(f).toMatchObject({ accountId: 'self', organizationId: 'own', timezone: 'Asia/Shanghai' })
  expect(f.start.toISOString()).toBe('2026-09-14T16:00:00.000Z')
})
```

- [ ] **2. 运行红测：** `npx vitest run test/usage/usage-query.test.ts test/analytics/analytics.service.test.ts`，预期缺失新契约／函数导致失败，不接受数据库连接失败作为红测。
- [ ] **3. 实现上述字段与统一解析。** 在 usage-query 导出 `requestStateSql: Prisma.Sql` 与 `usageWhere(filter: UsageReadFilter): Prisma.Sql`；所有调用统一别名 `u`，where 包含日期、组织、员工、组、凭据、模型、请求状态，路由筛选交由 Task 2 的 CTE。状态表达式如下，旧 successRate 不覆盖。

```ts
export const requestStateSql = Prisma.sql`CASE
  WHEN u.client_cancelled THEN 'CANCELLED'
  WHEN u.stream_interrupted THEN 'INTERRUPTED'
  WHEN u.status_code NOT BETWEEN 200 AND 299 OR u.error_code IS NOT NULL THEN 'FAILED'
  ELSE 'SUCCESS' END`
```

- [ ] **4. 重跑两个测试文件和 `npm run typecheck`，确认原有作用域、旧过滤与 SQL 注入用例不回退。** 日期无效、开始不早于结束返回 400。仅旧 logs／summary 在完全不提供日期时保留原来全量语义，新分页与分析要求有界日期。
- [ ] **5. 检查并提交本任务文件：** `git diff --check`，暂存 Files 中本任务修改，`git commit -m "feat: define scoped usage operations query contract"`。

## Task 2：路由成本、缓存与分时价格分析

**Files:** Modify `apps/api/src/usage-query.ts`, `apps/api/src/analytics.service.ts`, `packages/usage/src/analytics-types.ts`; Test `test/analytics/analytics.service.test.ts`, `test/integration/group-cost-reconciliation.test.ts`, new `test/integration/usage-operations.test.ts`。

**Interfaces:** 新 `usageReadCte(filter: UsageReadFilter, dimension?: AnalyticsQueryDto['dimension']): Prisma.Sql` 生成固定命名 `scoped_usage`、`allocations`、`matched_requests` 三段 CTE。`matched_requests` 每日志一行；`allocations` 每路由一行或一个旧记录／差额行。只能将 fixed allowlist 的表达式放入 Prisma.raw，不将 URL 值拼入 SQL。

在原结果中添加下列字段，旧 aliases 保留；breakdown 添加 total、每行 `drillQuery: Record<string,string>`、`allocationKind: 'ROUTE'|'LEGACY'|'UNALLOCATED'|'MIXED'`、可空安全价格投影。timeseries 仍返回数组，bucket 是该时区桶起点对应的 UTC ISO 时刻。

```ts
export interface UsageOperationalMetrics {
  requestSuccessRate: number | null
  requestStates: Record<RequestState, number>
  uncachedInputTokens: string
  cachedTokens: string
  reasoningTokens: string
  cacheHitRate: number | null
  cacheCoverage: { knownInputTokens: string; totalInputTokens: string; unknownCalls: number }
  estimatedCostCny: string
  unallocatedCostCny: string
  tokenUsageIncomplete: boolean
  errorCounts: Array<{ errorCode: string; requests: number }>
}
```

- [ ] **1. 写失败用例：** 在现有真实 PG 对账测试的 overview 断言后增加成功但 UNKNOWN 的新口径断言（旧 successRate 仍为 2/3）。新 integration 文件直接使用 `withTestDatabase`、`createOrganization`，按现有文件构造 required 账号／模型／渠道／日志记录，不建立生产连接。

```ts
expect(overview).toMatchObject({ requests: 3, requestSuccessRate: 1,
  requestStates: { SUCCESS: 3, FAILED: 0, CANCELLED: 0, INTERRUPTED: 0 },
  unsettledRequests: 1, costCny: '4.00000000', successRate: 2 / 3 })
```

新场景数据：同请求 A=1、A=0.5、B=2，总价 3.5；归一化用量分别 input=100/50/200，cache=40/10/100，output=10/5/20，source=upstream。期待 A input=150、cache=50、cost=1.5、requests=1；B input=200、cache=100、cost=2、requests=1；平台 requests=1 而不是3。另把请求总额改为4（仅测试库），期待 UNALLOCATED=0.5，维度合计仍为4。

- [ ] **2. 运行红测：** `npx vitest run test/integration/group-cost-reconciliation.test.ts test/integration/usage-operations.test.ts`，必须设置经本地安全检查的 TEST_DATABASE_URL；预期新指标／路由用量断言失败。
- [ ] **3. 构建 CTE。** scoped_usage 先应用 Task 1 权限和请求条件；allocations 从有计费信息的路由读取数值安全 JSON 字段及历史 cost，完全没有计费路由时才增加 LEGACY 行。请求总价与路由已知价之差增加 UNALLOCATED 行，无 token、无伪造渠道。无 price snapshot 行不 JOIN 当前价回填。价格键只取规则 ID／source、四类单价、timezone、daysOfWeek、startMinute、endMinute、validFrom／validTo，用 jsonb_build_object 固定顺序 md5；不包含可变 billingState。

```sql
-- 对 inputTokens 等 JSON 字段先检查格式，再 CAST；缺失返回 NULL 而非假造用量。
CASE WHEN r.usage_snapshot->>'inputTokens' ~ '^[0-9]+$'
  THEN (r.usage_snapshot->>'inputTokens')::numeric ELSE NULL END AS input_tokens
-- 仅当请求存在可计费路由时保留差额；负差额也保留。
u.cost_usd - COALESCE(SUM(r.cost_cny), 0) AS unallocated_cost_cny
```

对渠道、价格、渠道模型过滤必须落在同一 allocation 行，不能各自 EXISTS 不同路由。当前 RouteAttempt 没有 channelModelId，只有价格快照可提供时才匹配；缺失标“未关联渠道模型”，不从最终渠道模型猜其他路由。matched_requests 对匹配 allocation 按日志 ID 合并成本／用量，完整请求结果仍取 scoped_usage。无路由维度／筛选时总额与总 token 直接取 usage log，避免把重试次数变请求数。

- [ ] **4. 扩展聚合。** 请求成功独立于费用；缓存覆盖仅把 source=upstream 且记录正命中的调用计为有证据（现存零值无法区分缺失）；缓存率旁必须标“已知样本”及覆盖，覆盖无分母返回 null。估算成本按 ESTIMATED allocation 汇总，UNKNOWN 已知金额保留。breakdown 同一请求每个维度去重，total 对分组结果 COUNT，offset 越界也返回正确 total；排序同值用维度 ID／priceKey 稳定收尾。

```sql
COUNT(DISTINCT u.id) FILTER (WHERE request_state = 'SUCCESS') AS request_successes
-- UTC timestamp 字段先解释为 UTC，再按参数时区分桶，最后返回真实 UTC 时刻。
date_trunc('day', u.started_at AT TIME ZONE 'UTC' AT TIME ZONE $1) AT TIME ZONE $1 AS bucket
```

上例 `$1` 实际以 Prisma.sql 参数绑定 timezone；hour／day 已通过 allowlist。保留原 latency／failover 等指标，错误分类包括已记录 errorCode 的聚合计数，供页面展示。filterOptions 增加 `optionDimension` 和 q／分页，仅移除用户选择的同维度过滤，之后重新施加 principal 范围；历史选中项由安全日志 ID/name 恢复。

- [ ] **5. 重跑 integration、analytics 测试与 typecheck。** 补零缓存覆盖未知、无请求 null、失败有成本、UNKNOWN 部分费、取消／中断、NO_CHARGE、规则修改前后两 priceKey、上海午夜桶边界、分页越界、历史无路由和跨租户攻击。分析 costRule、channelModel 的下钻必须回到同一批请求与匹配金额。
- [ ] **6. `git diff --check` 后提交：** `git commit -m "feat: reconcile operational analytics with routed procurement costs"`，只暂存本任务文件。

## Task 3：安全请求详情、分页与两类 CSV

**Files:** Modify `usage.controller.ts`, `analytics.controller.ts`, `analytics.service.ts`（均在 `apps/api/src/`）；Create `apps/api/src/usage-detail.ts`, `packages/usage/src/csv.ts`; Test `test/usage/usage.controller.test.ts`, new `test/usage/usage-detail.test.ts`, new `test/usage/csv.test.ts`, `test/integration/usage-operations.test.ts`。

**Interfaces:** `UsageController.logsPage(req, query)` → `{items,total,limit,offset}`；`detail(req, id, query)` → 下面的 UsageDetail；`exportCsv(req, query)`、`AnalyticsController.exportCsv(req, query)` → UTF-8 CSV string。`GET /api/v1/usage/logs/:id` 的 id 为日志 UUID，不是任意 requestId；requestId 用查询定位。详情先按 id 和 principal 权限取请求，然后计算匹配部分。AnalyticsService 新 `exportRows(principal,query): Promise<Array<Record<string,unknown>>>` 内部最多5001行，与 breakdown 共用 grouped SQL，不循环翻页拼接。

```ts
export interface BudgetRequestDetail {
  status: 'RESERVED'|'SETTLED'|'RELEASED'|'RECONCILIATION_REQUIRED'
  initialEstimateCny: string | null
  extendedCny: string | null
  cumulativeReservedCny: string | null
  currentHeldCny: string
  settledCny: string
  manualFinal: boolean
  reason: string | null
}
// UsageDetail = 安全 UsageRow + routes: SafeRoute[] + budget: BudgetRequestDetail|null
// + budgetAvailability: 'AVAILABLE'|'NOT_APPLICABLE'|'NOT_FOUND'
// + matchedCostCny:string + unallocatedCostCny:string。
```

UsageRow 白名单：id、requestId、startedAt、finishedAt、accountId／employeeName、groupId／groupName、apiKeyId／keyName／keyHint、credentialType、publicModelId、channelId／channelName、upstreamModel、四类 token、costCny／costUsd、usageSource、requestState、billingState、statusCode、errorCode、durationMs、firstTokenMs、routeAttempts。SafeRoute 白名单：attempt、channelId／name、startedAt、durationMs、statusCode、errorType、billingState、costCny、四类用量、是否用量完整、安全 price、formulaCosts。price 仅允许 Task 2 priceKey 所含字段及 ruleName；不展开整 snapshot。

- [ ] **1. 写失败测试。** `projectBudgetEntry(entry: Pick<GroupBudgetEntry,'status'|'reservedCny'|'settledCny'|'snapshot'|'reason'>): BudgetRequestDetail` 是 Task 3 输出的纯投影函数，测试使用 Decimal 值及真实枚举；补 synthetic 内部 secret 不出现在 JSON 的断言。

```ts
const result = projectBudgetEntry({ status: 'SETTLED', reservedCny: new Decimal('4'),
  settledCny: new Decimal('1'), reason: null,
  snapshot: { initialEstimateCny: '3', extensions: [{ amount: '1' }],
    request: { redis: { internalSecret: 'DO_NOT_EXPOSE' } } } })
expect(result).toMatchObject({ cumulativeReservedCny: '4.00000000',
  currentHeldCny: '0.00000000', settledCny: '1.00000000' })
expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE')
```

- [ ] **2. 运行红测：** `npx vitest run test/usage/usage-detail.test.ts test/usage/csv.test.ts test/usage/usage.controller.test.ts`，预期新导出／投影缺失。
- [ ] **3. 实现投影与 detail。** 先授权 log 查询，不存在／不允许统一404；预算查询包含 organizationId/groupId/accountId/requestId/kind=REQUEST 以及 credentialType、credentialId（API_KEY 对 apiKeyId，DEVICE 对 deviceId）。预算关联只能返回匹配项；不读取其他员工组余额。initial／extensions 缺失为null，不能以已被缩减的 reservedCny 猜初始预估。

```ts
const currentHeldCny = ['RESERVED', 'RECONCILIATION_REQUIRED'].includes(entry.status)
  ? entry.reservedCny.toFixed(8) : '0.00000000'
```

价格字段与 token 都有效且 Number.isSafeInteger 时调用已有 estimateProcurementCost；超安全整数或资料不足不 Number 强转后假装精确，公式值返回null、记录值保留。实际费用与公式不同展示差异，不写回。日志分页／导出共用 Task 2 matched_requests；旧 logs 数组形状不变，原 summary 兼容字段保留并添加新指标。

- [ ] **4. 实现 CSV 与 HTTP。** `csvDocument(rows: readonly (readonly string[])[]): string` 使用下列核心转义；在导出业务方法读取最多5001行并超限抛400（message说明缩小范围），设置 `text/csv; charset=utf-8`、固定 ASCII 下载文件名和 `Cache-Control: no-store`。身份、请求、模型、token、金额、状态和价格标识为固定列，预算内部字段不导出。

```ts
export function csvDocument(rows: readonly (readonly string[])[]): string {
  const cell = (text: string) => {
    const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text) ? `'${text}` : text
    return `"${safe.replaceAll('"', '""')}"`
  }
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
```

测试中文、双引号、逗号、换行、前导空白公式、负差额、5000成功／5001失败；CSV表格所有字符串都安全，负金额可能以文本单元格呈现但不失精度。下载认证失败沿用API错误，不生成伪成功空文件。

- [ ] **5. 运行三个单测文件、Task 2 integration 和 typecheck。** 增加伪造组织／员工详情／预算关联攻击，NO_KEY／UNGROUPED、未知状态和priceKey的分页导出一致性。检查 controller 新路径有 guard，旧 logs 消费者不因响应 envelope 破坏。
- [ ] **6. 检查并提交：** `git commit -m "feat: add safe request cost details and filtered CSV exports"`。

## Task 4：共享筛选、请求详情与使用日志界面

**Files:** Create `apps/admin/src/usage-filters.ts`, `apps/admin/src/components/UsageFilters.vue`, `apps/admin/src/components/UsageDetail.vue`; Modify `apps/admin/src/views/Usage.vue`, `apps/admin/src/api.ts`; Test `test/admin/group-usage.test.ts`, new `test/admin/usage-filters.test.ts`, new `test/admin/usage-details.test.ts`。

**Interfaces:** `companyDateRange(startDay:string,endDay:string): {start:string;end:string;timezone:'Asia/Shanghai'}` 将 UI 含结束日变UTC半开区间；`usageQuery(filters:Record<string,string|undefined>, pinnedGroupId?:string): string` 只序列化Task 1字段、去空值并最后覆盖pin；`UsageFilters` props `{modelValue:Record<string,string>; role:string; pinnedGroupId?:string}`，emit `update:modelValue`、`apply`；内部选项来自 filter-options，不从模型／用户管理接口拓宽数据范围。`UsageDetail` props `{id:string|null; query:string}`，emit `close`，内部请求 Task 3 detail。`downloadCsv(path:string,filename:string): Promise<void>` 加到 api.ts，复用同一认证／错误处理，不复制401处理规则。

- [ ] **1. 写红测。** 新 date helper 测试覆盖上海日期不受浏览器时区影响；扩展嵌入日志测试 mock router.push/replace 和 logs-page envelope；通过可访问label／role操作，不依赖组件内部变量。

```ts
expect(companyDateRange('2026-09-15', '2026-09-15')).toEqual({
  start: '2026-09-14T16:00:00.000Z', end: '2026-09-15T16:00:00.000Z', timezone: 'Asia/Shanghai' })
expect(new URLSearchParams(usageQuery({ groupId: 'other' }, 'pinned')).get('groupId')).toBe('pinned')
```

- [ ] **2. 运行红测：** `npx vitest run test/admin/usage-filters.test.ts test/admin/group-usage.test.ts test/admin/usage-details.test.ts`。
- [ ] **3. 实现日期、URL和筛选。** 用原生日期输入，先验证 YYYY-MM-DD 真实日期（构造后与输入日比较），上海为固定+08:00，结束加86400000。helper只校验真实日期及start<end，90天限制由统计页面施加，日志页允许更长的明确范围。route里的UTC日期逆转换为UI含末日，但在用户重新应用日期之前保留原始ISO精度，不擅自扩大来自总览的时间边界；保留旧 model 参数兼容。使用现有 createRequestLifecycle，applied 与 draft 分开；分页／导出只用 applied。浏览器返回时 watch route.query 恢复并重取，避免replace死循环。

```ts
const begin = new Date(`${startDay}T00:00:00+08:00`)
const finish = new Date(new Date(`${endDay}T00:00:00+08:00`).getTime() + 86_400_000)
// 执行真实日校验、范围校验后返回 ISO，不能用 toISOString().slice(0,10) 获取上海今天。
```

- [ ] **4. 使用已有 Drawer／Pagination 渲染明细与表格。** 默认字段为员工、组、Key、模型／渠道、输入细分／输出、已记录成本、两类状态；详情展开各路由价格与预算，缺失显示未提供。添加复制requestId、对应分析入口、可见导出进度；下载用 Blob URL，finally revokeObjectURL；费用UNKNOWN不是“免费”。

```vue
<Pagination :total="page.total" :limit="page.limit" :offset="page.offset" @change="changePage" />
<UsageDetail :id="selectedId" :query="appliedQuery" @close="selectedId = null" />
```

`changePage(offset:number)` 更新已应用分页并load；`selectedId` 为 ref<string|null>；`appliedQuery` 为 usageQuery(applied,pinnedGroupId)。详情有自己生命周期，切换请求时不保留旧明细。所有新控件有label，键盘关闭／焦点恢复复用Drawer。

- [ ] **5. 重跑三个测试与 `npm run admin:build`。** 补失败重试、快速切换的旧响应不覆盖、URL刷新恢复、固定组禁改、未知预算无假零、认证错误下载不落文件和ObjectURL释放。检查工作表不泄露原 snapshot。
- [ ] **6. 检查并提交：** `git commit -m "feat: make usage logs filterable and costs inspectable"`。

## Task 5：统计分析分页、缓存及跨页定位

**Files:** Modify `apps/admin/src/views/Analytics.vue`, `apps/admin/src/components/TrendChart.vue`, `apps/admin/src/analytics.css`; Create `test/admin/analytics-operations.test.ts`。

**Interfaces:** 消费 Task 2 的 overview／timeseries／breakdown 与 drillQuery，Task 4 的 UsageFilters／usageQuery／downloadCsv。TrendChart 新可选 prop `timezone?: 'UTC'|'Asia/Shanghai'`，旧调用默认UTC，四个新页面明确传上海；成功率使用 requestSuccessRate，不将null画成0；保留旧数据调用fallback只在新字段不存在时使用。

- [ ] **1. 写失败组件测试：** mock `/auth/me`、四个analytics端点和downloadCsv。响应第一页 `{items:[{id:'a',name:'渠道A',requests:1,costCny:'1.5',drillQuery:{channelId:'a'}}],total:51,limit:50,offset:0}`，依按钮分页后检查offset50。组件测试 stub TrendChart，以另一小测试mock ECharts检查null折线与时区label。

```ts
await wrapper.get('[aria-label="查看匹配日志"]').trigger('click')
expect(router.push).toHaveBeenCalledWith({ path: '/usage', query: expect.objectContaining({ channelId: 'a' }) })
await wrapper.get('[aria-label="导出统计"]').trigger('click')
expect(downloadCsv).toHaveBeenCalledWith(expect.stringContaining('/analytics/export?'), 'ucli-analytics.csv')
```

测试中的 wrapper 用 mount(Analytics)；router 与 downloadCsv 通过 vi.hoisted/vi.mock 提供；load完成后flushPromises，再触发。

- [ ] **2. 运行红测：** `npx vitest run test/admin/analytics-operations.test.ts`。
- [ ] **3. 替换筛选栏，接入 total／分页／排序／导出。** 新列使用 costCny、缓存量、命中率及覆盖、requestSuccessRate；卡片显示估算成本、待核算数，失败分类来自后端已有错误码汇总。规则表使用快照四单价，不再以当前规则或加权input/out冒充历史价。每行独立按钮“继续分析”“查看匹配日志”，null组／Key和UNALLOCATED由drillQuery表示，不猜测UUID。

```ts
function openLogs(row: { drillQuery: Record<string, string> }) {
  router.push({ path: '/usage', query: { ...applied, ...row.drillQuery } })
}
```

`applied` 为已应用筛选字符串对象；导航时丢掉维度分页offset/limit/sort/order，保留数据过滤。用户改维度或排序时offset归0；page之外行数导出全部当前筛选。各请求用生命周期保护，不将旧图表留在新标题下冒充最新数据。

- [ ] **4. 重跑组件测试、Task 4测试和admin build。** 验证空结果总数、UTC用户浏览上海天界、UNKNOWN成功、低缓存覆盖提示、回退筛选、固定组下钻和规则时段跨天说明。
- [ ] **5. 检查并提交：** `git commit -m "feat: complete cache-aware analytics and usage drilldowns"`。

## Task 6：批量组预算摘要和风险筛选

**Files:** Create `packages/quota/src/group-budget-read.ts`; Modify `packages/quota/src/group-budget.service.ts`（只summary读取）, `apps/api/src/usage-groups.service.ts`, `apps/api/src/usage-groups.dto.ts`, `apps/admin/src/usage-groups.ts`; Test `test/integration/group-budget.test.ts`, `test/integration/usage-groups.test.ts`, new `test/integration/group-budget-read.test.ts`。

**Interfaces:** `readGroupBudgets(db: Prisma.TransactionClient, organizationId:string, groupIds:readonly string[], now?:Date): Promise<Map<string, GroupBudgetSummary>>`；GroupBudgetSummary 字段完全保留原 GroupBudgetService.summary 返回值，类型就近定义在新文件，admin GroupBudget 与其保持字段一致（不将数据库运行时导入浏览器）。`UsageGroupsService.list` 增加每item `{budget:GroupBudgetSummary, activeMembers:number, activeKeys:number}`；DTO 新 `budgetRisk?: 'NEAR_LIMIT'|'EXHAUSTED'|'UNSETTLED'|'ATTENTION'`，ATTENTION 为前三种风险并集，筛选在分页之前执行以支持总览“全部”。

- [ ] **1. 写红测：** 用真实PG现有createOrganization建立 TOTAL／MONTHLY／零额度／无限额组，不创建预算周期，再调用readGroupBudgets。对比原单summary含义；随后使用原reserve/settle/hold建立记录验证摘要，不在helper写入。

```ts
const before = await db.groupBudgetPeriod.count({ where: { groupId: group.id } })
const results = await readGroupBudgets(db, actor.organizationId, [group.id], new Date('2026-09-30T16:00:00Z'))
expect(results.get(group.id)).toMatchObject({ periodKey: '2026-10', reservedCny: '0.00000000' })
expect(await db.groupBudgetPeriod.count({ where: { groupId: group.id } })).toBe(before)
```

group此用例为MONTHLY、Asia/Shanghai，使用 `db.usageGroup.create` 与原模型required字段建立；测试另组织ID返回空map。

- [ ] **2. 运行红测：** `npx vitest run test/integration/group-budget-read.test.ts test/integration/group-budget.test.ts`。
- [ ] **3. 实现有限次批量查询：** 查询组织内指定groups，一次batch查询(groupId,periodKey)对应period，一次aggregate当前period的RECONCILIATION_REQUIRED，不逐组查询。periodKey复用budgetPeriodKey；金额与可用复用availableCny。summary原鉴权后调用此helper，空结果仍404。不得修改reserve／settle／hold／reconcile和锁。

```ts
const limitCny = (period?.limitCny ?? group.defaultLimitCny).toFixed(8)
const unlimited = period?.unlimited ?? group.unlimited
const spentCny = period?.spentCny.toFixed(8) ?? '0.00000000'
const reservedCny = period?.reservedCny.toFixed(8) ?? '0.00000000'
const available = unlimited ? null : availableCny(limitCny, spentCny, reservedCny)
```

带budgetRisk的list用受组织限制的SQL在分页前按current period的同等表达式筛选；MONTHLY periodKey按每组timezone计算，TOTAL为TOTAL。NEAR_LIMIT 为有限正额度且80%<=占用<100%，EXHAUSTED为有限额度<=0或占用>=额度，UNSETTLED为待核算预占>0；已停用／归档沿用status条件。count用相同WHERE，不取全量groups后JS分页。有效成员条件复制现有assertActiveGroupMember的关系约束，不调用逐成员检查；有效Key按revokedAt／disabledAt／expiresAt计数。风险金额比较在Decimal或numeric中，不能Number后比较。

- [ ] **4. 重跑本任务integration与typecheck。** 补20组查询次数上限（预算读固定3次，不随组数增加）、同时间跨时区月份、不存在周期、负剩余、unknown是reserved子集、摘要只读、越权ID、risk筛选total准确。确保旧组API及预算回归全通过。
- [ ] **5. 检查并提交：** `git commit -m "feat: batch read usage group budgets and expose risk filters"`。

## Task 7：用量组列表与详情运营信息

**Files:** Modify `apps/admin/src/views/UsageGroups.vue`, `apps/admin/src/views/UsageGroupDetail.vue`, `apps/admin/src/usage-groups.ts`; Test `test/admin/usage-groups.test.ts`, new `test/admin/usage-group-operations.test.ts`。

**Interfaces:** group list消费Task 6内嵌budget，不再请求每组/budget；详情当前周期继续单组budget端点。新增详情“使用分析”区消费 `/analytics/timeseries` 和 `/analytics/breakdown?dimension=account|model|apiKey`，固定当前group，默认7天；Task 4 UsageDetail 用于预算流水requestId定位后打开。保留原成员／模型／预算操作及幂等operationId。

- [ ] **1. 写失败UI用例。** 用group list返回一组带budget与counts，断言没有逐组budget调用；对UNKNOWN只显示一次待核算包含关系。

```ts
expect(api.mock.calls.some(([url]) => /\/usage-groups\/[^/]+\/budget\b/.test(url))).toBe(false)
expect(wrapper.text()).toContain('当前周期')
expect(wrapper.text()).toContain('待核算（包含在预占内）')
```

本用例mount UsageGroups，不是Detail；vi.mock api按list response返回，组件生命周期通过flushPromises完成。

- [ ] **2. 运行红测：** `npx vitest run test/admin/usage-group-operations.test.ts test/admin/usage-groups.test.ts`。
- [ ] **3. 改列表和详情UI。** 从route.query恢复budgetRisk，和q/type/status共同应用；80%提醒与服务端返回筛选语义一致，组停用／无模型／无成员是独立提示，没有员工Key不意味着不可用。详情分析区延迟到打开该tab加载，只请求选中的排行维度，避免每次修改预算重新拉所有图表。

```vue
<small>待核算（包含在预占内）{{ formatCny(group.budget.uncertainCny) }}</small>
<TrendChart :data="groupSeries" metric="cost" timezone="Asia/Shanghai" />
```

`group` 为当前列表item；`groupSeries` 为ref数组，API请求 query始终覆写groupId。预算流水状态使用中文映射，requestId按钮先通过logs-page精确查找，找不到显示未找到而非另组数据。编辑、停用、归档、配置、额度调整保留现有确认／原因／审计过程。

- [ ] **4. 重跑两个组UI测试、group-usage测试和admin build。** 覆盖默认零与无限、近阈值和负剩余、图表日期不改变预算周期、route变更清除旧组数据、部分加载失败、原额度调整operationId不变。
- [ ] **5. 检查并提交：** `git commit -m "feat: improve usage group budget and member operations views"`。

## Task 8：服务总览与真实健康状态

**Files:** Modify `apps/api/src/monitoring.controller.ts`, `apps/admin/src/Dashboard.vue`, `apps/admin/vite.config.ts`; Create `test/monitoring/operations-overview.test.ts`, `test/admin/dashboard-operations.test.ts`; Test `test/monitoring/metrics.controller.test.ts`。

**Interfaces:** `GET /api/v1/monitoring/overview` 保留类级PLATFORM_ADMIN guard；返回 `{timestamp, budgetOrganizationId, channels:{items,total}, budgets:{items,total}, unsettled:{items,total,start,end}}`。items最多5，budget item复用Task6摘要；unsettled item只含日志id/requestId、归属label、costCny和时间，start为匹配UNKNOWN最早startedAt或null，end为本次读取时间的ISO字符串。总览今日／本月／7天指标直接调用已有analytics，不再写一套算费SQL。API／Gateway健康直接 GET `/healthz`／`/gateway/healthz`，无额外paid probing。

- [ ] **1. 写红测：** 监控服务fixture至少6个风险组／异常渠道／UNKNOWN请求，验证items=5、total=6、组只本组织，成员403。Dashboard mock健康失败、analytics成功、channels返回分页对象，不能整页空白。

```ts
expect(wrapper.text()).toContain('检查失败')
expect(wrapper.text()).toContain('今日采购成本')
expect(wrapper.text()).not.toContain('30000 ms') // timeoutMs不是实测latency
expect(wrapper.text()).not.toContain('PostgreSQL 故障') // 不能从入口失败推断具体依赖
```

wrapper通过mount(Dashboard)得到；api/publicApi mocks按URL区分，渠道timeoutMs设30000且usage24h.p95LatencyMs=null，assert等待flushPromises。

- [ ] **2. 运行红测：** `npx vitest run test/monitoring/operations-overview.test.ts test/admin/dashboard-operations.test.ts`。
- [ ] **3. 实现监控提醒的有界查询。** 当前组织group风险沿用Task6条件，total与top5在同一查询口径下，按耗尽、待核算、接近额度再name/id排序；渠道仅enabled且health=DEGRADED/UNHEALTHY，disabled不作故障提醒。待核算使用当前日志UNKNOWN，不受图表日期筛选；budget“查看全部”附budgetRisk=ATTENTION与status=active，未核算“全部”跳 `/usage?billingState=UNKNOWN&start=最早时间&end=读取时间`。此日志模式允许跨90天但始终分页、导出最多5000行；切换统计时超过90天要求缩小区间，不静默截断。没有UNKNOWN时隐藏此链接。

- [ ] **4. 改Dashboard。** 删除未实际路由到的isUsage分支；预算区明确“当前组织”，成本卡“平台范围”。按模块独立lifecycle／loading／error／updatedAt，手动刷新与单模块重试；显示已知成本与待核算提示。渠道实测使用usage24h字段，标“近24小时最终渠道请求”，不冒充路由整体延迟。渠道列表分页或top5+全部，不把item.length作总数。

```ts
// apps/admin/vite.config.ts：放在proxy表，不修改已有/api等项。
'/gateway': { target: 'http://127.0.0.1:3001', rewrite: path => path.replace(/^\/gateway/, '') }
```

健康响应非JSON、超时、HTTP非2xx分别保留可理解失败信息；使用AbortController在10秒结束请求并在卸载取消，不增加后台轮询。`publicApi`必要时接收signal，避免健康401清除管理员登录。成功显示健康接口timestamp，失败保留最后成功时间并明确不是当前成功。

- [ ] **5. 重跑监控／Dashboard／组UI测试、typecheck和admin build。** 确认总览无模型测试POST、无写预算、不会错误显示数据库正常或具体故障；上海今日／本月与analytics同边界，导航链可回溯。
- [ ] **6. 检查并提交：** `git commit -m "feat: complete cost operations dashboard with scoped alerts"`。

## Task 9：全链路验收与交付记录

**Files:** Modify `test/integration/usage-operations.test.ts`；Create `docs/verification/2026-09-15-admin-cost-operations.md`；只为验证发现的本范围问题修改相应实现／测试。

**Interfaces:** 所有页面／API使用已确定契约，无新增接口。证据文档记录代码commit、命令exit code、真实PG是否运行、浏览器验证步骤及限制，不含token／连接串／生产私钥。

- [ ] **1. 集成对账断言：** 在Task2同一PG数据集内实例化AnalyticsService与UsageController，对相同filter比较overview、logs-page、导出固定costCny列；使用Decimal而非浮点reduce。

```ts
const total = page.items.reduce((sum, row) => sum.plus(row.costCny), new Decimal(0))
expect(total.toFixed(8)).toBe(overview.costCny)
expect(overview.requestSuccessRate).toBe(1)
expect(page.items.some(row => row.billingState === 'UNKNOWN')).toBe(true)
```

此数据集日志数小于分页limit；另外场景验证跨页总和。成功率断言针对原三个均HTTP200且无error的fixture，不能用于新失败混合fixture。

- [ ] **2. 确认本地PG和必要Redis测试变量指向专用本地测试环境。** 不输出连接串。执行 `npx vitest run test/integration/usage-operations.test.ts test/integration/group-budget-read.test.ts test/integration/group-cost-reconciliation.test.ts`，不得跳过后声称集成通过。
- [ ] **3. 执行 `npm run verify`。** 记录typecheck、完整测试／coverage、服务端build、admin build、licenses各结果；失败先最小复现并修复，重新跑相关用例及verify。不以单测通过代替数据库或浏览器验证。
- [ ] **4. 启动本地服务并通过浏览器执行：** 平台总览 → 异常／待核算 → analytics切渠道／模型／价格 → 查看匹配日志 → 请求抽屉 → 用量组预算流水 → 本组分析。测试浏览器返回、刷新、日期跨上海午夜、CSV中文、5001超限、键盘关闭抽屉、空态与错误重试。再以组织管理员／员工验证菜单和直接URL／API越权。只用本地fixture，不发送上游模型请求。
- [ ] **5. 在本地代表性日志数据运行参数化SELECT的 `EXPLAIN (ANALYZE, BUFFERS)`。** 至少覆盖90天channel breakdown、priceKey筛选、group风险分页；记录扫描行数和耗时。若需索引另作有证据的最小迁移提议，不自动增加缓存系统。
- [ ] **6. 写验收记录，完成独立代码审查后检查 diff 与 git status。** 若采用子代理执行，主代理必须复验安全／金额路径。没有通过的项目明确列未完成，不部署、不推送、不合并，向用户交付本地结果与下一步发布选择。

## 计划自检映射

| 设计要求 | 任务 |
|---|---|
| 人民币、缓存覆盖、请求与计费状态、历史价格、跨渠道差额 | 1、2、3 |
| 日期／URL／权限／防越权／历史未归组与无Key | 1、3、4、5、9 |
| 请求详情、预算安全投影、公式与权威金额 | 3、4 |
| 筛选、分页、5000条CSV与公式注入防护 | 2、3、4、5 |
| 批量组预算、80%风险、旧预算操作保留、组内趋势 | 6、7 |
| 总览健康、异常入口、独立错误处理与正确统计范围 | 8 |
| 全面验证、无生产变更、无付费调用 | 9 |

执行前不要求再次确认已批准的功能范围。计划完成后仅选择执行方式：任务子代理逐项实现并审查，或本会话顺序分批实现；实现前阅读对应执行技能。
