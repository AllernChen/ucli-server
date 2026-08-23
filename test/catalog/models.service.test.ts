import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { CatalogLifecycle } from '../../apps/api/src/catalog.dto.js'
import { ModelsService } from '../../apps/api/src/models.service.js'

const modelId = 'gpt-4o'
const priceId = '50000000-0000-4000-8000-000000000001'
const abilityId = '30000000-0000-4000-8000-000000000001'

function makeHarness(options: { archived?: boolean; usedPrice?: boolean; noExistingModel?: boolean } = {}) {
  const deletedAt = options.archived ? new Date('2026-08-21T00:00:00Z') : null
  const state: any = {
    model: {
      id: modelId, displayName: 'GPT-4o', manufacturer: 'OpenAI', manufacturerKey: 'openai',
      contextSize: 128000, enabled: !deletedAt, deletedAt
    },
    abilities: [{
      id: abilityId, publicModelId: modelId, channelId: '10000000-0000-4000-8000-000000000001',
      upstreamModel: 'gpt-4o', protocol: 'OPENAI_CHAT', enabled: !deletedAt, probeEnabled: !deletedAt,
      health: deletedAt ? 'DISABLED' : 'HEALTHY', deletedAt
    }],
    rules: [{ id: '40000000-0000-4000-8000-000000000001', channelModelId: abilityId, enabled: !deletedAt, deletedAt }],
    prices: [{
      id: priceId, publicModelId: modelId, inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0',
      reasoningPerMillion: '0', currency: 'CNY', enabled: !deletedAt,
      validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null, deletedAt
    }]
  }
  const matchLifecycle = (item: any, where: any) => where?.deletedAt === undefined ||
    (where.deletedAt === null ? item.deletedAt === null : item.deletedAt !== null)
  const calls = {
    priceUsageGroups: 0, priceUsageWhere: null as any, archivedAbilities: [] as string[], publicModelQuery: null as any,
    lockKeys: [] as string[]
  }
  const prisma: any = {
    publicModel: {
      findUnique: async ({ where }: any) => !options.noExistingModel && where.id === modelId ? state.model : null,
      findMany: async (args: any) => {
        calls.publicModelQuery = args
        const { where, include } = args
        return matchLifecycle(state.model, where) ? [{
        ...state.model, channelModels: state.abilities.map((item: any) => ({ ...item, channel: { costTimezone: 'UTC' }, costRules: [] })),
        prices: state.prices.filter((item: any) => matchLifecycle(item, include?.prices?.where || {}))
      }] : []
      },
      create: async ({ data }: any) => Object.assign(state.model, data),
      update: async ({ where, data }: any) => Object.assign(where.id === modelId ? state.model : null, data)
    },
    channelModel: {
      findUnique: async ({ where }: any) => {
        const mapping = where.channelId_publicModelId_protocol
        if (!mapping) return null
        return state.abilities.find((item: any) => item.channelId === mapping.channelId &&
          item.publicModelId === mapping.publicModelId && item.protocol === mapping.protocol) || null
      },
      findMany: async ({ where }: any) => state.abilities.filter((item: any) => item.publicModelId === where.publicModelId),
      updateMany: async ({ where, data }: any) => {
        const items = state.abilities.filter((item: any) => item.publicModelId === where.publicModelId)
        items.forEach((item: any) => Object.assign(item, data)); return { count: items.length }
      }
    },
    channelModelCostRule: {
      updateMany: async ({ where, data }: any) => {
        const items = state.rules.filter((item: any) => where.channelModelId.in.includes(item.channelModelId))
        items.forEach((item: any) => Object.assign(item, data)); return { count: items.length }
      }
    },
    modelPriceVersion: {
      findFirst: async ({ where }: any) => state.prices.find((item: any) => item.id === where.id && item.publicModelId === where.publicModelId) || null,
      create: async ({ data }: any) => { const value = { id: 'new-price', deletedAt: null, ...data }; state.prices.push(value); return value },
      update: async ({ where, data }: any) => Object.assign(state.prices.find((item: any) => item.id === where.id), data),
      updateMany: async ({ where, data }: any) => {
        const items = state.prices.filter((item: any) => item.publicModelId === where.publicModelId)
        items.forEach((item: any) => Object.assign(item, data)); return { count: items.length }
      }
    },
    usageLog: {
      count: async ({ where }: any) => options.usedPrice && where.priceVersionId === priceId ? 1 : 0,
      groupBy: async ({ by, where }: any) => {
        if (by.includes('priceVersionId')) {
          calls.priceUsageGroups += 1
          calls.priceUsageWhere = where
          return options.usedPrice ? [{ priceVersionId: priceId }] : []
        }
        return []
      }
    },
    $queryRaw: async (query: any) => { calls.lockKeys.push(query.values[0]); return [] },
    $transaction: async (operation: any) => operation(prisma)
  }
  const channelModels: any = {
    publishCheck: async () => ({ ready: true, blockers: [] }),
    archive: async (id: string) => { calls.archivedAbilities.push(id); return { id, lifecycle: 'ARCHIVED' } }
  }
  return { service: new ModelsService(prisma, channelModels), state, calls }
}

describe('public model management', () => {
  it('normalizes manufacturer whitespace and grouping key on create', async () => {
    const { service, state } = makeHarness({ noExistingModel: true })

    await service.create({
      id: modelId, displayName: 'GPT-4o', manufacturer: '  OpenAI  Platform  ', contextSize: 128000
    })

    expect(state.model).toMatchObject({ manufacturer: 'OpenAI Platform', manufacturerKey: 'openai platform' })
  })

  it('updates manufacturer and its grouping key together', async () => {
    const { service, state, calls } = makeHarness()

    await service.update(modelId, { manufacturer: '  OpenAI  Research  ' })

    expect(state.model).toMatchObject({ manufacturer: 'OpenAI Research', manufacturerKey: 'openai research' })
  })

  it('archives a public model and all runtime mappings and prices', async () => {
    const { service, state, calls } = makeHarness()

    await expect(service.archive(modelId)).resolves.toMatchObject({ id: modelId, lifecycle: 'ARCHIVED' })

    expect(state.model).toMatchObject({ enabled: false, deletedAt: expect.any(Date) })
    expect(state.abilities[0]).toMatchObject({ enabled: false, probeEnabled: false, health: 'DISABLED', deletedAt: expect.any(Date) })
    expect(state.rules[0]).toMatchObject({ enabled: false, deletedAt: expect.any(Date) })
    expect(state.prices[0].deletedAt).toBeInstanceOf(Date)
    expect(calls.lockKeys).toEqual([`public-model:${modelId}`])
  })

  it('restores a public model as an unpublished draft without restoring children', async () => {
    const { service, state } = makeHarness({ archived: true })

    await expect(service.restore(modelId)).resolves.toEqual({ id: modelId, lifecycle: 'ACTIVE', deletedAt: null })

    expect(state.model).toMatchObject({ enabled: false, deletedAt: null })
    expect(state.abilities[0].deletedAt).toBeInstanceOf(Date)
    expect(state.prices[0].deletedAt).toBeInstanceOf(Date)
  })

  it('refuses to edit a price version already referenced by usage', async () => {
    const { service } = makeHarness({ usedPrice: true })

    await expect(service.updatePrice(modelId, priceId, { inputPerMillion: '2' })).rejects.toMatchObject({ status: 409 })
  })

  it('archives and restores a fallback price without deleting it', async () => {
    const { service, state } = makeHarness()

    await expect(service.archivePrice(modelId, priceId)).resolves.toMatchObject({ id: priceId, lifecycle: 'ARCHIVED' })
    expect(state.prices[0]).toMatchObject({ deletedAt: expect.any(Date), enabled: false })

    await expect(service.restorePrice(modelId, priceId)).resolves.toEqual({ id: priceId, lifecycle: 'ACTIVE', deletedAt: null })
    expect(state.prices[0]).toMatchObject({ deletedAt: null, enabled: false })
  })

  it('requires an explicit activation after restoring a fallback price', async () => {
    const { service, state } = makeHarness({ archived: true })
    state.model.deletedAt = null

    await service.restorePrice(modelId, priceId)
    await expect(service.setPriceEnabled(modelId, priceId, true)).resolves.toMatchObject({ id: priceId, enabled: true })
  })

  it('creates fallback procurement prices in CNY by default', async () => {
    const { service } = makeHarness()

    await expect(service.createPrice(modelId, {
      inputPerMillion: '3', outputPerMillion: '6', cachedPerMillion: '0.025', reasoningPerMillion: '6'
    } as any)).resolves.toMatchObject({ currency: 'CNY' })
  })

  it('rejects recreating a public model whose id is archived', async () => {
    const { service } = makeHarness({ archived: true })

    await expect(service.create({
      id: modelId, displayName: 'Duplicate', manufacturer: 'OpenAI', contextSize: null
    })).rejects.toMatchObject({ status: 409 })
  })

  it('marks referenced prices as used with one grouped usage query', async () => {
    const { service, calls } = makeHarness({ usedPrice: true })

    const models = await service.list()

    expect(models[0].prices).toEqual([expect.objectContaining({ id: priceId, used: true })])
    expect(calls.priceUsageGroups).toBe(1)
    expect(calls.priceUsageWhere).toEqual({ priceVersionId: { in: [priceId] } })
  })

  it('returns the channel timezone even when no cost is currently effective', async () => {
    const { service, state } = makeHarness()
    state.prices.length = 0

    const models = await service.list()

    expect(models[0].abilities[0]).toMatchObject({ costTimezone: 'UTC', currentCost: null })
  })

  it('archives an ability through ChannelModelsService', async () => {
    const { service, state, calls } = makeHarness()

    await service.archiveAbility(modelId, {
      channelId: state.abilities[0].channelId,
      protocol: state.abilities[0].protocol
    })

    expect(calls.archivedAbilities).toEqual([abilityId])
  })

  it('lists every non-archived price version so future and expired prices remain manageable', async () => {
    const { service, calls } = makeHarness()

    await service.list()

    expect(calls.publicModelQuery.include.prices.where).toEqual({ deletedAt: null })
  })

  it('rejects editing an archived model', async () => {
    const { service } = makeHarness({ archived: true })

    await expect(service.update(modelId, { displayName: 'Renamed' })).rejects.toMatchObject({ status: 404 })
  })

  it('rejects a price id that belongs to another public model', async () => {
    const { service, state } = makeHarness()
    state.prices[0].publicModelId = 'another-model'

    await expect(service.archivePrice(modelId, priceId)).rejects.toMatchObject({ status: 404 })
  })

  it('skips the price usage query when the lifecycle view contains no prices', async () => {
    const { service, state, calls } = makeHarness()
    state.prices.length = 0

    await service.list()

    expect(calls.priceUsageGroups).toBe(0)
  })

  it('supports active and archived public model lifecycle views', async () => {
    const { service } = makeHarness({ archived: true })

    await expect(service.list()).resolves.toEqual([])
    await expect(service.list(CatalogLifecycle.ARCHIVED)).resolves.toEqual([
      expect.objectContaining({ id: modelId, deletedAt: expect.any(Date) })
    ])
  })
})
