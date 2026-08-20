# 渠道、渠道模型、分时成本、测试台与统计分析实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有渠道和模型粗粒度配置升级成可维护、可探测、可直接对话测试、支持渠道模型分时采购成本并可按渠道/模型/成本/用户分析用量的内部 Token 运营控制台。

**Architecture:** 以“渠道模型（ChannelModel）”作为渠道与公共模型之间的核心实体，渠道负责连接与 Key，渠道模型负责上游模型名、协议、能力、健康和分时采购成本。网关在请求开始时解析候选渠道模型及当时有效采购成本，成功后按实际命中的渠道模型核算并固化成本快照；管理 API 提供独立的目录、探测、测试和分析服务，管理后台改成列表—详情式交互。

**Tech Stack:** NestJS 11、Prisma 6、PostgreSQL 17、Vue 3 `<script setup>`、Vite 7、Vitest 3、ECharts 6、Docker Compose。

## Global Constraints

- 不保存普通网关请求正文或响应正文；测试台会话只存在浏览器内存和请求处理内存中，数据库只记录测试状态与性能元数据。
- 所有采购成本以“每百万 Token 的 USD 单价”保存；本阶段不引入汇率换算。
- 平台不计算用户销售价格、收入或毛利；`costUsd`、成本配额和分析金额都表示公司向上游渠道承担的采购成本。
- 时间段按渠道配置的 IANA 时区解析，默认 `UTC`；支持星期组合、跨午夜时段和有效日期范围。
- 现有 `/api/v1/admin/channels`、`/api/v1/admin/models`、网关协议和已有数据保持兼容，迁移不能让现有已发布模型突然离线。
- PLATFORM_ADMIN 可管理全部渠道；ORG_ADMIN 和 MEMBER 只能查看权限范围内的统计，不能访问渠道密钥或管理测试接口。
- 控制器不再接收 `any` 作为新增接口 DTO；数字、枚举、URL、分页和日期范围必须在入口完成校验。
- 单元/集成测试继续使用 Vitest；完整交付必须通过 `npm run verify` 和 Playwright 管理后台验收。

---

## 一、目标体验与范围边界

### 1. 渠道工作台

- `/channels` 只展示可扫描的渠道列表：名称、供应商、协议、启用状态、渠道健康、可用 Key 数、健康模型数、最近探测、近 24 小时请求/成功率/P95。
- 支持按名称搜索，按供应商、协议、启用状态、健康状态过滤，支持分页。
- 新建渠道使用侧边抽屉，分“基础连接、路由策略、Key”三段；高级字段默认折叠。
- 点击渠道进入 `/channels/:id`，使用“概览、渠道模型、Key、健康记录、设置”五个页签。
- 渠道模型页支持从上游发现模型、手工添加、批量启停、单个测试、批量测试和采购成本配置。

### 2. 公共模型目录

- `/models` 保留面向客户端的公共模型视角，显示每个公共模型挂载了多少渠道模型、健康/异常数量、当前采购成本范围和近 24 小时使用量。
- `/models/:id` 维护显示名、上下文长度、发布状态、渠道映射和默认兜底成本；渠道模型的健康与分时成本从这里可查看并跳转到所属渠道详情。
- 发布检查必须明确列出阻塞项：没有可用渠道模型、没有当前有效成本、最近一次模型对话测试失败。

### 3. 模型测试台

- `/model-test` 先选渠道，再选该渠道下的渠道模型；测试请求固定命中该渠道模型，不进行故障切换。
- 支持多轮消息、system prompt、temperature、max tokens、流式开关、清空会话。
- 展示 HTTP 状态、总延迟、首字延迟、输入/输出 Token、命中的 Key 后四位、应用成本规则、估算采购成本和原始响应 JSON。
- 页面刷新即清空消息；服务端日志和数据库不保存消息内容。

### 4. 统计分析

- `/analytics` 提供今日、近 7 天、近 30 天和自定义时间范围，支持组织、用户、渠道、公共模型、渠道模型过滤。
- 总览指标：请求量、成功率、活跃用户、输入/输出 Token、采购成本、平均成本/请求、P50/P95 总延迟、P50/P95 首字延迟、故障切换率。
- 趋势：请求、Token、采购成本、成功率随时间变化。
- 维度表：组织/部门、渠道、模型、用户、成本规则；每行包含请求、成功率、Token、采购成本、加权平均单位成本、延迟和最近使用时间。
- 成本分析按“基础/高峰规则”比较请求量、Token 和实际采购成本，所有历史成本以 `UsageLog.costSnapshot` 为准，不随后续改价变化。

## 二、领域模型与关键决策

### 渠道、公共模型和渠道模型

```text
Channel 1 ── N ChannelModel N ── 1 PublicModel
                    │
                    ├── N ChannelModelCostRule
                    └── N ChannelModelProbe
```

- `Channel`：供应商连接、协议、baseUrl、Key 和路由策略。
- `PublicModel`：客户端看到的稳定模型 ID，例如 `gpt-4o`。
- `ChannelModel`：某渠道实际提供的上游模型，例如渠道 A 的 `gpt-4o-2024-11-20` 映射到公共模型 `gpt-4o`。
- `ChannelModelCostRule`：公司采购该渠道模型时，在某个有效日期、星期和本地时间段内承担的实际单位成本。
- `ModelPriceVersion`：保留为旧数据兼容的公共模型兜底成本；没有匹配的渠道成本规则时才使用。
- `UsageLog.costUsd`、成本配额和统计金额统一表示公司采购成本；平台不记录销售价，也不产生收入或毛利指标。

### 分时成本匹配规则

1. 过滤 `enabled=true` 且 `validFrom <= requestTime < validUntil` 的规则。
2. 将请求时间转换到渠道 `pricingTimezone`。
3. 匹配 ISO 星期（1=周一，7=周日）和分钟区间；`startMinute > endMinute` 表示跨午夜，二者相等表示全天。
4. 按 `priority DESC, validFrom DESC, createdAt DESC` 选择第一条。
5. 同一渠道模型不允许两个相同优先级规则在有效日期、星期和分钟区间上重叠。
6. 若没有匹配规则，使用当前有效的 `ModelPriceVersion` 作为兼容兜底成本；两者都不存在时禁止发布并禁止新增网关流量。

### 健康判定

- 新迁移的渠道模型继承所属渠道健康状态，避免升级即下线。
- 手工或定时对话探测成功一次即设为 `HEALTHY` 并清零连续失败次数。
- 第 1、2 次连续失败设为 `DEGRADED`；第 3 次连续失败设为 `UNHEALTHY`。
- `401/403/404(model_not_found)` 直接设为 `UNHEALTHY`；超时、429、5xx 走连续失败规则。
- 路由只选择 `HEALTHY`、`DEGRADED` 的渠道模型；`DISABLED` 永不参与。
- 默认每 15 分钟做一次最多输出 1 Token 的深度对话探测，单 Worker 并发为 3；渠道模型可关闭自动探测。

## 三、文件结构

### 数据与共享领域逻辑

- Modify: `prisma/schema.prisma` — 新增渠道模型主键、健康字段、成本规则、探测记录和用量成本快照。
- Create: `prisma/migrations/202608200001_channel_model_operations/migration.sql` — 无停机兼容迁移和数据回填。
- Create: `packages/gateway-core/src/cost-schedule.ts` — 分时采购成本匹配、跨午夜判断和最高预估成本选择。
- Create: `packages/gateway-core/src/model-health.ts` — 健康状态转换纯函数。
- Modify: `packages/gateway-core/src/relay.ts` — 候选项携带 `channelModelId`。
- Modify: `packages/gateway-core/src/cost.ts` — 接受固化成本快照并保持 Decimal 计算。

### 控制面与 Worker

- Create: `apps/api/src/catalog.dto.ts` — 渠道、渠道模型、成本、探测、测试、分析 DTO。
- Create: `apps/api/src/channel-models.controller.ts` — 渠道模型、成本规则、探测记录和批量测试路由。
- Create: `apps/api/src/channel-models.service.ts` — 渠道模型目录与事务边界。
- Create: `apps/api/src/model-testing.controller.ts` — 管理员非流式和 SSE 测试端点。
- Create: `apps/api/src/model-testing.service.ts` — 固定渠道模型测试、Key 选择、协议转换、指标提取；不持久化消息。
- Create: `apps/api/src/analytics.controller.ts` — 统计查询路由。
- Create: `apps/api/src/analytics.service.ts` — 权限范围、时间序列和维度聚合 SQL。
- Modify: `apps/api/src/channels.controller.ts`、`channels.service.ts` — 列表摘要、详情、发现模型和兼容旧接口。
- Modify: `apps/api/src/models.controller.ts` — 公共模型详情与发布检查。
- Modify: `apps/api/src/app.module.ts` — 注册新增控制器和服务。
- Modify: `apps/worker/src/worker.service.ts` — 分层渠道探测、渠道模型对话探测和健康记录清理。

### 网关

- Modify: `apps/gateway/src/gateway.service.ts` — 候选渠道模型的实时采购成本解析、最大成本预留、实际成本核算和快照落库。
- Modify: `test/gateway/gateway.service.test.ts` — 覆盖峰谷切换、候选实际成本和兜底成本。

### 管理后台

- Create: `apps/admin/src/types/catalog.ts` — 替代渠道/模型相关的 `any`。
- Create: `apps/admin/src/components/StatusBadge.vue`、`Drawer.vue`、`ConfirmDialog.vue`、`Pagination.vue` — 公共交互组件。
- Create: `apps/admin/src/components/CostScheduleEditor.vue` — 分时采购成本编辑和 7×24 预览。
- Create: `apps/admin/src/components/TrendChart.vue` — ECharts 生命周期封装。
- Rewrite: `apps/admin/src/views/Channels.vue` — 渠道列表工作台。
- Create: `apps/admin/src/views/ChannelDetail.vue` — 渠道详情和渠道模型维护。
- Rewrite: `apps/admin/src/views/Models.vue` — 公共模型目录。
- Create: `apps/admin/src/views/ModelDetail.vue` — 公共模型详情与发布检查。
- Create: `apps/admin/src/views/ModelTest.vue` — 多轮对话测试台。
- Create: `apps/admin/src/views/Analytics.vue` — 统计总览、趋势和维度表。
- Modify: `apps/admin/src/main.ts`、`App.vue`、`styles.css`、`forms.css` — 路由、导航和响应式布局。

### 测试与文档

- Create: `test/gateway/cost-schedule.test.ts`、`model-health.test.ts`。
- Create: `test/catalog/channel-models.service.test.ts`、`model-testing.service.test.ts`。
- Create: `test/analytics/analytics.service.test.ts`。
- Modify: `docs/acceptance.md`、`README.md`、`docs/providers.md` — 新流程、采购成本语义和验收截图。

---

### Task 1: 建立渠道模型、分时成本和探测数据模型

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/202608200001_channel_model_operations/migration.sql`
- Modify: `apps/api/src/models.controller.ts`
- Modify: `apps/api/src/channels.service.ts`
- Modify: `apps/gateway/src/gateway.service.ts`
- Modify: `apps/worker/src/worker.service.ts`
- Modify: `test/gateway/gateway.service.test.ts`

**Interfaces:**
- Produces: `ChannelModel.id: UUID`、`ChannelModelCostRule`、`ChannelModelProbe`、`UsageLog.channelModelId`、`UsageLog.channelCostRuleId`、`UsageLog.costSnapshot`。

- [ ] **Step 1: 在 Prisma schema 中把 `ChannelAbility` 升级为有独立 ID 的 `ChannelModel`**

```prisma
enum ModelHealthStatus {
  UNKNOWN
  HEALTHY
  DEGRADED
  UNHEALTHY
  DISABLED
}

model ChannelModel {
  id                  String            @id @default(uuid()) @db.Uuid
  channelId           String            @map("channel_id") @db.Uuid
  publicModelId       String            @map("public_model_id")
  upstreamModel       String            @map("upstream_model")
  protocol            GatewayProtocol
  supportsStream      Boolean           @default(true) @map("supports_stream")
  supportsTools       Boolean           @default(true) @map("supports_tools")
  enabled             Boolean           @default(true)
  health              ModelHealthStatus @default(UNKNOWN)
  consecutiveFailures Int               @default(0) @map("consecutive_failures")
  probeEnabled        Boolean           @default(true) @map("probe_enabled")
  probeIntervalMinutes Int              @default(15) @map("probe_interval_minutes")
  lastTestedAt        DateTime?         @map("last_tested_at")
  lastSuccessAt       DateTime?         @map("last_success_at")
  lastErrorCode       String?           @map("last_error_code")
  channel             Channel           @relation(fields: [channelId], references: [id], onDelete: Cascade)
  publicModel         PublicModel       @relation(fields: [publicModelId], references: [id], onDelete: Cascade)
  costRules           ChannelModelCostRule[]
  probes              ChannelModelProbe[]
  logs                UsageLog[]

  @@unique([channelId, publicModelId, protocol])
  @@index([publicModelId, protocol, enabled, health])
  @@map("channel_models")
}
```

- [ ] **Step 2: 增加成本规则、探测和用量快照模型**

```prisma
model ChannelModelCostRule {
  id                  String       @id @default(uuid()) @db.Uuid
  channelModelId      String       @map("channel_model_id") @db.Uuid
  name                String
  daysOfWeek          Int[]        @map("days_of_week")
  startMinute         Int          @map("start_minute")
  endMinute           Int          @map("end_minute")
  priority            Int          @default(0)
  inputPerMillion     Decimal      @map("input_per_million") @db.Decimal(20, 8)
  outputPerMillion    Decimal      @map("output_per_million") @db.Decimal(20, 8)
  cachedPerMillion    Decimal      @default(0) @map("cached_per_million") @db.Decimal(20, 8)
  reasoningPerMillion Decimal      @default(0) @map("reasoning_per_million") @db.Decimal(20, 8)
  currency            String       @default("USD")
  enabled             Boolean      @default(true)
  validFrom           DateTime     @map("valid_from")
  validUntil          DateTime?    @map("valid_until")
  createdAt           DateTime     @default(now()) @map("created_at")
  channelModel        ChannelModel @relation(fields: [channelModelId], references: [id], onDelete: Cascade)
  logs                UsageLog[]

  @@index([channelModelId, enabled, validFrom])
  @@map("channel_model_cost_rules")
}

model ChannelModelProbe {
  id             String            @id @default(uuid()) @db.Uuid
  channelModelId String            @map("channel_model_id") @db.Uuid
  source         String
  health         ModelHealthStatus
  statusCode     Int?              @map("status_code")
  latencyMs      Int               @map("latency_ms")
  firstTokenMs   Int?              @map("first_token_ms")
  errorCode      String?           @map("error_code")
  keySuffix      String?           @map("key_suffix")
  testedAt       DateTime          @default(now()) @map("tested_at")
  channelModel   ChannelModel      @relation(fields: [channelModelId], references: [id], onDelete: Cascade)

  @@index([channelModelId, testedAt])
  @@map("channel_model_probes")
}
```

同时给 `Channel` 增加 `costTimezone String @default("UTC") @map("cost_timezone")`；给 `UsageLog` 增加可空的 `channelModelId`、`channelCostRuleId` 和 `costSnapshot Json?` 及对应关系和索引。`channelCostRule` 关系必须使用 `onDelete: SetNull`，确保停用或清理规则不会删除历史用量。

- [ ] **Step 3: 写兼容迁移并回填现有映射**

迁移必须按以下顺序执行：重命名 `channel_abilities` 为 `channel_models`；新增可空 `id`；为每行写入 `gen_random_uuid()`；改为非空主键；把旧复合主键改为唯一约束；新增健康字段并用所属 `channels.health` 映射回填；新增成本/探测表；给 `usage_logs` 添加可空列和 `[organizationId, startedAt, channelId/publicModelId/accountId/channelModelId]` 四组统计索引。现有 `model_price_versions` 和 `usage_logs.cost_usd` 不删除，二者在新版中明确解释为采购成本兼容字段。

- [ ] **Step 4: 机械改名 Prisma 调用并验证迁移**

把 `prisma.channelAbility` 统一改成 `prisma.channelModel`，把 include/select 中的 `abilities` 关系统一改成 `channelModels`；同步修改 `PublicModel` 和 `Channel` 的关系字段及测试 fixture。先运行 `rg -n "channelAbility|abilities" apps packages test prisma`，逐项确认没有把普通中文或无关变量误改。

Run: `npm run db:generate && npm run db:migrate && npm run typecheck`

Expected: 迁移成功，现有渠道模型数量不变，`rg -n "prisma\.channelAbility" apps packages test` 无结果，类型检查通过。

- [ ] **Step 5: Commit**

```powershell
git add prisma/schema.prisma prisma/migrations/202608200001_channel_model_operations apps/api/src/models.controller.ts apps/api/src/channels.service.ts apps/gateway/src/gateway.service.ts apps/worker/src/worker.service.ts test/gateway/gateway.service.test.ts
git commit -m "feat: 建立渠道模型健康与分时成本数据模型"
```

### Task 2: 实现分时成本匹配与健康状态纯函数

**Files:**
- Create: `packages/gateway-core/src/cost-schedule.ts`
- Create: `packages/gateway-core/src/model-health.ts`
- Create: `test/gateway/cost-schedule.test.ts`
- Create: `test/gateway/model-health.test.ts`

**Interfaces:**
- Produces: `resolveChannelCost(rules, at, timezone): ResolvedCost | null`。
- Produces: `highestReservationCost(costs): PriceSnapshot | null`；沿用现有 `PriceSnapshot` 名称仅为兼容 `cost.ts`，语义是采购单价快照。
- Produces: `nextModelHealth(current, outcome): ModelHealthTransition`。

- [ ] **Step 1: 先写成本匹配失败测试**

```ts
it('uses the peak rule in Asia/Shanghai and the base rule outside it', () => {
  expect(resolveChannelCost(rules, new Date('2026-08-20T12:30:00Z'), 'Asia/Shanghai')?.id).toBe('peak')
  expect(resolveChannelCost(rules, new Date('2026-08-20T15:30:00Z'), 'Asia/Shanghai')?.id).toBe('base')
})

it('matches a cross-midnight rule on both sides of midnight', () => {
  expect(resolveChannelCost(nightRules, new Date('2026-08-21T15:00:00Z'), 'Asia/Shanghai')?.id).toBe('night')
  expect(resolveChannelCost(nightRules, new Date('2026-08-21T18:00:00Z'), 'Asia/Shanghai')?.id).toBe('night')
})
```

- [ ] **Step 2: 实现精确接口**

```ts
export interface ScheduledCost extends PriceSnapshot {
  id: string
  priority: number
  daysOfWeek: number[]
  startMinute: number
  endMinute: number
  validFrom: Date
  validUntil: Date | null
  enabled: boolean
  currency: 'USD'
}

export interface ResolvedCost extends PriceSnapshot {
  id: string
  currency: 'USD'
  source: 'CHANNEL_RULE'
}

export function resolveChannelCost(
  rules: ScheduledCost[], at: Date, timezone: string
): ResolvedCost | null
```

使用 `Intl.DateTimeFormat` 获取目标时区的 ISO 星期、小时和分钟；不得依赖服务器本地时区。输入校验拒绝非法 IANA 时区、星期不在 1–7、分钟不在 0–1439、负成本和非 USD 币种。

- [ ] **Step 3: 写健康转换测试并实现状态机**

```ts
export type ProbeOutcome = { ok: true } | { ok: false; terminal: boolean; errorCode: string }
export interface ModelHealthTransition {
  health: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  consecutiveFailures: number
  lastErrorCode: string | null
}

export function nextModelHealth(
  current: { consecutiveFailures: number }, outcome: ProbeOutcome
): ModelHealthTransition
```

测试成功清零、普通错误第 1/2/3 次转换，以及 terminal 错误第一次直接 `UNHEALTHY`。

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/gateway/cost-schedule.test.ts test/gateway/model-health.test.ts`

Expected: 两个文件全部通过，跨午夜和时区断言通过。

- [ ] **Step 5: Commit**

```powershell
git add packages/gateway-core/src/cost-schedule.ts packages/gateway-core/src/model-health.ts test/gateway
git commit -m "feat: 增加分时采购成本解析与模型健康状态机"
```

### Task 3: 建立类型安全的渠道与渠道模型管理 API

**Files:**
- Create: `apps/api/src/catalog.dto.ts`
- Create: `apps/api/src/channel-models.controller.ts`
- Create: `apps/api/src/channel-models.service.ts`
- Modify: `apps/api/src/channels.controller.ts`
- Modify: `apps/api/src/channels.service.ts`
- Modify: `apps/api/src/models.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `test/catalog/channel-models.service.test.ts`

**Interfaces:**
- Produces: 渠道摘要/详情、渠道模型 CRUD、模型发现、成本规则 CRUD、探测历史接口。
- Consumes: Task 1 的 Prisma 模型和 Task 2 的成本校验。

- [ ] **Step 1: 为以下路由编写 service 失败测试**

```text
GET    /api/v1/admin/channels?q=&provider=&protocol=&health=&enabled=&limit=50&offset=0
GET    /api/v1/admin/channels/:id
POST   /api/v1/admin/channels/:id/discover-models
GET    /api/v1/admin/channels/:id/models
POST   /api/v1/admin/channels/:id/models
PATCH  /api/v1/admin/channel-models/:id
DELETE /api/v1/admin/channel-models/:id
GET    /api/v1/admin/channel-models/:id/cost-rules
POST   /api/v1/admin/channel-models/:id/cost-rules
PATCH  /api/v1/admin/channel-model-cost-rules/:id
DELETE /api/v1/admin/channel-model-cost-rules/:id
GET    /api/v1/admin/channel-models/:id/probes?limit=50&offset=0
```

断言渠道列表返回 `{items,total,limit,offset}`，渠道详情不返回 `ciphertext/iv/tag`，删除已产生用量的渠道模型时只设 `enabled=false, health=DISABLED`。

- [ ] **Step 2: 定义 DTO 并启用入口校验**

```ts
export class CreateChannelModelDto {
  @IsString() @IsNotEmpty() publicModelId!: string
  @IsString() @IsNotEmpty() upstreamModel!: string
  @IsEnum(GatewayProtocol) protocol!: GatewayProtocol
  @IsBoolean() supportsStream = true
  @IsBoolean() supportsTools = true
  @IsBoolean() probeEnabled = true
  @IsInt() @Min(5) @Max(1440) probeIntervalMinutes = 15
}

export class CreateCostRuleDto {
  @IsString() @Length(1, 80) name!: string
  @IsArray() @ArrayNotEmpty() daysOfWeek!: number[]
  @IsInt() @Min(0) @Max(1439) startMinute!: number
  @IsInt() @Min(0) @Max(1439) endMinute!: number
  @IsInt() @Min(0) @Max(1000) priority = 0
  @IsNumberString() inputPerMillion!: string
  @IsNumberString() outputPerMillion!: string
  @IsNumberString() cachedPerMillion = '0'
  @IsNumberString() reasoningPerMillion = '0'
  @IsISO8601() validFrom!: string
  @IsOptional() @IsISO8601() validUntil?: string
}
```

- [ ] **Step 3: 实现服务事务和冲突校验**

`createCostRule` 在事务中锁定同一 `channelModelId` 的规则，调用共享的区间重叠判断；冲突返回 409，并在响应中列出冲突规则 ID 和名称。`discover-models` 使用渠道协议对应的 models endpoint 和已启用 Key，返回 `{upstreamModel, alreadyMapped}`，不得自动写数据库。

- [ ] **Step 4: 改造公共模型发布检查**

`POST /api/v1/admin/models/:id/publish-check` 返回：

```ts
interface PublishCheck {
  ready: boolean
  healthyChannelModels: number
  hasCurrentCost: boolean
  blockers: Array<'NO_HEALTHY_CHANNEL_MODEL' | 'NO_CURRENT_COST' | 'LATEST_TEST_FAILED'>
}
```

`publish` 必须复用同一检查，并用 400 返回 `blockers`，避免前后端规则分叉。

- [ ] **Step 5: Run and commit**

Run: `npx vitest run test/catalog/channel-models.service.test.ts && npm run typecheck`

```powershell
git add apps/api/src test/catalog
git commit -m "feat: 提供渠道模型与采购成本规则管理接口"
```

### Task 4: 重构渠道和公共模型后台交互

**Files:**
- Create: `apps/admin/src/types/catalog.ts`
- Create: `apps/admin/src/components/StatusBadge.vue`
- Create: `apps/admin/src/components/Drawer.vue`
- Create: `apps/admin/src/components/ConfirmDialog.vue`
- Create: `apps/admin/src/components/Pagination.vue`
- Create: `apps/admin/src/components/CostScheduleEditor.vue`
- Rewrite: `apps/admin/src/views/Channels.vue`
- Create: `apps/admin/src/views/ChannelDetail.vue`
- Rewrite: `apps/admin/src/views/Models.vue`
- Create: `apps/admin/src/views/ModelDetail.vue`
- Modify: `apps/admin/src/main.ts`
- Modify: `apps/admin/src/styles.css`
- Modify: `apps/admin/src/forms.css`

**Interfaces:**
- Consumes: Task 3 的分页、详情、发布检查、渠道模型和成本规则接口。
- Produces: 可维护的列表—详情工作流。

- [ ] **Step 1: 定义前端响应类型并移除目录页面的 `any`**

```ts
export interface ChannelSummary {
  id: string
  name: string
  provider: string
  protocol: 'OPENAI' | 'ANTHROPIC' | 'GEMINI'
  enabled: boolean
  health: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'DISABLED'
  availableKeys: number
  healthyModels: number
  modelCount: number
  lastTestedAt: string | null
  usage24h: { requests: number; successRate: number; p95LatencyMs: number | null }
}
```

同时定义 `ChannelDetail`、`ChannelModel`、`CostRule`、`Page<T>`；`Channels.vue` 和 `Models.vue` 不再使用 `ref<any[]>`。

- [ ] **Step 2: 实现渠道列表和新建抽屉**

筛选条件写入 URL query，返回列表后保持分页位置。启停操作使用确认对话框；行点击进入 `/channels/:id`；只有“刷新、创建渠道、批量测试”放在页头，避免每行堆叠输入框。

- [ ] **Step 3: 实现渠道详情页五个页签**

“渠道模型”页签使用独立表格：公共模型、上游模型、协议、能力、健康、当前采购成本、最近测试、操作。新增/编辑都在抽屉；“发现模型”先预览差异，再勾选创建；Key 页只显示后四位、健康、余额、到期时间和启停，不展示密文。

- [ ] **Step 4: 实现采购成本时间表编辑器**

编辑器包含规则名、星期按钮、开始/结束时间、优先级、四类 Token 采购单价、有效日期和启用状态。底部显示 7×24 时间带，基础成本用灰色，高峰成本用橙色，冲突用红色；保存前调用服务端预校验，不能仅依靠颜色提示。

- [ ] **Step 5: 实现公共模型列表/详情与构建验证**

公共模型列表展示健康映射数量和采购成本区间；详情页在发布按钮旁展示 `PublishCheck.blockers` 的中文解释。

Run: `npm run admin:build && npm run typecheck`

```powershell
git add apps/admin/src
git commit -m "feat: 重构渠道与模型维护工作台"
```

### Task 5: 实现模型级自动探测和手工批量测试

**Files:**
- Create: `apps/api/src/model-testing.service.ts`
- Modify: `apps/api/src/channel-models.controller.ts`
- Modify: `apps/worker/src/worker.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `test/catalog/model-testing.service.test.ts`
- Modify: `apps/admin/src/views/ChannelDetail.vue`

**Interfaces:**
- Produces: `testChannelModel(id, input, actorId, source): Promise<ModelTestResult>`。
- Produces: 单模型测试、最多 20 个模型的并发 3 批量测试、探测历史。
- Consumes: Task 2 的健康状态机。

- [ ] **Step 1: 写协议无关的测试结果契约和失败测试**

```ts
export interface ModelTestResult {
  channelModelId: string
  ok: boolean
  statusCode: number
  latencyMs: number
  firstTokenMs: number | null
  inputTokens: number
  outputTokens: number
  keySuffix: string | null
  errorCode: string | null
  health: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
}
```

覆盖 OpenAI、Anthropic、Gemini 成功；401 终止错误；429/5xx 累计失败；超时；测试后写 `ChannelModelProbe` 但不写 prompt/response。

- [ ] **Step 2: 实现固定渠道模型探测**

探测内容固定为 system=`You are a health check.`、user=`Reply OK.`、`max_tokens=1`、temperature=0。使用 `relayRequest({ candidates: [selectedCandidate] })`，禁止候选切换；从已启用、非隔离 Key 中按渠道策略选 Key。

- [ ] **Step 3: 增加手工测试与批量测试路由**

```text
POST /api/v1/admin/channel-models/:id/test
POST /api/v1/admin/channels/:id/models/test-batch
GET  /api/v1/admin/channel-models/:id/probes
```

批量请求 body 为 `{channelModelIds: string[]}`，最多 20 个且必须属于路径渠道；返回每个模型独立结果，一个失败不能中断整批。

- [ ] **Step 4: 改造 Worker 定时任务**

保留每 5 分钟渠道连接探测；新增每分钟扫描 `probeEnabled=true` 且 `lastTestedAt + probeIntervalMinutes <= now` 的模型，单次取 30 条，以并发 3 执行。每天 03:10 删除 30 天前的 `ChannelModelProbe`。

- [ ] **Step 5: Run and commit**

Run: `npx vitest run test/catalog/model-testing.service.test.ts && npm run build`

```powershell
git add apps/api/src apps/worker/src test/catalog
git commit -m "feat: 增加渠道模型探测与批量健康测试"
```

### Task 6: 让网关按实际渠道模型的分时采购成本核算

**Files:**
- Modify: `packages/gateway-core/src/relay.ts`
- Modify: `apps/gateway/src/gateway.service.ts`
- Modify: `test/gateway/gateway.service.test.ts`
- Modify: `test/gateway/cost.test.ts`

**Interfaces:**
- Consumes: `resolveChannelCost`、`highestReservationCost`、`ChannelModelCostRule`。
- Produces: 每条成功用量的 `channelModelId`、`channelCostRuleId`、`costSnapshot` 和不可变采购成本 `costUsd`。

- [ ] **Step 1: 写网关定价失败测试**

新增以下断言：高峰时命中高峰成本规则；非高峰命中基础成本规则；渠道无规则时使用 `ModelPriceVersion` 兼容成本；多候选预留使用最高采购成本；最终核算使用实际成功候选成本；日志固化四类采购单价与时区。

- [ ] **Step 2: 扩展候选类型**

```ts
export interface RelayCandidate {
  channelId: string
  channelModelId: string
  keyId: string
  baseUrl: string
  apiKey: string
  upstreamModel: string
  protocol: GatewayProtocol
  maxRetries: number
  timeoutMs: number
  cost: ResolvedCost
}
```

`ResolvedCost` 包含 `source: 'CHANNEL_COST_RULE' | 'PUBLIC_MODEL_FALLBACK'`、规则/版本 ID、四类采购单价、currency、timezone 和 `resolvedAt`。

- [ ] **Step 3: 调整成本配额预留与实际核算顺序**

构建 candidates 时解析每个渠道模型的当前成本规则；没有渠道规则时附上公共模型兼容兜底成本；没有任何成本的候选不进入路由。成本配额预留使用 candidates 中每类 Token 的最高采购单价，成功后使用 `result.candidate.cost` 计算真实采购成本并 settle，多预留差额由现有 settle 语义释放。这里的配额是公司内部成本预算控制，不是用户收费。

- [ ] **Step 4: 固化用量成本信息**

```ts
costSnapshot: {
  source: result.candidate.cost.source,
  inputPerMillion: result.candidate.cost.inputPerMillion,
  outputPerMillion: result.candidate.cost.outputPerMillion,
  cachedPerMillion: result.candidate.cost.cachedPerMillion,
  reasoningPerMillion: result.candidate.cost.reasoningPerMillion,
  currency: 'USD',
  timezone: result.candidate.cost.timezone,
  resolvedAt: startedAt.toISOString()
}
```

失败请求保留第一个实际尝试的 `channelModelId`，没有 Token 用量时采购成本为 0。

- [ ] **Step 5: Run and commit**

Run: `npx vitest run test/gateway/gateway.service.test.ts test/gateway/cost.test.ts test/gateway/cost-schedule.test.ts`

```powershell
git add apps/gateway/src packages/gateway-core/src test/gateway
git commit -m "feat: 按渠道模型分时规则核算采购成本"
```

### Task 7: 增加独立模型对话测试台

**Files:**
- Create: `apps/api/src/model-testing.controller.ts`
- Modify: `apps/api/src/model-testing.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/admin/src/views/ModelTest.vue`
- Modify: `apps/admin/src/main.ts`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/types/catalog.ts`
- Create: `test/catalog/model-test-controller.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/admin/model-tests` 和 `POST /api/v1/admin/model-tests/stream`。
- Consumes: 固定 `channelModelId`、浏览器提交的消息数组和 Task 6 的采购成本解析。

- [ ] **Step 1: 写隐私与固定路由测试**

断言只有 PLATFORM_ADMIN 可调用；请求必须包含所选 `channelModelId`；服务只创建 `ChannelModelProbe` 元数据，不创建 `UsageLog`，不把 messages 写入日志；测试失败不会切到其他渠道模型。

- [ ] **Step 2: 定义请求与响应**

```ts
interface AdminModelTestRequest {
  channelModelId: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature: number
  maxTokens: number
  keyId?: string
}

interface AdminModelTestResponse extends ModelTestResult {
  assistantMessage: string
  rawResponse: unknown
  appliedCost: ResolvedCost
  estimatedProcurementCostUsd: string
}
```

messages 最多 50 条，单条最多 20,000 字符，总计最多 100,000 字符；temperature 为 0–2，maxTokens 为 1–8192；`keyId` 必须属于渠道且只返回 suffix。

- [ ] **Step 3: 实现 SSE 路由**

SSE 只发 `delta`、`metrics`、`done`、`error` 四种事件；`metrics` 在结束时包含 Token、采购单价、采购成本和延迟。客户端断开时 AbortController 取消上游请求，不把中断视为渠道故障。

- [ ] **Step 4: 实现测试台 UI**

左栏选择渠道、渠道模型、Key 和参数；中栏为多轮消息；右栏显示状态与原始 JSON。每次发送把当前浏览器内存中的完整消息列表提交；“清空”同时清空消息、原始响应和指标。页面顶部明确标注“固定渠道测试，不走故障切换；消息不会持久化”。

- [ ] **Step 5: Run and commit**

Run: `npx vitest run test/catalog/model-test-controller.test.ts && npm run admin:build`

```powershell
git add apps/api/src apps/admin/src test/catalog
git commit -m "feat: 增加固定渠道模型对话测试台"
```

### Task 8: 建立统计分析查询 API

**Files:**
- Create: `packages/usage/src/analytics-types.ts`
- Create: `apps/api/src/analytics.controller.ts`
- Create: `apps/api/src/analytics.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `test/analytics/analytics.service.test.ts`

**Interfaces:**
- Produces: overview、timeseries、breakdown、filter-options 四个只读接口。
- Consumes: `UsageLog` 的渠道模型、成本快照、账户和时间字段。

- [ ] **Step 1: 验证统计索引并写权限范围测试**

确认 Task 1 已生成 `[organizationId, startedAt, channelId]`、`[organizationId, startedAt, publicModelId]`、`[organizationId, startedAt, accountId]`、`[organizationId, startedAt, channelModelId]` 四组索引。测试 PLATFORM_ADMIN 可选组织、ORG_ADMIN 强制本组织、MEMBER 强制本账号。

- [ ] **Step 2: 定义统一过滤器和输出类型**

```ts
export interface AnalyticsFilter {
  start: Date
  end: Date
  organizationId?: string
  accountId?: string
  channelId?: string
  publicModelId?: string
  channelModelId?: string
}

export interface AnalyticsOverview {
  requests: number
  successRate: number
  activeAccounts: number
  inputTokens: string
  outputTokens: string
  costUsd: string
  avgCostPerRequestUsd: string
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  p50FirstTokenMs: number | null
  p95FirstTokenMs: number | null
  failoverRate: number
}
```

- [ ] **Step 3: 实现四组 API**

```text
GET /api/v1/analytics/overview
GET /api/v1/analytics/timeseries?interval=hour|day
GET /api/v1/analytics/breakdown?dimension=organization|channel|model|channelModel|account|costRule&sort=costUsd&order=desc&limit=50&offset=0
GET /api/v1/analytics/filter-options
```

所有接口接受同一过滤参数；`end-start` 最大 90 天；小时粒度最大 31 天。维度和排序字段必须走固定 allowlist 后映射到 `Prisma.sql`，不得拼接用户原始字符串。

- [ ] **Step 4: 使用 PostgreSQL 聚合而非加载全部日志**

overview 用 `COUNT/SUM/AVG/percentile_cont`；timeseries 用 `date_trunc`；breakdown 根据 allowlist 选择固定 SQL 模板并关联组织、渠道、公共模型、渠道模型、账户和成本规则名称。组织维度只对 PLATFORM_ADMIN 展示；成本规则已删除时从 `costSnapshot.source` 显示“历史成本规则”。

- [ ] **Step 5: Run and commit**

Run: `npx vitest run test/analytics/analytics.service.test.ts && npm run typecheck`

```powershell
git add packages/usage/src apps/api/src prisma test/analytics
git commit -m "feat: 提供渠道模型采购成本与用户多维统计接口"
```

### Task 9: 实现统计分析后台页面

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `apps/admin/src/components/TrendChart.vue`
- Create: `apps/admin/src/views/Analytics.vue`
- Modify: `apps/admin/src/main.ts`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/types/catalog.ts`
- Modify: `apps/admin/src/styles.css`

**Interfaces:**
- Consumes: Task 8 的四组 API。
- Produces: 可筛选、可下钻的使用与采购成本分析界面。

- [ ] **Step 1: 安装图表依赖并检查许可证**

Run: `npm install echarts@^6.0.0 && npm run licenses:check`

Expected: ECharts 被记录在 lockfile，许可证门禁通过。

- [ ] **Step 2: 实现共享筛选区和指标卡**

默认近 7 天；预设切换立即刷新，自定义范围点击“应用”刷新。筛选选项显示名称而不是 UUID；筛选状态写入 URL query，刷新页面可恢复。并行请求用同一个递增 request token，丢弃较旧响应，避免快速切换时数据倒退。

- [ ] **Step 3: 实现趋势图**

使用按需导入的 LineChart、BarChart、Tooltip、Legend、Grid 和 CanvasRenderer。图表支持请求/Token/采购成本三种主指标切换，成功率用右轴；空数据展示统一空状态，组件卸载时 dispose。

- [ ] **Step 4: 实现四个维度表与下钻**

PLATFORM_ADMIN 显示组织/部门页签，所有有权限角色显示渠道、模型、用户、成本规则页签；支持请求、采购成本、Token、成功率、P95 排序。点击组织、渠道或模型行把该维度写回筛选器并刷新总览；成本页签明确展示规则名、时间段、加权平均输入/输出采购单价和总采购成本。

- [ ] **Step 5: Build and commit**

Run: `npm run admin:build && npm run typecheck && npm run licenses:check`

```powershell
git add package.json package-lock.json apps/admin/src
git commit -m "feat: 增加多维使用与采购成本统计分析页面"
```

### Task 10: 兼容性、性能、验收与交付

**Files:**
- Modify: `README.md`
- Modify: `docs/providers.md`
- Modify: `docs/acceptance.md`
- Create: `docs/screenshots/channel-list.png`
- Create: `docs/screenshots/channel-models.png`
- Create: `docs/screenshots/cost-schedule.png`
- Create: `docs/screenshots/model-test.png`
- Create: `docs/screenshots/analytics.png`

**Interfaces:**
- Consumes: Tasks 1–9 全部交付物。
- Produces: 可迁移、可回滚、可验收的发布版本。

- [ ] **Step 1: 执行数据库兼容性演练**

在开发库备份后执行迁移，记录迁移前后渠道模型、旧成本版本和用量日志数量；验证旧公共模型仍能通过网关请求。回滚策略是先部署兼容旧列的上一版本应用，再恢复迁移前数据库备份；本迁移不在运行中直接删除旧 `model_price_versions` 表或历史 `cost_usd` 列。

- [ ] **Step 2: 执行 API 与性能验收**

准备 100 个渠道、每渠道 100 个渠道模型、100 万条 UsageLog 的测试数据；要求渠道列表 P95 < 500ms、统计 overview P95 < 1s、breakdown P95 < 2s。若未达标，使用 `EXPLAIN (ANALYZE, BUFFERS)` 确认命中 Task 8 索引后再发布。

- [ ] **Step 3: 执行 Playwright 业务验收**

覆盖：创建渠道；添加 Key；发现并映射模型；添加基础采购成本和工作日 20:00–23:00 高峰成本；验证时间带无冲突；单模型和批量测试；测试台完成两轮对话；模拟高峰/非高峰请求并核对采购成本；统计页按渠道、模型、用户、成本规则下钻。

- [ ] **Step 4: 执行完整门禁并更新文档**

Run: `npm run verify`

Expected: typecheck、73 项既有测试和新增测试、覆盖率、后端构建、管理后台构建、许可证全部通过；新增页面截图写入验收报告。

- [ ] **Step 5: Commit**

```powershell
git add README.md docs
git commit -m "docs: 完成渠道模型运营能力验收与交付说明"
```

## 四、推荐交付顺序与验收门

1. **里程碑 A：目录可维护** — Tasks 1–4；运营人员可在渠道详情中维护渠道模型和成本规则，但网关仍可使用旧兜底成本。
2. **里程碑 B：状态可信** — Task 5；每个渠道模型有独立状态、历史和批量测试，发布检查使用模型级健康。
3. **里程碑 C：成本准确** — Task 6；高峰/非高峰实际请求按命中渠道模型核算采购成本，历史快照可追溯。
4. **里程碑 D：测试可操作** — Task 7；管理员可固定渠道模型做多轮对话与流式验证。
5. **里程碑 E：运营可分析** — Tasks 8–10；组织/部门、渠道、模型、成本规则、用户五个维度可统计、排序、下钻并通过完整验收。

每个里程碑都应单独评审和部署，不建议把五个里程碑压成一次大版本上线。

## 五、明确不在本阶段实现

- 不自动抓取供应商官网采购价格，也不引入汇率服务。
- 不维护用户销售价，不计算收入、回款、毛利或利润率；渠道模型规则只表示公司采购成本。
- 不保存测试台对话历史，不提供团队共享测试会话。
- 不基于采购成本自动改变路由权重；本阶段成本只参与预算控制、归集和分析，路由仍按优先级、权重和健康状态。
- 不引入跨区域多活探测；探测结果代表当前 Worker 所在网络环境。
- 不把运营报告页面删除；`/reports` 保留周期性归档报告，`/analytics` 负责交互式实时分析。

## 六、自检结果

- 需求覆盖：渠道维护、渠道模型维护、模型状态、单项/批量测试、峰谷采购成本、独立对话测试页、渠道/模型/成本/用户统计均有对应任务。
- 兼容性：保留公共模型和 `ModelPriceVersion` 作为成本兜底，迁移回填健康状态，现有 `costUsd` 不删除且统一解释为采购成本。
- 隐私：普通请求与测试对话均不持久化正文；探测表只保存状态和指标。
- 类型一致性：`channelModelId`、`channelCostRuleId`、`costSnapshot`、`ResolvedCost` 从 schema、网关、测试到分析沿用同一命名。
- 发布风险：数据库迁移、网关计价和统计查询分别有独立验收门，支持分阶段部署。

