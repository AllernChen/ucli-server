# 渠道模型智能绑定与厂家聚合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在渠道中按模型 ID 自动匹配已有公共模型或即时创建并绑定，支持后续重新绑定和编辑，同时在模型目录中按模型厂家聚合展示。

**Architecture:** 公共模型增加显式 `manufacturer` 和规范化 `manufacturerKey`，厂家来源由管理员确认而不是仅靠模型名称永久推断。新增独立 `ModelBindingService`，在一个 Prisma 事务中完成渠道/公共模型校验、可选公共模型创建、唯一映射检查及渠道模型创建或更新；管理端通过纯函数给出厂家建议和精确 ID 匹配，但后端仍做最终校验。模型目录保持现有扁平 API 响应，在 Vue 端按 `manufacturerKey` 分组，避免改动网关和用量统计协议。

**Tech Stack:** TypeScript、NestJS、Prisma/PostgreSQL、Vue 3、Vite、Vitest

## Global Constraints

- 平台用于公司内部 Token 管理，只展示和统计采购成本，不增加销售价格逻辑。
- 本计划构建在 `codex/catalog-full-management` 当前未提交改动之上，不覆盖上一批生命周期、归档恢复和运行时隔离实现。
- 公共模型厂家必须显式保存；模型 ID 推断和渠道 provider 只用于表单预填提示，管理员可以修改。
- `manufacturerKey` 由服务端统一生成：去除首尾空白、连续空白合并、转小写；展示使用 `manufacturer`。
- 新建和编辑渠道模型时，公共模型创建/匹配与渠道映射写入必须处于同一个数据库事务，失败不得留下孤立公共模型。
- 精确匹配公共模型 ID 时区分活动和归档：活动模型可绑定，归档模型提示先恢复，不得创建同 ID 记录。
- 编辑渠道模型允许修改上游模型 ID、协议、能力、探测配置以及重新绑定公共模型；恢复和历史统计语义保持不变。
- 现有 `POST /api/v1/admin/channels/:channelId/models` 保持兼容；新管理端使用新的 bind 接口。
- 不修改用户自有的 `docs/acceptance.md` 和 `docs/screenshots/`，不连接或修改生产环境。

---

## Task 1: 为公共模型增加厂家元数据

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/202608210003_public_model_manufacturer/migration.sql`
- Modify: `test/catalog/catalog-lifecycle-schema.test.ts`
- Create: `apps/api/src/model-manufacturer.ts`
- Create: `test/catalog/model-manufacturer.test.ts`
- Modify: `apps/api/src/catalog.dto.ts`
- Modify: `apps/api/src/models.service.ts`
- Modify: `test/catalog/models.service.test.ts`
- Modify: `test/catalog/catalog.dto.test.ts`

**Interfaces:**

- Produces: `normalizeManufacturer(value: string): { manufacturer: string; manufacturerKey: string }`
- Produces: every `PublicModel` response contains `manufacturer` and `manufacturerKey`.

- [ ] **Step 1: 写 Prisma DMMF 失败测试**

在现有 schema 测试中增加真实生成模型断言：

```ts
it('PublicModel exposes normalized manufacturer metadata', () => {
  const model = Prisma.dmmf.datamodel.models.find(candidate => candidate.name === 'PublicModel')
  expect(model?.fields.find(field => field.name === 'manufacturer')).toMatchObject({ type: 'String', isRequired: true })
  expect(model?.fields.find(field => field.name === 'manufacturerKey')).toMatchObject({ type: 'String', isRequired: true })
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `npm test -- test/catalog/catalog-lifecycle-schema.test.ts`

Expected: `manufacturer` 和 `manufacturerKey` 不存在而失败。

- [ ] **Step 3: 增加 Prisma 字段和索引**

```prisma
model PublicModel {
  // 保留现有字段
  manufacturer    String @default("未分类")
  manufacturerKey String @default("未分类") @map("manufacturer_key")

  @@index([manufacturerKey, deletedAt, enabled], map: "public_models_manufacturer_lifecycle_idx")
}
```

- [ ] **Step 4: 创建兼容现有数据的迁移**

```sql
ALTER TABLE "public_models"
  ADD COLUMN "manufacturer" TEXT NOT NULL DEFAULT '未分类',
  ADD COLUMN "manufacturer_key" TEXT NOT NULL DEFAULT '未分类';

UPDATE "public_models"
SET "manufacturer" = CASE
      WHEN lower("id") LIKE 'deepseek%' THEN 'DeepSeek'
      WHEN lower("id") LIKE 'claude%' THEN 'Anthropic'
      WHEN lower("id") LIKE 'gemini%' THEN 'Google'
      WHEN lower("id") LIKE 'gpt%' OR lower("id") ~ '^o[1-9]' THEN 'OpenAI'
      ELSE '未分类'
    END,
    "manufacturer_key" = CASE
      WHEN lower("id") LIKE 'deepseek%' THEN 'deepseek'
      WHEN lower("id") LIKE 'claude%' THEN 'anthropic'
      WHEN lower("id") LIKE 'gemini%' THEN 'google'
      WHEN lower("id") LIKE 'gpt%' OR lower("id") ~ '^o[1-9]' THEN 'openai'
      ELSE '未分类'
    END;

CREATE INDEX "public_models_manufacturer_lifecycle_idx"
  ON "public_models"("manufacturer_key", "deleted_at", "enabled");
```

- [ ] **Step 5: 写厂家规范化与 DTO 失败测试**

```ts
it('normalizes manufacturer whitespace and grouping key', () => {
  expect(normalizeManufacturer('  DeepSeek  AI  ')).toEqual({
    manufacturer: 'DeepSeek AI',
    manufacturerKey: 'deepseek ai'
  })
})

it('normalizes manufacturer whitespace and grouping key on create', async () => {
  const { service, state } = makeHarness({ noExistingModel: true })
  await service.create({ id: 'deepseek-v3', displayName: 'DeepSeek V3', manufacturer: '  DeepSeek  AI  ', contextSize: null })
  expect(state.model).toMatchObject({ manufacturer: 'DeepSeek AI', manufacturerKey: 'deepseek ai' })
})

it('requires manufacturer when creating a public model', async () => {
  const dto = Object.assign(new CreatePublicModelDto(), { id: 'deepseek-v3', displayName: 'DeepSeek V3' })
  expect((await validate(dto)).some(error => error.property === 'manufacturer')).toBe(true)
})
```

- [ ] **Step 6: 运行服务和 DTO 测试确认红灯**

Run: `npm test -- test/catalog/model-manufacturer.test.ts test/catalog/models.service.test.ts test/catalog/catalog.dto.test.ts`

Expected: create DTO 不接受 manufacturer，服务未写入规范化字段而失败。

- [ ] **Step 7: 实现 DTO 和服务端规范化**

在独立的 `model-manufacturer.ts` 中实现，避免绑定服务依赖整个模型目录服务：

```ts
export function normalizeManufacturer(value: string) {
  const manufacturer = value.trim().replace(/\s+/g, ' ')
  if (!manufacturer) throw new BadRequestException('Manufacturer is required')
  return { manufacturer, manufacturerKey: manufacturer.toLocaleLowerCase('en-US') }
}
```

`CreatePublicModelDto` 增加必填 `manufacturer`（1–100 字符），`UpdatePublicModelDto` 增加可选 `manufacturer`。在 `catalog.dto.ts` 的 `class-validator` import 中补充 Task 2 所需的 `ValidateIf`。`ModelsService.create/update` 从 `model-manufacturer.ts` 导入 `normalizeManufacturer`，并同时写入两个字段。

- [ ] **Step 8: 验证并自检**

Run: `npx prisma validate`

Run: `npm run db:generate`

Run: `npm test -- test/catalog/catalog-lifecycle-schema.test.ts test/catalog/model-manufacturer.test.ts test/catalog/models.service.test.ts test/catalog/catalog.dto.test.ts`

Expected: 全部 PASS。确认迁移不删除或重命名现有数据列。

---

## Task 2: 实现按模型 ID 匹配或创建的原子绑定服务

**Files:**

- Create: `apps/api/src/model-binding.service.ts`
- Modify: `apps/api/src/catalog.dto.ts`
- Modify: `apps/api/src/channel-models.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `test/catalog/model-binding.service.test.ts`
- Modify: `test/catalog/catalog.dto.test.ts`

**Interfaces:**

- Consumes: `normalizeManufacturer` from `apps/api/src/model-manufacturer.ts`.
- Produces: `ModelBindingService.bind(channelId, input)` and `ModelBindingService.rebind(channelModelId, input)`.
- Produces routes:
  - `POST /api/v1/admin/channels/:channelId/models/bind`
  - `PATCH /api/v1/admin/channel-models/:id/bind`

- [ ] **Step 1: 写绑定领域失败测试**

```ts
it('matches an active public model by exact id without creating another', async () => {
  const { service, calls } = makeHarness({ publicModelId: 'deepseek-v3' })
  const result = await service.bind(channelId, bindingInput({ publicModelId: 'deepseek-v3', createPublicModel: false }))
  expect(result.publicModelCreated).toBe(false)
  expect(result.channelModel.publicModelId).toBe('deepseek-v3')
  expect(calls.publicModelCreates).toBe(0)
})

it('creates and binds a missing public model in the same transaction', async () => {
  const { service, state } = makeHarness()
  const result = await service.bind(channelId, bindingInput({
    publicModelId: 'deepseek-r2', createPublicModel: true,
    publicModelDisplayName: 'DeepSeek R2', manufacturer: 'DeepSeek'
  }))
  expect(result).toMatchObject({ publicModelCreated: true, publicModel: { id: 'deepseek-r2', manufacturerKey: 'deepseek' } })
  expect(state.channelModels[0].publicModelId).toBe('deepseek-r2')
})

it('rolls back a newly created public model when mapping uniqueness fails', async () => {
  const { service, state } = makeHarness({ conflictingMapping: true })
  await expect(service.bind(channelId, bindingInput({
    publicModelId: 'deepseek-r2', createPublicModel: true,
    publicModelDisplayName: 'DeepSeek R2', manufacturer: 'DeepSeek'
  }))).rejects.toMatchObject({ status: 409 })
  expect(state.publicModels.some(model => model.id === 'deepseek-r2')).toBe(false)
})

it('rebinds an existing channel model to another active public model', async () => {
  const { service, state } = makeHarness({ publicModelId: 'deepseek-v3', secondPublicModelId: 'deepseek-r1' })
  await service.rebind(state.channelModels[0].id, bindingInput({ publicModelId: 'deepseek-r1', createPublicModel: false }))
  expect(state.channelModels[0]).toMatchObject({ publicModelId: 'deepseek-r1', upstreamModel: 'deepseek-reasoner' })
})
```

再增加：渠道归档返回 404、公共模型归档返回 409、`createPublicModel=true` 但 ID 已存在返回 409、编辑时唯一映射冲突返回 409、事务失败无孤立数据。

- [ ] **Step 2: 运行领域测试确认红灯**

Run: `npm test -- test/catalog/model-binding.service.test.ts`

Expected: `ModelBindingService` 不存在而失败。

- [ ] **Step 3: 增加绑定 DTO**

```ts
export class BindChannelModelDto {
  @IsString() @Length(1, 200) publicModelId!: string
  @IsOptional() @IsBoolean() createPublicModel = false
  @ValidateIf(value => value.createPublicModel) @IsString() @Length(1, 200) publicModelDisplayName?: string
  @ValidateIf(value => value.createPublicModel) @IsString() @Length(1, 100) manufacturer?: string
  @IsOptional() @IsInt() @Min(1) contextSize?: number | null
  @IsString() @Length(1, 300) upstreamModel!: string
  @IsEnum(GatewayProtocol) protocol!: GatewayProtocol
  @IsOptional() @IsBoolean() supportsStream = true
  @IsOptional() @IsBoolean() supportsTools = true
  @IsOptional() @IsBoolean() probeEnabled = true
  @IsOptional() @IsInt() @Min(5) @Max(1440) probeIntervalMinutes = 15
}
```

DTO 测试必须验证 create 模式缺少显示名/厂家失败，match 模式不要求创建字段。

- [ ] **Step 4: 实现事务服务**

```ts
@Injectable()
export class ModelBindingService {
  constructor(private readonly prisma: PrismaService) {}

  bind(channelId: string, input: BindChannelModelDto) {
    return this.prisma.$transaction(tx => this.persist(tx, { channelId, input }))
  }

  rebind(channelModelId: string, input: BindChannelModelDto) {
    return this.prisma.$transaction(tx => this.persist(tx, { channelModelId, input }))
  }
}
```

`persist` 的固定顺序：读取活动渠道和编辑目标 → 解析或创建公共模型 → 检查包含归档项的唯一映射 → create/update 渠道模型 → 返回 `{ publicModelCreated, publicModel, channelModel }`。编辑成功后健康状态重置为 `UNKNOWN`，`lastTestedAt/lastSuccessAt/lastErrorCode` 清空，防止沿用旧上游模型健康结论。

- [ ] **Step 5: 暴露控制器路由并注册服务**

```ts
@Post('channels/:channelId/models/bind')
bind(@Param('channelId', UuidPipe) channelId: string, @Body() body: BindChannelModelDto) {
  return this.modelBinding.bind(channelId, body)
}

@Patch('channel-models/:id/bind')
rebind(@Param('id', UuidPipe) id: string, @Body() body: BindChannelModelDto) {
  return this.modelBinding.rebind(id, body)
}
```

`AppModule` providers 增加 `ModelBindingService`，`ChannelModelsController` 构造函数注入该服务。

- [ ] **Step 6: 验证并自检**

Run: `npm test -- test/catalog/model-binding.service.test.ts test/catalog/catalog.dto.test.ts test/catalog/channel-models.service.test.ts`

Expected: 全部 PASS。自检 Prisma 调用中没有在事务外创建公共模型；归档映射不能被重复创建绕过。

---

## Task 3: 优化渠道模型绑定与编辑交互

**Files:**

- Create: `apps/admin/src/model-binding.ts`
- Create: `test/admin/model-binding.test.ts`
- Modify: `apps/admin/src/types/catalog.ts`
- Modify: `apps/admin/src/views/ChannelDetail.vue`

**Interfaces:**

- Consumes: bind/rebind routes from Task 2.
- Produces: `exactPublicModelMatch`, `suggestManufacturer`, `bindingModeForId` pure helpers.

- [ ] **Step 1: 写管理端匹配纯函数失败测试**

```ts
it('matches an existing public model by its exact trimmed id', () => {
  expect(exactPublicModelMatch(' deepseek-v3 ', [model('deepseek-v3'), model('deepseek-r1')])?.id).toBe('deepseek-v3')
})

it('switches to create mode when no exact id exists', () => {
  expect(bindingModeForId('deepseek-r2', [model('deepseek-v3')])).toBe('CREATE')
})

it.each([
  ['deepseek-chat', 'openrouter', 'DeepSeek'],
  ['claude-4-sonnet', 'aws-bedrock', 'Anthropic'],
  ['custom-model', 'acme-ai', 'acme-ai']
])('suggests manufacturer for %s', (id, provider, expected) => {
  expect(suggestManufacturer(id, provider)).toBe(expected)
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `npm test -- test/admin/model-binding.test.ts`

Expected: helper 模块不存在而失败。

- [ ] **Step 3: 实现匹配和建议函数**

```ts
export function exactPublicModelMatch(id: string, models: PublicModel[]) {
  const key = id.trim()
  return models.find(model => model.id === key && !model.deletedAt) || null
}

export function bindingModeForId(id: string, models: PublicModel[]) {
  return exactPublicModelMatch(id, models) ? 'EXISTING' as const : 'CREATE' as const
}
```

模型 ID 匹配与数据库主键语义一致，区分大小写；不擅自改写上游 ID。`suggestManufacturer` 仅作为预填：deepseek → DeepSeek、claude → Anthropic、gemini → Google、gpt/o1–o9 → OpenAI，否则返回当前渠道 provider。

- [ ] **Step 4: 重做渠道模型 Drawer**

交互顺序：

1. 输入“上游模型 ID”。
2. 实时显示“已匹配平台模型：显示名 / ID / 厂家”，或“平台中不存在，将创建新公共模型”。
3. 匹配时允许从候选下拉切换其他公共模型；创建时显示“平台模型 ID、显示名称、厂家、上下文长度”。
4. 添加调用 `POST .../models/bind`；编辑调用 `PATCH .../channel-models/:id/bind`。
5. 编辑 Drawer 回填当前公共模型，并允许重新绑定；保存成功提示是否创建了新公共模型。

请求体固定为：

```ts
{
  publicModelId,
  createPublicModel: bindingMode === 'CREATE',
  publicModelDisplayName: bindingMode === 'CREATE' ? displayName : undefined,
  manufacturer: bindingMode === 'CREATE' ? manufacturer : undefined,
  contextSize: bindingMode === 'CREATE' ? contextSize : undefined,
  upstreamModel,
  protocol,
  supportsStream,
  supportsTools,
  probeEnabled,
  probeIntervalMinutes
}
```

- [ ] **Step 5: 保持发现模型流程连贯**

点击上游发现结果时，把 `upstreamModel` 填入 Drawer 并立即执行精确匹配；存在公共模型则进入 EXISTING，不存在则进入 CREATE 并预填厂家。不得自动提交创建。

- [ ] **Step 6: 验证并自检**

Run: `npm test -- test/admin/model-binding.test.ts test/admin/catalog-lifecycle.test.ts`

Run: `npm run admin:build`

Expected: 全部 PASS。自检添加与编辑共用同一请求生成逻辑，厂家字段在创建模式可见且可修改。

---

## Task 4: 模型目录按厂家聚合并支持厂家编辑

**Files:**

- Create: `apps/admin/src/model-groups.ts`
- Create: `test/admin/model-groups.test.ts`
- Modify: `apps/admin/src/types/catalog.ts`
- Modify: `apps/admin/src/views/Models.vue`
- Modify: `apps/admin/src/views/ModelDetail.vue`

**Interfaces:**

- Consumes: `manufacturer` and `manufacturerKey` from Task 1 API responses.
- Produces: `groupModelsByManufacturer(models)` returning manufacturer summary groups.

- [ ] **Step 1: 写厂家聚合失败测试**

```ts
it('groups two DeepSeek models under one manufacturer and totals usage', () => {
  const groups = groupModelsByManufacturer([
    model({ id: 'deepseek-v3', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek', requests: 10, costUsd: '1.25' }),
    model({ id: 'deepseek-r1', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek', requests: 5, costUsd: '0.75' })
  ])
  expect(groups).toEqual([expect.objectContaining({
    key: 'deepseek', name: 'DeepSeek', modelCount: 2, requests24h: 15, costUsd24h: '2.00000000'
  })])
})

it('keeps different manufacturer keys in separate deterministic groups', () => {
  const groups = groupModelsByManufacturer([
    model({ id: 'deepseek-v3', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek' }),
    model({ id: 'claude-sonnet', manufacturer: 'Anthropic', manufacturerKey: 'anthropic' })
  ])
  expect(groups.map(group => group.key)).toEqual(['anthropic', 'deepseek'])
})
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `npm test -- test/admin/model-groups.test.ts`

Expected: group 模块不存在而失败。

- [ ] **Step 3: 实现确定性聚合**

```ts
export interface ManufacturerModelGroup {
  key: string
  name: string
  models: PublicModel[]
  modelCount: number
  publishedCount: number
  channelModelCount: number
  requests24h: number
  tokens24h: number
  costUsd24h: string
}
```

采购成本使用固定 8 位小数的十进制定点加法，禁止用二进制浮点汇总：

```ts
const COST_SCALE = 8

export function sumCostDecimals(values: string[]): string {
  const total = values.reduce((sum, value) => {
    const [whole = '0', fraction = ''] = value.split('.')
    const units = BigInt(whole) * 10n ** BigInt(COST_SCALE)
      + BigInt(fraction.padEnd(COST_SCALE, '0').slice(0, COST_SCALE))
    return sum + units
  }, 0n)
  const divisor = 10n ** BigInt(COST_SCALE)
  return `${total / divisor}.${(total % divisor).toString().padStart(COST_SCALE, '0')}`
}
```

成本字段先通过现有 API 的非负十进制约束；若管理端收到非法值，聚合函数抛出并由页面错误态处理，不能静默计为 0。厂家按名称排序，组内模型按 `displayName`、`id` 排序。

- [ ] **Step 4: 改造 Models.vue 厂家分组视图**

保留活动/归档筛选和搜索。搜索后按厂家显示 section/card：厂家名称、模型数、已发布数、渠道供应数、近 24h 请求/Token/采购成本；下面显示该厂家的模型表格。DeepSeek V3 和 DeepSeek R1 必须出现在同一个 DeepSeek 分组。

创建/编辑公共模型 Drawer 增加必填“模型厂家”，创建请求和 PATCH 请求携带 `manufacturer`。

- [ ] **Step 5: 更新 ModelDetail.vue**

页头副标题显示“厂家 · 模型 ID”；编辑 Drawer 增加厂家字段并允许修改。厂家修改成功后返回目录时模型进入新的厂家分组，不修改渠道映射和历史用量。

- [ ] **Step 6: 验证并自检**

Run: `npm test -- test/admin/model-groups.test.ts test/admin/catalog-lifecycle.test.ts`

Run: `npm run admin:build`

Expected: 全部 PASS。自检页面无“销售价格”文案，归档筛选仍先于厂家分组生效。

---

## Task 5: 全量验证与本地端到端验收

**Files:**

- Modify: `docs/channel-model-operations-acceptance.md`
- Do not modify: `docs/acceptance.md`
- Do not modify: `docs/screenshots/`

**Interfaces:**

- Consumes: Tasks 1–4 全部 API 和页面。
- Produces: 可复现验收记录。

- [ ] **Step 1: 应用本地迁移**

Run: `npm run db:migrate`

Expected: `202608210003_public_model_manufacturer` 应用成功，现有模型厂家完成安全回填。

- [ ] **Step 2: 执行专项测试**

Run: `npm test -- test/catalog/model-binding.service.test.ts test/catalog/models.service.test.ts test/catalog/catalog.dto.test.ts test/admin/model-binding.test.ts test/admin/model-groups.test.ts`

Expected: 全部 PASS。

- [ ] **Step 3: 执行完整质量门禁**

Run: `npm run verify`

Expected: typecheck、全量测试与覆盖率、后端构建、管理端构建、许可证检查全部成功。

- [ ] **Step 4: 浏览器验收厂家聚合**

登录本地管理端，创建或使用两个厂家为 DeepSeek 的测试公共模型，验证模型目录只出现一个 DeepSeek 厂家组且包含两个模型；编辑其中一个模型的厂家后，验证它移动到新分组。

- [ ] **Step 5: 浏览器验收渠道绑定**

在测试渠道执行：

1. 输入已有公共模型 ID，页面显示精确匹配并绑定，不新增公共模型。
2. 输入不存在的模型 ID，页面进入创建模式，填写厂家后原子创建并绑定。
3. 编辑刚创建的渠道模型，重新绑定到另一个公共模型并修改上游模型 ID。
4. 验证保存后健康状态为 UNKNOWN，模型测试前不进入健康路由。
5. 归档公共模型同 ID 时，绑定操作提示先恢复而不是重复创建。

- [ ] **Step 6: 数据一致性验收**

失败构造一次唯一映射冲突，确认没有孤立公共模型；查询修改前后的历史用量和采购成本总计，确认不因厂家修改或重新绑定而改变。

- [ ] **Step 7: 更新验收文档并检查差异**

在 `docs/channel-model-operations-acceptance.md` 追加厂家聚合和智能绑定章节，记录迁移、命令、实际测试数量和浏览器结果。

Run: `git diff --check`

Run: `git status --short --branch`

Expected: 无空白错误；用户自有验收文件和截图保持未跟踪且未修改。

## Rollback Strategy

1. 应用回滚时保留 `manufacturer` 和 `manufacturer_key` 列，旧版本会忽略新增字段。
2. 若绑定新接口异常，管理端回退到现有 `POST /channels/:channelId/models`，已创建公共模型仍可正常使用。
3. 原子绑定事务失败会自动回滚，不需要人工清理孤立模型。
4. 厂家修改只更新公共模型元数据，不修改 `UsageLog`、`ChannelModel` ID、成本快照或路由记录。

## Definition of Done

- 渠道新增和编辑模型时能按模型 ID 精确匹配已有公共模型，或在一个事务中创建并绑定新公共模型。
- 绑定编辑允许重新选择公共模型和修改上游模型配置，健康状态安全重置。
- 公共模型保存显式厂家及规范化分组键，现有数据有确定性回填。
- 模型目录按厂家聚合，DeepSeek 的多个模型显示在同一个 DeepSeek 分组。
- 厂家可在模型创建和编辑时维护，厂家变化不影响历史用量和采购成本。
- 专项测试、`npm run verify` 和本地浏览器端到端验收通过。
