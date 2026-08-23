# 渠道与模型完整管理能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为公司内部 Token 管理平台的渠道、渠道 Key、渠道模型、分时采购成本、公共模型和兜底采购成本补齐创建、查询、编辑、停启用、删除（可恢复归档）和恢复能力，同时保证历史用量与成本统计完整。

**Architecture:** 在配置实体上统一增加 `deletedAt` 生命周期字段；管理 API 默认只返回活动数据，可通过 `lifecycle=ARCHIVED|ALL` 查询归档数据。`DELETE` 始终执行可恢复归档并级联停用运行时子配置，`POST .../restore` 只恢复记录但不自动启用。网关、探测、模型测试和客户端目录显式过滤归档数据；历史日志与成本快照不修改、不级联删除。

**Tech Stack:** TypeScript、NestJS、Prisma/PostgreSQL、Vue 3、Vite、Vitest、Docker Compose

## Global Constraints

- 本平台用于公司统一采购和内部员工使用，只统计采购成本，不计算用户销售价格。
- 本期“删除”定义为可恢复归档；不提供物理清除入口，不删除 `UsageLog`、`RouteAttempt`、`ChannelModelProbe`、`Report`、`AuditLog`。
- 归档父实体时，在同一事务中归档并停用其运行时子配置；恢复父实体时不自动恢复或启用子配置，避免意外恢复流量。
- 已归档记录不得被编辑、启用、测试、探测、发现模型、发布或参与路由；服务层返回明确的 `404` 或 `409`，不能仅依赖前端隐藏按钮。
- 活动列表默认条件必须是 `deletedAt: null`。归档筛选使用 `lifecycle=ACTIVE|ARCHIVED|ALL`，默认 `ACTIVE`。
- 同一 ID 或唯一映射已归档时，创建接口返回 `409` 并提示先恢复，不能依靠数据库唯一键产生不友好的 500。
- 所有新增变更接口继续由现有 `AuditInterceptor` 记录，且仅限 `PLATFORM_ADMIN`。
- 不修改用户自有的 `docs/acceptance.md` 和 `docs/screenshots/`。
- 不在实现或测试阶段修改生产环境数据；先在本地数据库迁移并完成端到端验证。

---

## Task 1: 建立统一生命周期数据模型

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/202608210002_catalog_soft_delete/migration.sql`
- Test: `test/catalog/catalog-lifecycle-schema.test.ts`

- [ ] **Step 1: 写一个会失败的模式契约测试**

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schema = readFileSync('prisma/schema.prisma', 'utf8')

describe('catalog lifecycle schema', () => {
  for (const model of ['Channel', 'ChannelKey', 'PublicModel', 'ChannelModel', 'ChannelModelCostRule', 'ModelPriceVersion']) {
    it(`${model} has a deletedAt lifecycle marker`, () => {
      const block = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1] || ''
      expect(block).toContain('deletedAt')
      expect(block).toContain('@map("deleted_at")')
    })
  }
})
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `npm test -- test/catalog/catalog-lifecycle-schema.test.ts`

Expected: 6 个断言因缺少 `deletedAt` 失败。

- [ ] **Step 3: 给六个配置实体增加字段和索引**

每个模型增加：

```prisma
deletedAt DateTime? @map("deleted_at")
```

给 `Channel`、`ChannelKey`、`PublicModel`、`ChannelModel` 调整查询热点索引：

```prisma
@@index([deletedAt, enabled])
```

`ChannelModelCostRule` 和 `ModelPriceVersion` 分别使用显式映射名，确保手写迁移与 Prisma 不产生索引名漂移：

```prisma
@@index([channelModelId, deletedAt, enabled, validFrom], map: "cm_cost_rules_lifecycle_idx")
@@index([publicModelId, deletedAt, validFrom], map: "model_prices_lifecycle_idx")
```

- [ ] **Step 4: 创建无损迁移**

```sql
ALTER TABLE "channels" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "channel_keys" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "public_models" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "channel_models" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "channel_model_cost_rules" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "model_price_versions" ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE INDEX "channels_deleted_at_enabled_idx" ON "channels"("deleted_at", "enabled");
CREATE INDEX "channel_keys_deleted_at_enabled_idx" ON "channel_keys"("deleted_at", "enabled");
CREATE INDEX "public_models_deleted_at_enabled_idx" ON "public_models"("deleted_at", "enabled");
CREATE INDEX "channel_models_deleted_at_enabled_idx" ON "channel_models"("deleted_at", "enabled");
CREATE INDEX "cm_cost_rules_lifecycle_idx"
  ON "channel_model_cost_rules"("channel_model_id", "deleted_at", "enabled", "valid_from");
CREATE INDEX "model_prices_lifecycle_idx"
  ON "model_price_versions"("public_model_id", "deleted_at", "valid_from");
```

- [ ] **Step 5: 生成客户端并验证迁移**

Run: `npx prisma validate`

Expected: `The schema at prisma/schema.prisma is valid`。

Run: `npm run db:generate`

Expected: Prisma Client 生成成功。

Run: `npm test -- test/catalog/catalog-lifecycle-schema.test.ts`

Expected: PASS。

- [ ] **Step 6: 自检**

确认迁移只有新增 nullable 字段和索引，没有 `DROP`、`DELETE` 或外键级联变化。

---

## Task 2: 补齐渠道与 Key 的归档、恢复和安全编辑 API

**Files:**

- Modify: `apps/api/src/catalog.dto.ts`
- Modify: `apps/api/src/channels.controller.ts`
- Modify: `apps/api/src/channels.service.ts`
- Modify: `test/catalog/channels.service.test.ts`
- Modify: `test/catalog/catalog.dto.test.ts`

- [ ] **Step 1: 先增加失败测试，锁定生命周期行为**

在 `channels.service.test.ts` 增加以下用例：

```ts
it('archives a channel and all runtime children without deleting history', async () => {
  const { service, state } = lifecycleHarness()
  await expect(service.archive(channel.id)).resolves.toMatchObject({ id: channel.id, lifecycle: 'ARCHIVED' })
  expect(state.channel).toMatchObject({ enabled: false, health: 'DISABLED' })
  expect(state.channel.deletedAt).toBeInstanceOf(Date)
  expect(state.keys.every(item => item.deletedAt && !item.enabled)).toBe(true)
  expect(state.models.every(item => item.deletedAt && !item.enabled && item.health === 'DISABLED')).toBe(true)
  expect(state.rules.every(item => item.deletedAt && !item.enabled)).toBe(true)
})

it('restores a channel as disabled without restoring its children', async () => {
  const { service, state } = lifecycleHarness({ archived: true })
  await service.restore(channel.id)
  expect(state.channel).toMatchObject({ deletedAt: null, enabled: false, health: 'DISABLED' })
  expect(state.keys.every(item => item.deletedAt)).toBe(true)
  expect(state.models.every(item => item.deletedAt)).toBe(true)
})

it('excludes archived channels by default and supports lifecycle filters', async () => {
  const { service } = lifecycleHarness({ includeActiveAndArchived: true })
  await service.list({ lifecycle: 'ACTIVE' })
  await service.list({ lifecycle: 'ARCHIVED' })
  expect(recordedWheres).toContainEqual(expect.objectContaining({ deletedAt: null }))
  expect(recordedWheres).toContainEqual(expect.objectContaining({ deletedAt: { not: null } }))
})

it('archives and restores a key only within its owning channel', async () => {
  const { service, state } = lifecycleHarness()
  await service.archiveKey(channel.id, state.keys[0].id)
  expect(state.keys[0]).toMatchObject({ enabled: false, health: 'DISABLED' })
  await service.restoreKey(channel.id, state.keys[0].id)
  expect(state.keys[0]).toMatchObject({ deletedAt: null, enabled: false, health: 'DISABLED' })
})
```

同时增加“归档记录不能启用、更新、发现模型或测试”和“重复归档/恢复幂等”的用例。

- [ ] **Step 2: 运行渠道测试并确认红灯**

Run: `npm test -- test/catalog/channels.service.test.ts test/catalog/catalog.dto.test.ts`

Expected: 新接口和 `lifecycle` DTO 尚不存在而失败。

- [ ] **Step 3: 增加生命周期查询 DTO**

```ts
export enum CatalogLifecycle {
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
  ALL = 'ALL'
}

export class ChannelListQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(CatalogLifecycle) lifecycle: CatalogLifecycle = CatalogLifecycle.ACTIVE
  // 保留现有字段
}
```

`ChannelListFilter` 同步增加 `lifecycle?: CatalogLifecycle`，并用纯函数生成条件：

```ts
export function lifecycleWhere(lifecycle = CatalogLifecycle.ACTIVE) {
  if (lifecycle === CatalogLifecycle.ALL) return {}
  return lifecycle === CatalogLifecycle.ARCHIVED
    ? { deletedAt: { not: null } }
    : { deletedAt: null }
}
```

- [ ] **Step 4: 实现渠道归档与恢复事务**

```ts
async archive(id: string) {
  const existing = await this.prisma.channel.findUnique({ where: { id }, select: { id: true, deletedAt: true } })
  if (!existing) throw new NotFoundException('Channel not found')
  if (existing.deletedAt) return { id, lifecycle: 'ARCHIVED', deletedAt: existing.deletedAt }
  const deletedAt = new Date()
  await this.prisma.$transaction(async tx => {
    const modelIds = (await tx.channelModel.findMany({ where: { channelId: id }, select: { id: true } })).map(item => item.id)
    await tx.channelModelCostRule.updateMany({ where: { channelModelId: { in: modelIds } }, data: { deletedAt, enabled: false } })
    await tx.channelModel.updateMany({ where: { channelId: id }, data: { deletedAt, enabled: false, probeEnabled: false, health: 'DISABLED' } })
    await tx.channelKey.updateMany({ where: { channelId: id }, data: { deletedAt, enabled: false, health: 'DISABLED', isolatedUntil: null } })
    await tx.channel.update({ where: { id }, data: { deletedAt, enabled: false, health: 'DISABLED', circuitOpenUntil: null } })
  })
  return { id, lifecycle: 'ARCHIVED', deletedAt }
}

async restore(id: string) {
  const existing = await this.prisma.channel.findUnique({ where: { id }, select: { id: true, deletedAt: true } })
  if (!existing) throw new NotFoundException('Channel not found')
  if (!existing.deletedAt) return { id, lifecycle: 'ACTIVE', deletedAt: null }
  await this.prisma.channel.update({ where: { id }, data: { deletedAt: null, enabled: false, health: 'DISABLED' } })
  return { id, lifecycle: 'ACTIVE', deletedAt: null }
}
```

- [ ] **Step 5: 实现 Key 归档、恢复和编辑约束**

新增服务方法 `archiveKey(channelId, keyId)`、`restoreKey(channelId, keyId)`。两者都用 `findFirst({ where: { id: keyId, channelId } })` 校验归属；归档设置 `deletedAt`、`enabled=false`、`health='DISABLED'`，恢复设置 `deletedAt=null` 且保持停用。现有 `updateKey` 允许维护 `priority`、`weight`、`remainingUsd`、`expiresAt`，但对 `deletedAt != null` 返回 `409 Archived key cannot be edited`。恢复后的 Key 首次显式启用时，如果健康状态仍为 `DISABLED`，将其改为 `DEGRADED`，随后要求管理员立即执行模型测试；这样 Key 可被测试选中，但不会伪装成已验证健康。

- [ ] **Step 6: 暴露控制器路由**

```ts
@Delete(':id') archive(@Param('id', UuidPipe) id: string) { return this.channels.archive(id) }
@Post(':id/restore') restore(@Param('id', UuidPipe) id: string) { return this.channels.restore(id) }
@Delete(':id/keys/:keyId') archiveKey(/* UUID params */) { return this.channels.archiveKey(id, keyId) }
@Post(':id/keys/:keyId/restore') restoreKey(/* UUID params */) { return this.channels.restoreKey(id, keyId) }
```

给 `channels.controller.ts` 增加 `Delete` import。

- [ ] **Step 7: 所有渠道读取和动作加活动条件**

默认列表、详情内 keys/models/rules、`discoverModels`、`test`、`setEnabled`、`update`、`addKey` 均要求渠道 `deletedAt: null`。活动详情只包含 `deletedAt: null` 的子项；归档详情通过 `GET /channels/:id?lifecycle=ALL` 返回，以支持恢复页面。

- [ ] **Step 8: 运行测试并自检**

Run: `npm test -- test/catalog/channels.service.test.ts test/catalog/catalog.dto.test.ts`

Expected: PASS。

自检：没有任何 `delete`/`deleteMany` 操作；密钥响应仍不包含 `ciphertext`、`iv`、`tag`。

---

## Task 3: 统一渠道模型与分时成本规则的归档/恢复语义

**Files:**

- Modify: `apps/api/src/channel-models.controller.ts`
- Modify: `apps/api/src/channel-models.service.ts`
- Modify: `apps/api/src/catalog.dto.ts`
- Modify: `test/catalog/channel-models.service.test.ts`

- [ ] **Step 1: 把现有“有历史则停用、无历史则物理删除”测试改为统一归档契约**

```ts
it.each([0, 2])('archives a channel model regardless of usage count %i', async usageCount => {
  const { service, channelModels } = makeHarness({ usageCount })
  const result = await service.archive(modelId)
  expect(result).toMatchObject({ id: modelId, lifecycle: 'ARCHIVED' })
  expect(channelModels[0]).toMatchObject({ enabled: false, probeEnabled: false, health: 'DISABLED' })
  expect(channelModels[0].deletedAt).toBeInstanceOf(Date)
})

it('restores a channel model as disabled and leaves cost rules archived', async () => {
  const { service, channelModels, costRules } = makeHarness({ archived: true })
  await service.restore(modelId)
  expect(channelModels[0]).toMatchObject({ deletedAt: null, enabled: false, probeEnabled: false, health: 'DISABLED' })
  expect(costRules[0].deletedAt).toBeInstanceOf(Date)
})

it('archives and restores a cost rule without changing historical usage', async () => {
  const { service, costRules } = makeHarness()
  await service.archiveCostRule(costRules[0].id)
  expect(costRules[0]).toMatchObject({ enabled: false })
  expect(costRules[0].deletedAt).toBeInstanceOf(Date)
  await service.restoreCostRule(costRules[0].id)
  expect(costRules[0]).toMatchObject({ deletedAt: null, enabled: false })
})
```

补充默认列表排除归档项、`lifecycle=ARCHIVED|ALL`、归档后不能测试/编辑/预览/发布检查、已归档唯一映射创建时返回 409 的测试。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `npm test -- test/catalog/channel-models.service.test.ts`

Expected: 旧的硬删除行为和缺少恢复方法导致失败。

- [ ] **Step 3: 让删除操作始终归档**

将 `remove` 重命名为 `archive`，删除 `usageLog.count` 分支。归档渠道模型时，事务内先归档全部成本规则，再归档并停用模型。恢复后的渠道模型首次显式启用时把 `DISABLED` 改为 `UNKNOWN`，模型测试成功前不会参与健康路由。将 `removeCostRule` 重命名为 `archiveCostRule`，始终设置：

```ts
{ deletedAt: new Date(), enabled: false }
```

恢复方法只清空 `deletedAt`，保持 `enabled=false`；恢复成本规则前确认父渠道模型未归档。

- [ ] **Step 4: 增加列表筛选和写操作保护**

`PageQueryDto` 的专用派生 DTO 增加 `lifecycle`。以下查询默认加 `deletedAt: null`：

- `listByChannel`
- `listCostRules`
- `publishCheck`
- `create` 的父渠道与公共模型校验
- 成本规则冲突检查与成本解析
- 探测记录入口的父模型校验

唯一映射冲突时先用 `findFirst` 查询包含归档项的记录；若归档则返回 `409 Channel model mapping is archived; restore it instead`。

- [ ] **Step 5: 增加恢复路由并保留兼容的 DELETE 路径**

```ts
@Delete('channel-models/:id') archive(/* ... */) { return this.channelModels.archive(id) }
@Post('channel-models/:id/restore') restore(/* ... */) { return this.channelModels.restore(id) }
@Delete('channel-model-cost-rules/:id') archiveCost(/* ... */) { return this.channelModels.archiveCostRule(id) }
@Post('channel-model-cost-rules/:id/restore') restoreCost(/* ... */) { return this.channelModels.restoreCostRule(id) }
```

- [ ] **Step 6: 运行测试并自检**

Run: `npm test -- test/catalog/channel-models.service.test.ts`

Expected: PASS。

自检：`channel-models.service.ts` 不再调用 `channelModel.delete` 或 `channelModelCostRule.delete`；成本快照解析只使用活动规则。

---

## Task 4: 抽取公共模型服务并补齐公共模型、兜底成本完整管理 API

**Files:**

- Create: `apps/api/src/models.service.ts`
- Modify: `apps/api/src/models.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/catalog.dto.ts`
- Create: `test/catalog/models.service.test.ts`

- [ ] **Step 1: 写失败测试覆盖公共模型生命周期和价格版本管理**

```ts
describe('public model management', () => {
  it('archives a model and its runtime mappings and prices in one transaction', async () => {
    const { service, state } = makeHarness()
    await service.archive('gpt-4o')
    expect(state.model).toMatchObject({ enabled: false })
    expect(state.model.deletedAt).toBeInstanceOf(Date)
    expect(state.abilities.every(item => item.deletedAt && !item.enabled)).toBe(true)
    expect(state.prices.every(item => item.deletedAt)).toBe(true)
  })

  it('restores a model as an unpublished draft without restoring children', async () => {
    const { service, state } = makeHarness({ archived: true })
    await service.restore('gpt-4o')
    expect(state.model).toMatchObject({ deletedAt: null, enabled: false })
    expect(state.abilities.every(item => item.deletedAt)).toBe(true)
  })

  it('refuses to edit a price version already referenced by usage', async () => {
    const { service, state } = makeHarness({ usedPrice: true })
    await expect(service.updatePrice('gpt-4o', state.prices[0].id, { inputPerMillion: '2' }))
      .rejects.toMatchObject({ status: 409 })
  })

  it('archives and restores an unused fallback price as disabled from resolution', async () => {
    const { service, state } = makeHarness()
    await service.archivePrice('gpt-4o', state.prices[0].id)
    expect(state.prices[0].deletedAt).toBeInstanceOf(Date)
    await service.restorePrice('gpt-4o', state.prices[0].id)
    expect(state.prices[0].deletedAt).toBeNull()
  })
})
```

再覆盖：活动/归档/全部列表、归档模型不能发布或编辑、创建已归档同 ID 返回 409、价格必须属于路径中的公共模型。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `npm test -- test/catalog/models.service.test.ts`

Expected: `ModelsService` 不存在而失败。

- [ ] **Step 3: 抽取 `ModelsService`**

将 `ModelsController` 中直接访问 Prisma 的 list/create/update/publish/unpublish/price 方法移动到 `ModelsService`，控制器只负责 DTO、路由和授权。`AppModule` 注册 `ModelsService`。

服务接口保持明确：

```ts
list(lifecycle: CatalogLifecycle): Promise<PublicModelCatalogItem[]>
create(input: CreatePublicModelDto): Promise<PublicModel>
update(id: string, input: UpdatePublicModelDto): Promise<PublicModel>
archive(id: string): Promise<LifecycleResult>
restore(id: string): Promise<LifecycleResult>
publish(id: string): Promise<PublicModel>
unpublish(id: string): Promise<PublicModel>
createPrice(id: string, input: CreateModelPriceDto): Promise<ModelPriceVersion>
updatePrice(id: string, priceId: string, input: UpdateModelPriceDto): Promise<ModelPriceVersion>
archivePrice(id: string, priceId: string): Promise<LifecycleResult>
restorePrice(id: string, priceId: string): Promise<LifecycleResult>
```

- [ ] **Step 4: 增加经过验证的 DTO**

金额字段沿用非负十进制正则，`validFrom`/`validUntil` 转换前检查为有效 ISO 时间；`validUntil` 必须晚于 `validFrom`。公共模型 ID 限制为 1–200 字符，显示名 1–200 字符，上下文长度为正整数或 null。

- [ ] **Step 5: 实现归档与恢复**

公共模型归档事务顺序：归档成本规则 → 归档渠道模型 → 归档价格版本 → 设置公共模型 `deletedAt` 和 `enabled=false`。保留 access policies、quotas、usage logs 和 reports 的关联。恢复公共模型只清空自身 `deletedAt` 并保持 `enabled=false`。

价格更新前执行：

```ts
const used = await this.prisma.usageLog.count({ where: { priceVersionId: priceId } })
if (used) throw new ConflictException('Used price versions are immutable; create a new version instead')
```

- [ ] **Step 6: 暴露完整管理路由**

```text
GET    /api/v1/admin/models?lifecycle=ACTIVE|ARCHIVED|ALL
POST   /api/v1/admin/models
PATCH  /api/v1/admin/models/:id
DELETE /api/v1/admin/models/:id
POST   /api/v1/admin/models/:id/restore
POST   /api/v1/admin/models/:id/publish
POST   /api/v1/admin/models/:id/unpublish
POST   /api/v1/admin/models/:id/prices
PATCH  /api/v1/admin/models/:id/prices/:priceId
DELETE /api/v1/admin/models/:id/prices/:priceId
POST   /api/v1/admin/models/:id/prices/:priceId/restore
```

保留现有 abilities 路由，但内部改用 `ChannelModelsService` 的活动记录语义，不能物理删除。

- [ ] **Step 7: 运行测试并自检**

Run: `npm test -- test/catalog/models.service.test.ts test/catalog/channel-models.service.test.ts`

Expected: PASS。

自检：控制器不再包含业务事务；任何公共模型或价格路径都不调用 Prisma `delete`。

---

## Task 5: 保证归档配置不会参与路由、员工目录、测试和自动探测

**Files:**

- Modify: `apps/gateway/src/gateway.service.ts`
- Modify: `apps/api/src/client.controller.ts`
- Modify: `apps/api/src/model-testing.service.ts`
- Modify: `apps/api/src/monitoring.controller.ts`
- Modify: `apps/worker/src/worker.service.ts`
- Modify: `test/gateway/gateway.service.test.ts`
- Modify: `test/catalog/model-testing.service.test.ts`
- Create: `test/catalog/catalog-runtime-isolation.test.ts`

- [ ] **Step 1: 写运行时隔离失败测试**

覆盖以下断言：

```ts
expect(publicModelWhere).toMatchObject({ enabled: true, deletedAt: null })
expect(channelModelWhere).toMatchObject({ enabled: true, deletedAt: null })
expect(channelModelWhere.channel).toMatchObject({ enabled: true, deletedAt: null })
expect(nestedKeyWhere).toMatchObject({ enabled: true, deletedAt: null })
expect(nestedCostWhere).toMatchObject({ enabled: true, deletedAt: null })
expect(nestedPriceWhere).toMatchObject({ deletedAt: null })
```

并验证手动测试归档模型、批量测试混入归档模型、定时探测归档模型均被拒绝或跳过。

- [ ] **Step 2: 运行相关测试并确认红灯**

Run: `npm test -- test/gateway/gateway.service.test.ts test/catalog/model-testing.service.test.ts test/catalog/catalog-runtime-isolation.test.ts`

Expected: 查询条件未包含 `deletedAt` 而失败。

- [ ] **Step 3: 更新网关候选查询**

`GatewayService.models` 和 relay 前的 public model 查询增加 `deletedAt: null`；`candidates` 增加：

```ts
where: {
  deletedAt: null,
  enabled: true,
  channel: { deletedAt: null, enabled: true, /* 现有健康条件 */ }
},
include: {
  costRules: { where: { deletedAt: null, enabled: true } },
  channel: { include: { keys: { where: { deletedAt: null, enabled: true } } } }
}
```

兜底 prices 查询增加 `deletedAt: null`。

- [ ] **Step 4: 更新员工目录和后台测试**

`ClientController.bootstrap` 只返回 `enabled=true, deletedAt=null` 的公共模型。`ModelTestingService` 的单测、对话测试、批量测试和定时探测均校验 model/channel/key `deletedAt=null`；归档模型返回 `404 Channel model not found`，避免泄漏已删除配置状态。

- [ ] **Step 5: 更新 Worker 与监控**

Worker 渠道探测查询只包含活动渠道，并在 nested include 中过滤活动 Key 和渠道模型。监控默认只展示活动渠道/Key；历史用量聚合保持原样，因为归档后仍需要按旧 ID 统计。

- [ ] **Step 6: 运行隔离测试并自检**

Run: `npm test -- test/gateway/gateway.service.test.ts test/catalog/model-testing.service.test.ts test/catalog/catalog-runtime-isolation.test.ts`

Expected: PASS。

自检：全局搜索配置实体的运行时 `findMany/findFirst/findUnique`，确认所有参与路由、测试、探测和员工目录的入口均处理 `deletedAt`。

---

## Task 6: 补齐管理端渠道、Key、渠道模型和成本规则操作

**Files:**

- Modify: `apps/admin/src/types/catalog.ts`
- Modify: `apps/admin/src/views/Channels.vue`
- Modify: `apps/admin/src/views/ChannelDetail.vue`
- Modify: `apps/admin/src/components/ConfirmDialog.vue`
- Create: `apps/admin/src/catalog-lifecycle.ts`
- Create: `test/admin/catalog-lifecycle.test.ts`

- [ ] **Step 1: 先测试前端生命周期纯函数**

```ts
import { describe, expect, it } from 'vitest'
import { lifecycleQuery, lifecycleActions } from '../../apps/admin/src/catalog-lifecycle.js'

it('builds an encoded lifecycle query', () => {
  expect(lifecycleQuery('ARCHIVED')).toBe('lifecycle=ARCHIVED')
})

it('only offers restore for archived records', () => {
  expect(lifecycleActions({ deletedAt: '2026-08-21T00:00:00Z' })).toEqual(['restore'])
  expect(lifecycleActions({ deletedAt: null })).toEqual(['edit', 'archive'])
})
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `npm test -- test/admin/catalog-lifecycle.test.ts`

Expected: 模块不存在而失败。

- [ ] **Step 3: 扩充类型和生命周期辅助函数**

给 `ChannelSummary`、`ChannelDetail`、`ChannelKey`、`ChannelModel`、`CostRule`、`PublicModel` 和价格类型增加 `deletedAt: string | null`。实现纯函数：

```ts
export type CatalogLifecycle = 'ACTIVE' | 'ARCHIVED' | 'ALL'
export const lifecycleQuery = (value: CatalogLifecycle) => `lifecycle=${encodeURIComponent(value)}`
export const lifecycleActions = (item: { deletedAt: string | null }) => item.deletedAt ? ['restore'] : ['edit', 'archive']
```

- [ ] **Step 4: 渠道列表增加活动/已归档筛选和行操作**

`Channels.vue` 增加“使用中 / 已归档”切换，加载对应 `lifecycle`；活动行提供“查看、编辑、删除”，归档行提供“查看、恢复”。删除使用 `ConfirmDialog`，文案明确“将停止该渠道及所有 Key/模型参与路由，历史统计保留，可恢复”。完成后刷新当前列表。

- [ ] **Step 5: 渠道详情补齐编辑、归档和恢复**

设置页继续承担渠道编辑；页头增加删除/恢复。归档页面将测试、发现、保存、添加、启用按钮全部禁用。归档后返回渠道列表的“已归档”视图；恢复后仍显示“已停用”，提示需要逐项恢复并测试后再启用。

- [ ] **Step 6: Key 补齐编辑、删除和恢复**

Key 表格增加“编辑” Drawer，暴露优先级、权重、余额、到期时间；增加删除确认和归档筛选。不得显示或回填明文 Key。恢复后的 Key 保持停用，用户需要显式启用。

- [ ] **Step 7: 渠道模型和成本规则统一操作**

渠道模型增加编辑 Drawer，维护上游模型名、流式/工具能力、自动探测及间隔；把现有 `window.confirm` 替换为 `ConfirmDialog`。成本规则删除成功文案改为“成本规则已删除”，归档视图提供恢复；恢复后的规则保持停用。所有请求完成后重新加载，失败时保留 Drawer 内容并显示 API 错误。

- [ ] **Step 8: 运行测试和构建**

Run: `npm test -- test/admin/catalog-lifecycle.test.ts`

Expected: PASS。

Run: `npm run admin:build`

Expected: Vite 构建成功，无 TypeScript/Vue 模板错误。

- [ ] **Step 9: 自检**

确认无 `window.confirm`；危险操作都显示资源名称、影响范围和“可恢复”；删除按钮不会因行点击事件误导航。

---

## Task 7: 补齐管理端公共模型与兜底采购成本操作

**Files:**

- Modify: `apps/admin/src/views/Models.vue`
- Modify: `apps/admin/src/views/ModelDetail.vue`
- Modify: `apps/admin/src/types/catalog.ts`
- Reuse: `apps/admin/src/components/Drawer.vue`
- Reuse: `apps/admin/src/components/ConfirmDialog.vue`
- Modify: `test/admin/catalog-lifecycle.test.ts`

- [ ] **Step 1: 扩展失败测试覆盖价格版本动作约束**

给纯函数测试增加：活动价格支持 edit/archive，归档价格只支持 restore；被标记 `used=true` 的价格不提供 edit，仅允许 archive。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `npm test -- test/admin/catalog-lifecycle.test.ts`

Expected: 新断言失败。

- [ ] **Step 3: 公共模型列表增加完整管理入口**

增加活动/已归档筛选；活动行支持查看、编辑、删除，归档行支持查看、恢复。行操作使用 `@click.stop`。删除确认说明：模型将从员工目录下线，渠道映射和兜底成本一并归档，历史成本不受影响。

- [ ] **Step 4: 公共模型详情增加编辑、删除和恢复**

编辑 Drawer 维护显示名称与上下文长度。活动模型可发布/下线/删除；归档模型只可恢复。归档详情不执行 publish-check，避免无意义错误；恢复后显示为草稿。

- [ ] **Step 5: 兜底采购成本增加创建、编辑、删除和恢复**

价格表增加金额、币种、生效/失效时间表单和操作列。已被历史用量引用的版本在 API 返回 409 时提示“该价格已产生用量记录，请新增价格版本”；不覆盖历史版本。归档价格在归档筛选中可恢复。

- [ ] **Step 6: 运行测试和构建**

Run: `npm test -- test/admin/catalog-lifecycle.test.ts`

Expected: PASS。

Run: `npm run admin:build`

Expected: PASS。

- [ ] **Step 7: 自检**

确认所有金额文案为“采购成本”或“兜底采购成本”，没有销售价、加价率或员工计费文案。

---

## Task 8: 完整验证、回归和本地端到端验收

**Files:**

- Modify: `docs/channel-model-operations-acceptance.md`
- Do not modify: `docs/acceptance.md`
- Do not modify: `docs/screenshots/`

- [ ] **Step 1: 本地执行迁移并保留验证输出**

Run: `npm run db:migrate`

Expected: `202608210002_catalog_soft_delete` 成功应用。

- [ ] **Step 2: 执行针对性回归**

Run: `npm test -- test/catalog/channels.service.test.ts test/catalog/channel-models.service.test.ts test/catalog/models.service.test.ts test/catalog/model-testing.service.test.ts test/catalog/catalog-runtime-isolation.test.ts test/admin/catalog-lifecycle.test.ts`

Expected: 全部 PASS。

- [ ] **Step 3: 执行全量质量门禁**

Run: `npm run verify`

Expected: typecheck、coverage、backend build、admin build、license check 全部成功。

- [ ] **Step 4: 启动或确认本地服务**

确认 API `http://localhost:3000`、Gateway `http://localhost:3001`、Admin `http://localhost:5174` 和 Worker 均运行；若构建输出已变化，按项目现有开发启动方式重启相应进程。

- [ ] **Step 5: 管理端端到端验收**

用专门的新建测试数据依次验证：

1. 创建渠道 → 编辑设置 → 添加/编辑 Key → 添加/编辑渠道模型 → 添加/编辑分时成本。
2. 删除渠道模型后，活动列表消失、归档列表可见、模型测试失败、恢复后保持停用。
3. 删除 Key 后不再参与测试和路由，恢复后保持停用且明文从未返回浏览器。
4. 删除渠道后，渠道、Key、渠道模型和成本规则均不参与路由；归档视图可查询并恢复。
5. 创建公共模型 → 编辑 → 添加兜底成本 → 发布；删除后员工模型目录消失，恢复后为草稿。
6. 删除前后查询历史统计，渠道、模型、用户用量和采购成本合计保持一致。
7. 对重复删除、重复恢复、编辑归档记录、创建同 ID 归档记录验证幂等或明确的 409 提示。

- [ ] **Step 6: 网关端到端隔离验证**

删除一个正在路由的测试渠道模型，使用测试页面发起对话，确认它不再成为候选；恢复但未启用时仍不成为候选；显式启用并通过模型测试后才恢复流量。

- [ ] **Step 7: 更新项目验收文档**

在 `docs/channel-model-operations-acceptance.md` 增加“完整管理能力”章节，记录 API、页面路径、归档/恢复语义、测试命令和实际结果。不要覆盖用户自有的验收文档与截图。

- [ ] **Step 8: 最终差异检查**

Run: `git diff --check`

Expected: 无空白错误。

Run: `git status --short`

Expected: 只包含本功能文件，以及原有未跟踪的用户文件。

- [ ] **Step 9: 实施者自审**

逐项确认：

- 所有“删除”均可恢复，没有配置实体物理删除。
- 归档记录不参与路由、员工目录、模型测试或自动探测。
- 历史用量、路由尝试、成本快照、报表和审计关联完整。
- 恢复不会自动启用流量。
- 前后端均有权限与状态校验。
- 管理端具备创建、查询、编辑、停启用、删除、归档查看和恢复。
- 采购成本术语准确，没有用户销售价格逻辑。

---

## Rollback Strategy

1. 应用代码回滚时保留六个 nullable `deleted_at` 列，旧代码会忽略它们，不影响历史数据。
2. 若必须回滚迁移，只有在确认所有 `deleted_at` 均为 null 且没有新版服务运行后，才另建显式回滚迁移删除索引和字段；禁止直接手工改生产库。
3. 若归档逻辑出现问题，先停用新增 UI 操作并回滚应用版本，不恢复或物理删除历史记录。
4. 恢复误归档数据时，只清空目标父记录 `deleted_at` 并保持停用，再由管理员逐项恢复子配置、测试、启用。

## Definition of Done

- 渠道、Key、渠道模型、分时成本规则、公共模型和兜底成本均有完整管理入口。
- 删除为可恢复归档，活动/归档视图清晰，恢复默认停用。
- 网关、员工目录、测试、监控和 Worker 不使用归档配置。
- 历史用量与采购成本统计在归档前后数值一致。
- 针对性测试、`npm run verify` 和本地端到端验收全部通过。
