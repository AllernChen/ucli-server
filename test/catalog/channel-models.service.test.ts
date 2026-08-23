import 'reflect-metadata'
import { ConflictException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { ChannelModelsService } from '../../apps/api/src/channel-models.service.js'

const channelId = '10000000-0000-4000-8000-000000000001'
const modelId = '20000000-0000-4000-8000-000000000001'

function costRule(overrides: Record<string, unknown> = {}) {
  return {
    id: '30000000-0000-4000-8000-000000000001', channelModelId: modelId, name: '基础成本',
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 0, priority: 0,
    inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0',
    currency: 'CNY', enabled: true, deletedAt: null, validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), ...overrides
  }
}

function makeHarness() {
  const channel = { id: channelId, deletedAt: null as Date | null, costTimezone: 'UTC' }
  const publicModels = [
    { id: 'gpt-4o', deletedAt: null as Date | null, prices: [] },
    { id: 'gpt-4.1', deletedAt: null as Date | null, prices: [{
      id: '50000000-0000-4000-8000-000000000001', inputPerMillion: '3', outputPerMillion: '6',
      cachedPerMillion: '0.025', reasoningPerMillion: '6', currency: 'CNY',
      validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null, deletedAt: null
    }] }
  ]
  const channelModels: any[] = [
    { id: modelId, channelId, publicModelId: 'gpt-4o', upstreamModel: 'gpt-4o-up', protocol: 'OPENAI_CHAT',
      enabled: true, probeEnabled: true, deletedAt: null, health: 'HEALTHY', lastTestedAt: new Date('2026-08-20T00:00:00Z'),
      lastSuccessAt: new Date('2026-08-20T00:00:00Z'), costRules: [costRule()], channel: {
        enabled: true, deletedAt: null, health: 'HEALTHY', costTimezone: 'UTC', circuitOpenUntil: null,
        keys: [{ id: 'key-1', enabled: true, deletedAt: null, health: 'HEALTHY', remainingUsd: null, weight: 1, priority: 0, expiresAt: null, isolatedUntil: null }]
      } },
    { id: '20000000-0000-4000-8000-000000000002', channelId, publicModelId: 'gpt-4.1', upstreamModel: 'gpt-4.1-up',
      protocol: 'OPENAI_CHAT', enabled: true, probeEnabled: true, deletedAt: null, health: 'DEGRADED', costRules: [], channel: {
        enabled: true, deletedAt: null, health: 'HEALTHY', costTimezone: 'UTC', circuitOpenUntil: null,
        keys: [{ id: 'key-1', enabled: true, deletedAt: null, health: 'HEALTHY', remainingUsd: null, weight: 1, priority: 0, expiresAt: null, isolatedUntil: null }]
      } }
  ]
  const costRules: any[] = [costRule()]
  let transactionTail = Promise.resolve()
  const prisma: any = {
    channel: { findUnique: async ({ where }: any) => where.id === channelId ? channel : null },
    publicModel: {
      findUnique: async ({ where }: any) => publicModels.find(item => item.id === where.id) || null,
      findMany: async ({ where }: any) => publicModels.filter(item => where.id.in.includes(item.id) && !item.deletedAt)
    },
    channelModel: {
      findMany: async ({ where, skip = 0, take = 50 }: any) => channelModels.filter(item =>
        (!where?.channelId || item.channelId === where.channelId) && (!where?.publicModelId || item.publicModelId === where.publicModelId) &&
        (where?.deletedAt === undefined || (where.deletedAt === null ? item.deletedAt === null : item.deletedAt !== null))
      ).slice(skip, skip + take),
      count: async ({ where }: any) => channelModels.filter(item => (!where?.channelId || item.channelId === where.channelId) &&
        (where?.deletedAt === undefined || (where.deletedAt === null ? item.deletedAt === null : item.deletedAt !== null))).length,
      findUnique: async ({ where }: any) => channelModels.find(item => item.id === where.id) || null,
      findFirst: async ({ where }: any) => channelModels.find(item =>
        (!where.id || item.id === where.id) && (!where.channelId || item.channelId === where.channelId) &&
        (!where.publicModelId || item.publicModelId === where.publicModelId) && (!where.protocol || item.protocol === where.protocol) &&
        (where.deletedAt === undefined || (where.deletedAt === null ? item.deletedAt === null : item.deletedAt !== null))
      ) || null,
      create: async ({ data }: any) => { const value = {
        id: '20000000-0000-4000-8000-000000000003', health: 'UNKNOWN', enabled: true, deletedAt: null, ...data
      }; channelModels.push(value); return value },
      update: async ({ where, data }: any) => Object.assign(channelModels.find(item => item.id === where.id), data),
      updateMany: async ({ where, data }: any) => {
        const items = channelModels.filter(item => !where.channelId || item.channelId === where.channelId)
        items.forEach(item => Object.assign(item, data)); return { count: items.length }
      },
      delete: async ({ where }: any) => channelModels.splice(channelModels.findIndex(item => item.id === where.id), 1)[0]
    },
    channelModelCostRule: {
      findMany: async ({ where }: any) => costRules.filter(item => item.channelModelId === where.channelModelId && item.id !== where.id?.not &&
        (where.enabled === undefined || item.enabled === where.enabled) &&
        (where.deletedAt === undefined || (where.deletedAt === null ? item.deletedAt === null : item.deletedAt !== null))),
      create: async ({ data }: any) => { const value = { ...costRule({ id: '30000000-0000-4000-8000-000000000002' }), ...data }; costRules.push(value); return value },
      findUnique: async ({ where }: any) => costRules.find(item => item.id === where.id) || null,
      update: async ({ where, data }: any) => Object.assign(costRules.find(item => item.id === where.id), data),
      updateMany: async ({ where, data }: any) => {
        const ids = where.channelModelId?.in || [where.channelModelId]
        const items = costRules.filter(item => ids.includes(item.channelModelId) &&
          (where.deletedAt === undefined || (where.deletedAt === null ? item.deletedAt === null : item.deletedAt !== null)))
        items.forEach(item => Object.assign(item, data)); return { count: items.length }
      },
      delete: async ({ where }: any) => costRules.splice(costRules.findIndex(item => item.id === where.id), 1)[0]
    },
    $executeRaw: async () => 1,
    usageLog: { count: async ({ where }: any) => where.channelModelId === modelId || where.channelCostRuleId === costRules[0]?.id ? 2 : 0 },
    $transaction: async (operation: any) => {
      if (typeof operation !== 'function') return Promise.all(operation)
      let release!: () => void
      const previous = transactionTail
      transactionTail = new Promise<void>(resolve => { release = resolve })
      await previous
      try { return await operation(prisma) } finally { release() }
    }
  }
  return { service: new ChannelModelsService(prisma), channel, publicModels, channelModels, costRules }
}

describe('channel model catalog service', () => {
  it('returns a stable paginated response for one channel', async () => {
    const { service } = makeHarness()
    const result = await service.listByChannel(channelId, { limit: 1, offset: 1 })
    expect(result).toEqual({ items: [expect.objectContaining({ publicModelId: 'gpt-4.1' })], total: 2, limit: 1, offset: 1 })
  })

  it('archives a channel model that already has usage history', async () => {
    const { service, channelModels } = makeHarness()
    const result = await (service as any).archive(modelId)
    expect(result).toMatchObject({ id: modelId, lifecycle: 'ARCHIVED' })
    expect(channelModels[0]).toMatchObject({ enabled: false, probeEnabled: false, health: 'DISABLED' })
    expect(channelModels[0].deletedAt).toBeInstanceOf(Date)
    expect(channelModels).toHaveLength(2)
  })

  it('aligns the channel catalog with the effective channel rule or public-model fallback price', async () => {
    const { service } = makeHarness()

    const result = await service.listByChannel(channelId, { limit: 50, offset: 0 }, new Date('2026-08-20T01:00:00Z'))

    expect(result.items).toEqual([
      expect.objectContaining({ currentCost: expect.objectContaining({
        source: 'CHANNEL_COST_RULE', inputPerMillion: '1', outputPerMillion: '2', currency: 'CNY'
      }) }),
      expect.objectContaining({ currentCost: expect.objectContaining({
        source: 'PUBLIC_MODEL_FALLBACK', inputPerMillion: '3', outputPerMillion: '6', currency: 'CNY'
      }) })
    ])
  })

  it('excludes archived channel models by default and supports lifecycle filters', async () => {
    const { service, channelModels } = makeHarness()
    channelModels[1].deletedAt = new Date('2026-08-21T00:00:00Z')

    await expect(service.listByChannel(channelId, { limit: 50, offset: 0 })).resolves.toMatchObject({ total: 1 })
    await expect(service.listByChannel(channelId, { limit: 50, offset: 0, lifecycle: 'ARCHIVED' } as any))
      .resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ id: channelModels[1].id })] })
    await expect(service.listByChannel(channelId, { limit: 50, offset: 0, lifecycle: 'ALL' } as any))
      .resolves.toMatchObject({ total: 2 })
  })

  it('archives an unused channel model instead of deleting it', async () => {
    const { service, channelModels } = makeHarness()
    const id = '20000000-0000-4000-8000-000000000002'
    await (service as any).archive(id)
    expect(channelModels).toHaveLength(2)
    expect(channelModels.find(item => item.id === id)).toMatchObject({ enabled: false, deletedAt: expect.any(Date) })
  })

  it('restores a channel model as disabled without restoring cost rules', async () => {
    const { service, channelModels, costRules } = makeHarness()
    await (service as any).archive(modelId)

    await expect((service as any).restore(modelId)).resolves.toEqual({ id: modelId, lifecycle: 'ACTIVE', deletedAt: null })

    expect(channelModels[0]).toMatchObject({ deletedAt: null, enabled: false, probeEnabled: false, health: 'DISABLED' })
    expect(costRules[0].deletedAt).toBeInstanceOf(Date)
  })

  it('does not restore a channel model while its channel is archived', async () => {
    const { service, channel, channelModels } = makeHarness()
    await (service as any).archive(modelId)
    channel.deletedAt = new Date('2026-08-21T00:00:00Z')

    await expect((service as any).restore(modelId)).rejects.toMatchObject({ status: 409 })
    expect(channelModels[0].deletedAt).toBeInstanceOf(Date)
  })

  it('creates a channel model only when both channel and public model exist', async () => {
    const { service } = makeHarness()
    await expect(service.create(channelId, {
      publicModelId: 'missing', upstreamModel: 'missing-up', protocol: 'OPENAI_CHAT',
      supportsStream: true, supportsTools: false, probeEnabled: true, probeIntervalMinutes: 15
    })).rejects.toMatchObject({ status: 404 })
    await expect(service.create(channelId, {
      publicModelId: 'gpt-4.1', upstreamModel: 'gpt-4.1-up-2', protocol: 'OPENAI_CHAT',
      supportsStream: true, supportsTools: false, probeEnabled: true, probeIntervalMinutes: 15
    })).resolves.toMatchObject({ health: 'UNKNOWN', publicModelId: 'gpt-4.1' })
  })

  it('returns a conflict when the unique channel model mapping is archived', async () => {
    const { service, channelModels } = makeHarness()
    channelModels[0].deletedAt = new Date('2026-08-21T00:00:00Z')
    await expect(service.create(channelId, {
      publicModelId: 'gpt-4o', upstreamModel: 'replacement', protocol: 'OPENAI_CHAT',
      supportsStream: true, supportsTools: false, probeEnabled: true, probeIntervalMinutes: 15
    })).rejects.toMatchObject({ status: 409 })
    expect(channelModels).toHaveLength(2)
  })

  it('rejects updates and cost previews for an archived channel model', async () => {
    const { service, channelModels } = makeHarness()
    channelModels[0].deletedAt = new Date('2026-08-21T00:00:00Z')

    await expect(service.update(modelId, { upstreamModel: 'changed' })).rejects.toMatchObject({ status: 409 })
    await expect(service.previewCostRule(modelId, {
      name: '归档模型成本', daysOfWeek: [1], startMinute: 0, endMinute: 0, priority: 5,
      inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0',
      validFrom: '2026-01-01T00:00:00.000Z'
    })).rejects.toMatchObject({ status: 409 })
  })

  it('rejects updates and previews when a parent catalog record is archived', async () => {
    const { service, publicModels, channelModels } = makeHarness()
    publicModels[0].deletedAt = new Date('2026-08-21T00:00:00Z')
    await expect(service.update(modelId, { upstreamModel: 'changed' })).rejects.toMatchObject({ status: 409 })

    publicModels[0].deletedAt = null
    channelModels[0].channel.deletedAt = new Date('2026-08-21T00:00:00Z')
    await expect(service.previewCostRule(modelId, {
      name: '父渠道归档', daysOfWeek: [1], startMinute: 0, endMinute: 0, priority: 5,
      inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0',
      validFrom: '2026-01-01T00:00:00.000Z'
    })).rejects.toMatchObject({ status: 409 })
  })

  it('rejects an overlapping cost rule at the same priority', async () => {
    const { service, costRules } = makeHarness()
    await expect(service.createCostRule(modelId, {
      name: '高峰成本', daysOfWeek: [1, 2, 3, 4, 5], startMinute: 1200, endMinute: 1380, priority: 0,
      inputPerMillion: '2', outputPerMillion: '4', cachedPerMillion: '0', reasoningPerMillion: '0',
      validFrom: '2026-08-01T00:00:00.000Z'
    })).rejects.toBeInstanceOf(ConflictException)
    expect(costRules).toHaveLength(1)
  })

  it('allows a higher-priority peak rule over an all-day base cost', async () => {
    const { service, costRules } = makeHarness()
    const created = await service.createCostRule(modelId, {
      name: '高峰成本', daysOfWeek: [1, 2, 3, 4, 5], startMinute: 1200, endMinute: 1380, priority: 10,
      inputPerMillion: '2', outputPerMillion: '4', cachedPerMillion: '0', reasoningPerMillion: '0',
      validFrom: '2026-08-01T00:00:00.000Z'
    })
    expect(created).toMatchObject({ name: '高峰成本', priority: 10, currency: 'CNY' })
    expect(costRules).toHaveLength(2)
  })

  it('clears a cost-rule expiry when optional DTO fields are present as undefined', async () => {
    const { service, costRules } = makeHarness()
    const controllerDto = {
      name: '官方基础成本（全天）', daysOfWeek: undefined, startMinute: undefined, endMinute: undefined,
      priority: undefined, inputPerMillion: undefined, outputPerMillion: undefined,
      cachedPerMillion: undefined, reasoningPerMillion: undefined, validFrom: undefined,
      validUntil: null, enabled: undefined
    }
    costRules[0].validUntil = new Date('2026-08-28T00:00:00Z')

    await expect(service.updateCostRule(costRules[0].id, controllerDto as any)).resolves.toMatchObject({
      name: '官方基础成本（全天）', validUntil: null, inputPerMillion: '1', outputPerMillion: '2'
    })
  })

  it('rejects editing a peak cost into an overlapping rule at the base priority', async () => {
    const { service } = makeHarness()
    const created: any = await service.createCostRule(modelId, {
      name: '高峰成本', daysOfWeek: [1, 2, 3, 4, 5], startMinute: 1200, endMinute: 1380, priority: 10,
      inputPerMillion: '2', outputPerMillion: '4', cachedPerMillion: '0', reasoningPerMillion: '0',
      validFrom: '2026-08-01T00:00:00.000Z'
    })
    await expect(service.updateCostRule(created.id, { priority: 0 })).rejects.toBeInstanceOf(ConflictException)
  })

  it('archives and restores a cost rule referenced by historical usage', async () => {
    const { service, costRules } = makeHarness()
    const id = costRules[0].id
    await (service as any).archiveCostRule(id)
    expect(costRules[0].enabled).toBe(false)
    expect(costRules[0].deletedAt).toBeInstanceOf(Date)
    expect(costRules).toHaveLength(1)

    await expect((service as any).restoreCostRule(id)).resolves.toEqual({ id, lifecycle: 'ACTIVE', deletedAt: null })
    expect(costRules[0]).toMatchObject({ deletedAt: null, enabled: false })
  })

  it('keeps an archived legacy-currency cost rule immutable instead of restoring it as active', async () => {
    const { service, costRules } = makeHarness()
    Object.assign(costRules[0], {
      currency: 'USD', deletedAt: new Date('2026-08-21T00:00:00Z'), enabled: false
    })

    await expect(service.restoreCostRule(costRules[0].id)).rejects.toMatchObject({ status: 409 })
    expect(costRules[0]).toMatchObject({ currency: 'USD', deletedAt: expect.any(Date), enabled: false })
  })

  it('lists active and archived cost rules independently', async () => {
    const { service, costRules } = makeHarness()
    costRules.push(costRule({ id: '30000000-0000-4000-8000-000000000009', deletedAt: new Date('2026-08-21T00:00:00Z'), enabled: false }))

    await expect(service.listCostRules(modelId)).resolves.toHaveLength(1)
    await expect(service.listCostRules(modelId, 'ARCHIVED' as any)).resolves.toEqual([
      expect.objectContaining({ id: '30000000-0000-4000-8000-000000000009' })
    ])
    await expect(service.listCostRules(modelId, 'ALL' as any)).resolves.toHaveLength(2)
  })

  it('does not restore a cost rule while its parent model is archived', async () => {
    const { service, channelModels, costRules } = makeHarness()
    channelModels[0].deletedAt = new Date('2026-08-21T00:00:00Z')
    costRules[0].deletedAt = new Date('2026-08-21T00:00:00Z')
    costRules[0].enabled = false

    await expect((service as any).restoreCostRule(costRules[0].id)).rejects.toMatchObject({ status: 409 })
  })

  it('reports a public model ready only with an available tested channel model and current procurement cost', async () => {
    const { service, channelModels, costRules } = makeHarness()
    await expect(service.publishCheck('gpt-4o', new Date('2026-08-20T01:00:00Z'))).resolves.toEqual({
      ready: true, healthyChannelModels: 1, hasCurrentCost: true, blockers: []
    })
    channelModels[0].health = 'UNHEALTHY'
    costRules.splice(0)
    channelModels[0].costRules = []
    await expect(service.publishCheck('gpt-4o', new Date('2026-08-20T01:00:00Z'))).resolves.toEqual({
      ready: false, healthyChannelModels: 0, hasCurrentCost: false,
      blockers: ['NO_HEALTHY_CHANNEL_MODEL', 'NO_CURRENT_COST']
    })
  })

  it('excludes archived channel models from publish readiness', async () => {
    const { service, channelModels } = makeHarness()
    channelModels[0].deletedAt = new Date('2026-08-21T00:00:00Z')
    await expect(service.publishCheck('gpt-4o', new Date('2026-08-20T01:00:00Z'))).resolves.toMatchObject({
      ready: false, healthyChannelModels: 0, hasCurrentCost: false
    })
  })

  it('does not combine health from one channel model with cost from another', async () => {
    const { service, channelModels } = makeHarness()
    channelModels[0].costRules = []
    channelModels.push({
      ...channelModels[0], id: '20000000-0000-4000-8000-000000000099', health: 'UNHEALTHY', costRules: [costRule()]
    })
    await expect(service.publishCheck('gpt-4o', new Date('2026-08-20T01:00:00Z'))).resolves.toMatchObject({
      ready: false, healthyChannelModels: 1, hasCurrentCost: false, blockers: ['NO_CURRENT_COST']
    })
  })

  it('requires the channel itself to be healthy and the rule to match the current local time', async () => {
    const { service, channelModels } = makeHarness()
    channelModels[0].channel.health = 'UNHEALTHY'
    await expect(service.publishCheck('gpt-4o', new Date('2026-08-20T01:00:00Z'))).resolves.toMatchObject({ ready: false })
    channelModels[0].channel.health = 'HEALTHY'
    channelModels[0].costRules = [costRule({ daysOfWeek: [5] })]
    await expect(service.publishCheck('gpt-4o', new Date('2026-08-20T01:00:00Z'))).resolves.toMatchObject({
      ready: false, healthyChannelModels: 1, hasCurrentCost: false
    })
  })

  it('rejects a negative first cost rule before persistence', async () => {
    const { service, costRules } = makeHarness()
    costRules.splice(0)
    await expect(service.createCostRule(modelId, {
      name: '非法成本', daysOfWeek: [1], startMinute: 0, endMinute: 0, priority: 0,
      inputPerMillion: '-1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0',
      validFrom: '2026-08-01T00:00:00.000Z'
    })).rejects.toMatchObject({ status: 400 })
    expect(costRules).toHaveLength(0)
  })

  it('previews conflicts before saving a cost rule', async () => {
    const { service } = makeHarness()
    await expect(service.previewCostRule(modelId, {
      name: '冲突成本', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startMinute: 600, endMinute: 700, priority: 0,
      inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0',
      validFrom: '2026-01-01T00:00:00.000Z'
    }, new Date('2026-08-20T01:00:00Z'))).resolves.toMatchObject({ valid: false, conflicts: [{ name: '基础成本' }] })
  })

  it('serializes concurrent writes so equal-priority overlapping rules cannot both persist', async () => {
    const { service, costRules } = makeHarness()
    costRules.splice(0)
    const input = {
      name: '并发基础成本', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 0, priority: 0,
      inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0',
      validFrom: '2026-01-01T00:00:00.000Z'
    }
    const outcomes = await Promise.allSettled([
      service.createCostRule(modelId, input), service.createCostRule(modelId, { ...input, name: '并发冲突成本' })
    ])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(costRules).toHaveLength(1)
  })

  it('does not let an unavailable healthy model hide a failed ready candidate', async () => {
    const { service, channelModels } = makeHarness()
    channelModels[0].health = 'DEGRADED'
    channelModels.push({
      ...channelModels[0], id: '20000000-0000-4000-8000-000000000098', health: 'HEALTHY',
      channel: { ...channelModels[0].channel, keys: [] }
    })
    await expect(service.publishCheck('gpt-4o', new Date('2026-08-20T01:00:00Z'))).resolves.toMatchObject({
      ready: false, healthyChannelModels: 1, hasCurrentCost: true, blockers: ['LATEST_TEST_FAILED']
    })
  })
})
