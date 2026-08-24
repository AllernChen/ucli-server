import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { ProcurementCostStatus } from '../../apps/api/src/catalog.dto.js'
import { ProcurementCostsService } from '../../apps/api/src/procurement-costs.service.js'

const at = new Date('2026-08-24T10:00:00.000Z')

function price(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, inputPerMillion: '3', outputPerMillion: '6', cachedPerMillion: '0.3', reasoningPerMillion: '6',
    currency: 'CNY', enabled: true, deletedAt: null, validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null,
    ...overrides
  }
}

function rule(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, name: '全天基础价', priority: 0, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 0,
    inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0.1', reasoningPerMillion: '2',
    currency: 'CNY', enabled: true, deletedAt: null, validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), ...overrides
  }
}

function model(id: string, overrides: Record<string, unknown> = {}) {
  const publicModelId = `model-${id}`
  return {
    id, channelId: `10000000-0000-4000-8000-00000000000${id}`, publicModelId, upstreamModel: `upstream-${id}`,
    protocol: 'OPENAI_CHAT', enabled: true, health: 'HEALTHY', deletedAt: null,
    channel: { id: `10000000-0000-4000-8000-00000000000${id}`, name: `渠道 ${id}`, enabled: true, deletedAt: null, costTimezone: 'UTC' },
    publicModel: { id: publicModelId, displayName: `模型 ${id}`, manufacturer: '测试厂家', manufacturerKey: '测试厂家', deletedAt: null, prices: [] },
    costRules: [], ...overrides
  }
}

function makeHarness() {
  const models: any[] = [
    model('1', { costRules: [rule('full')] }),
    model('2', {
      publicModel: { ...model('2').publicModel, prices: [price('fallback-2')] },
      costRules: [rule('peak', { name: '工作日晚高峰', priority: 10, daysOfWeek: [1, 2, 3, 4, 5], startMinute: 1080, endMinute: 1380 })]
    }),
    model('3', { publicModel: { ...model('3').publicModel, prices: [price('fallback-3')] } }),
    model('4'),
    model('5', { costRules: [rule('future', { validFrom: new Date('2026-09-01T00:00:00Z') })] }),
    model('6', { enabled: false, health: 'DISABLED', publicModel: { ...model('6').publicModel, prices: [price('fallback-6')] } })
  ]
  const prisma: any = {
    channelModel: {
      findMany: async () => models,
      findUnique: async ({ where }: any) => models.find(item => item.id === where.id) || null
    }
  }
  return { service: new ProcurementCostsService(prisma), models }
}

describe('procurement cost workspace service', () => {
  it('classifies channel coverage, public fallback, missing, upcoming and disabled configurations', async () => {
    const { service } = makeHarness()

    const result = await service.list({ limit: 20, offset: 0 }, at)

    expect(result).toMatchObject({ total: 6, limit: 20, offset: 0 })
    expect(result.items.map((item: any) => [item.channelModelId, item.status])).toEqual([
      ['1', ProcurementCostStatus.CHANNEL_RULE_ACTIVE],
      ['2', ProcurementCostStatus.PARTIAL_FALLBACK],
      ['3', ProcurementCostStatus.FALLBACK_ONLY],
      ['4', ProcurementCostStatus.NO_COST],
      ['5', ProcurementCostStatus.UPCOMING],
      ['6', ProcurementCostStatus.DISABLED]
    ])
    expect(result.items[0]).toMatchObject({
      currentCost: { id: 'full', source: 'CHANNEL_COST_RULE' },
      coverage: { channelRuleMinutes: 10080, fallbackMinutes: 0, uncoveredMinutes: 0 }
    })
    expect(result.items[1]).toMatchObject({
      currentCost: { id: 'fallback-2', source: 'PUBLIC_MODEL_FALLBACK' },
      coverage: { channelRuleMinutes: 1500, fallbackMinutes: 8580, uncoveredMinutes: 0 }
    })
  })

  it('applies computed status filtering before pagination', async () => {
    const { service } = makeHarness()

    const result = await service.list({ status: ProcurementCostStatus.FALLBACK_ONLY, limit: 1, offset: 0 }, at)

    expect(result).toMatchObject({ total: 1, limit: 1, offset: 0 })
    expect(result.items).toEqual([expect.objectContaining({ channelModelId: '3' })])
  })

  it('evaluates the effective source and returns four auditable CNY cost parts', async () => {
    const { service } = makeHarness()

    const result = await service.evaluate('2', {
      at: at.toISOString(), inputTokens: 1_000_000, outputTokens: 500_000,
      cachedTokens: 200_000, reasoningTokens: 100_000
    })

    expect(result).toMatchObject({
      channelModelId: '2', timezone: 'UTC', cost: { id: 'fallback-2', source: 'PUBLIC_MODEL_FALLBACK' },
      estimate: {
        inputCost: '2.40000000', outputCost: '2.40000000', cachedCost: '0.06000000',
        reasoningCost: '0.60000000', totalCost: '5.46000000', currency: 'CNY'
      },
      nextTransition: { at: '2026-08-24T18:00:00.000Z', cost: { id: 'peak' } }
    })
  })

  it('returns an explicit no-cost evaluation instead of inventing a price', async () => {
    const { service } = makeHarness()

    await expect(service.evaluate('4', {
      at: at.toISOString(), inputTokens: 1000, outputTokens: 1000, cachedTokens: 0, reasoningTokens: 0
    })).resolves.toMatchObject({ cost: null, estimate: null, nextTransition: null })
  })
})
