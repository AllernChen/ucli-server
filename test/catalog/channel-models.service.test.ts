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
    currency: 'USD', enabled: true, validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), ...overrides
  }
}

function makeHarness() {
  const channelModels: any[] = [
    { id: modelId, channelId, publicModelId: 'gpt-4o', upstreamModel: 'gpt-4o-up', protocol: 'OPENAI_CHAT',
      enabled: true, health: 'HEALTHY', lastTestedAt: new Date('2026-08-20T00:00:00Z'),
      lastSuccessAt: new Date('2026-08-20T00:00:00Z'), costRules: [costRule()], channel: { enabled: true } },
    { id: '20000000-0000-4000-8000-000000000002', channelId, publicModelId: 'gpt-4.1', upstreamModel: 'gpt-4.1-up',
      protocol: 'OPENAI_CHAT', enabled: true, health: 'DEGRADED', costRules: [], channel: { enabled: true } }
  ]
  const costRules: any[] = [costRule()]
  const prisma: any = {
    channel: { findUnique: async ({ where }: any) => where.id === channelId ? { id: channelId } : null },
    publicModel: { findUnique: async ({ where }: any) => ['gpt-4o', 'gpt-4.1'].includes(where.id) ? { id: where.id, prices: [] } : null },
    channelModel: {
      findMany: async ({ where, skip = 0, take = 50 }: any) => channelModels.filter(item =>
        (!where?.channelId || item.channelId === where.channelId) && (!where?.publicModelId || item.publicModelId === where.publicModelId)
      ).slice(skip, skip + take),
      count: async ({ where }: any) => channelModels.filter(item => !where?.channelId || item.channelId === where.channelId).length,
      findUnique: async ({ where }: any) => channelModels.find(item => item.id === where.id) || null,
      create: async ({ data }: any) => { const value = { id: '20000000-0000-4000-8000-000000000003', health: 'UNKNOWN', enabled: true, ...data }; channelModels.push(value); return value },
      update: async ({ where, data }: any) => Object.assign(channelModels.find(item => item.id === where.id), data),
      delete: async ({ where }: any) => channelModels.splice(channelModels.findIndex(item => item.id === where.id), 1)[0]
    },
    channelModelCostRule: {
      findMany: async ({ where }: any) => costRules.filter(item => item.channelModelId === where.channelModelId && item.id !== where.id?.not),
      create: async ({ data }: any) => { const value = { ...costRule({ id: '30000000-0000-4000-8000-000000000002' }), ...data }; costRules.push(value); return value },
      findUnique: async ({ where }: any) => costRules.find(item => item.id === where.id) || null,
      update: async ({ where, data }: any) => Object.assign(costRules.find(item => item.id === where.id), data),
      delete: async ({ where }: any) => costRules.splice(costRules.findIndex(item => item.id === where.id), 1)[0]
    },
    usageLog: { count: async ({ where }: any) => where.channelModelId === modelId || where.channelCostRuleId === costRules[0]?.id ? 2 : 0 },
    $transaction: async (operation: any) => typeof operation === 'function' ? operation(prisma) : Promise.all(operation)
  }
  return { service: new ChannelModelsService(prisma), channelModels, costRules }
}

describe('channel model catalog service', () => {
  it('returns a stable paginated response for one channel', async () => {
    const { service } = makeHarness()
    const result = await service.listByChannel(channelId, { limit: 1, offset: 1 })
    expect(result).toEqual({ items: [expect.objectContaining({ publicModelId: 'gpt-4.1' })], total: 2, limit: 1, offset: 1 })
  })

  it('soft-disables a channel model that already has usage history', async () => {
    const { service, channelModels } = makeHarness()
    const result = await service.remove(modelId)
    expect(result).toMatchObject({ id: modelId, enabled: false, health: 'DISABLED' })
    expect(channelModels).toHaveLength(2)
  })

  it('hard-deletes an unused channel model', async () => {
    const { service, channelModels } = makeHarness()
    await service.remove('20000000-0000-4000-8000-000000000002')
    expect(channelModels.map(item => item.publicModelId)).toEqual(['gpt-4o'])
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
    expect(created).toMatchObject({ name: '高峰成本', priority: 10, currency: 'USD' })
    expect(costRules).toHaveLength(2)
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

  it('soft-disables a cost rule referenced by historical usage', async () => {
    const { service, costRules } = makeHarness()
    const removed: any = await service.removeCostRule(costRules[0].id)
    expect(removed.enabled).toBe(false)
    expect(costRules).toHaveLength(1)
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
      blockers: ['NO_HEALTHY_CHANNEL_MODEL', 'NO_CURRENT_COST', 'LATEST_TEST_FAILED']
    })
  })
})
