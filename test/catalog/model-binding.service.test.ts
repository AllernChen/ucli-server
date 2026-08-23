import { describe, expect, it } from 'vitest'
import { ModelBindingService } from '../../apps/api/src/model-binding.service.js'

const channelId = '10000000-0000-4000-8000-000000000001'
const channelModelId = '20000000-0000-4000-8000-000000000001'

function bindingInput(overrides: Record<string, unknown> = {}) {
  return {
    publicModelId: 'deepseek-v3', createPublicModel: false,
    upstreamModel: 'deepseek-chat', protocol: 'OPENAI_CHAT',
    supportsStream: true, supportsTools: true, probeEnabled: true, probeIntervalMinutes: 15,
    ...overrides
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function makeHarness(options: {
  noPublicModels?: boolean
  archivedPublicModel?: boolean
  archivedChannel?: boolean
  includeMapping?: boolean
  conflictingMapping?: boolean
  publicModelCreateConflict?: boolean
  mappingCreateConflict?: boolean
} = {}) {
  const state = {
    channels: [{ id: channelId, deletedAt: options.archivedChannel ? new Date('2026-08-21T00:00:00Z') : null }],
    publicModels: options.noPublicModels ? [] as any[] : [{
      id: 'deepseek-v3', displayName: 'DeepSeek V3', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek',
      contextSize: 128000, enabled: true,
      deletedAt: options.archivedPublicModel ? new Date('2026-08-21T00:00:00Z') : null
    }],
    channelModels: options.includeMapping ? [{
      id: channelModelId, channelId, publicModelId: 'deepseek-v3', upstreamModel: 'deepseek-chat',
      protocol: 'OPENAI_CHAT', supportsStream: true, supportsTools: true, enabled: true,
      probeEnabled: true, probeIntervalMinutes: 15, health: 'HEALTHY', consecutiveFailures: 0,
      lastTestedAt: new Date('2026-08-20T00:00:00Z'), lastSuccessAt: new Date('2026-08-20T00:00:00Z'),
      lastErrorCode: null, deletedAt: null
    }] as any[] : [] as any[],
    costRules: options.includeMapping ? [{
      id: '30000000-0000-4000-8000-000000000001', channelModelId,
      enabled: true, deletedAt: null
    }] as any[] : [] as any[]
  }
  if (options.conflictingMapping) state.channelModels.push({
    id: '20000000-0000-4000-8000-000000000099', channelId, publicModelId: 'deepseek-r2',
    upstreamModel: 'other', protocol: 'OPENAI_CHAT', deletedAt: new Date('2026-08-19T00:00:00Z')
  })

  let publicModelCreates = 0
  const lockKeys: string[] = []
  const rowLocks: string[] = []
  const buildClient = () => ({
    $queryRaw: async (query: any) => {
      const sql = query.strings?.join('') || ''
      if (sql.includes('pg_advisory_xact_lock')) lockKeys.push(query.values[0])
      if (sql.includes('channel_models') && sql.includes('FOR UPDATE')) rowLocks.push(query.values[0])
      return []
    },
    channel: {
      findUnique: async ({ where }: any) => state.channels.find(item => item.id === where.id) || null
    },
    publicModel: {
      findUnique: async ({ where }: any) => state.publicModels.find(item => item.id === where.id) || null,
      create: async ({ data }: any) => {
        if (options.publicModelCreateConflict) throw { code: 'P2002', meta: { modelName: 'PublicModel', target: ['id'] } }
        publicModelCreates += 1
        const value = { enabled: false, deletedAt: null, ...data }
        state.publicModels.push(value)
        return value
      }
    },
    channelModel: {
      findUnique: async ({ where }: any) => state.channelModels.find(item => item.id === where.id) || null,
      findFirst: async ({ where }: any) => state.channelModels.find(item =>
        (!where.id?.not || item.id !== where.id.not) && item.channelId === where.channelId &&
        item.publicModelId === where.publicModelId && item.protocol === where.protocol
      ) || null,
      create: async ({ data }: any) => {
        if (options.mappingCreateConflict) throw { code: 'P2002', meta: { modelName: 'ChannelModel' } }
        const value = { id: channelModelId, enabled: true, deletedAt: null, ...data }
        state.channelModels.push(value)
        return value
      },
      update: async ({ where, data }: any) => {
        const value = state.channelModels.find(item => item.id === where.id)
        Object.assign(value, data)
        return value
      }
    },
    channelModelCostRule: {
      updateMany: async ({ where, data }: any) => {
        const items = state.costRules.filter(item => item.channelModelId === where.channelModelId &&
          (where.deletedAt === undefined || item.deletedAt === where.deletedAt))
        items.forEach(item => Object.assign(item, data))
        return { count: items.length }
      }
    }
  })
  const prisma: any = {
    $transaction: async (operation: (tx: any) => Promise<unknown>) => {
      const snapshot = clone(state)
      const createsBefore = publicModelCreates
      try {
        return await operation(buildClient())
      } catch (error) {
        state.channels.splice(0, state.channels.length, ...snapshot.channels)
        state.publicModels.splice(0, state.publicModels.length, ...snapshot.publicModels)
        state.channelModels.splice(0, state.channelModels.length, ...snapshot.channelModels)
        state.costRules.splice(0, state.costRules.length, ...snapshot.costRules)
        publicModelCreates = createsBefore
        throw error
      }
    }
  }
  return {
    service: new ModelBindingService(prisma), state,
    calls: { lockKeys, rowLocks, get publicModelCreates() { return publicModelCreates } }
  }
}

describe('model binding service', () => {
  it('matches an active public model by exact id without creating another', async () => {
    const { service, calls } = makeHarness()
    const result: any = await service.bind(channelId, bindingInput() as any)
    expect(result.publicModelCreated).toBe(false)
    expect(result.channelModel.publicModelId).toBe('deepseek-v3')
    expect(calls.publicModelCreates).toBe(0)
  })

  it('serializes channel and public model lifecycle changes before binding', async () => {
    const { service, calls } = makeHarness()
    await service.bind(channelId, bindingInput() as any)
    expect(calls.lockKeys).toEqual([`channel:${channelId}`, 'public-model:deepseek-v3'])
  })

  it('creates and binds a missing public model in the same transaction', async () => {
    const { service, state } = makeHarness({ noPublicModels: true })
    const result: any = await service.bind(channelId, bindingInput({
      publicModelId: 'deepseek-r2', createPublicModel: true,
      publicModelDisplayName: 'DeepSeek R2', manufacturer: ' DeepSeek ', contextSize: 160000
    }) as any)
    expect(result).toMatchObject({
      publicModelCreated: true,
      publicModel: { id: 'deepseek-r2', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek', enabled: false },
      channelModel: { publicModelId: 'deepseek-r2', health: 'UNKNOWN' }
    })
    expect(state.publicModels).toHaveLength(1)
  })

  it('rolls back a newly created public model when mapping uniqueness fails', async () => {
    const { service, state } = makeHarness({ noPublicModels: true, conflictingMapping: true })
    await expect(service.bind(channelId, bindingInput({
      publicModelId: 'deepseek-r2', createPublicModel: true,
      publicModelDisplayName: 'DeepSeek R2', manufacturer: 'DeepSeek'
    }) as any)).rejects.toMatchObject({ status: 409 })
    expect(state.publicModels.some(model => model.id === 'deepseek-r2')).toBe(false)
  })

  it('reports a public model creation race as an existing public model conflict', async () => {
    const { service } = makeHarness({ noPublicModels: true, publicModelCreateConflict: true })
    await expect(service.bind(channelId, bindingInput({
      createPublicModel: true, publicModelDisplayName: 'DeepSeek V3', manufacturer: 'DeepSeek'
    }) as any)).rejects.toMatchObject({ status: 409, message: 'Public model already exists; bind it instead' })
  })

  it('reports a mapping creation race as a mapping conflict', async () => {
    const { service } = makeHarness({ mappingCreateConflict: true })
    await expect(service.bind(channelId, bindingInput() as any))
      .rejects.toMatchObject({ status: 409, message: 'Channel model mapping already exists' })
  })

  it('rejects binding to an archived public model instead of recreating its id', async () => {
    const { service, state } = makeHarness({ archivedPublicModel: true })
    await expect(service.bind(channelId, bindingInput({ createPublicModel: true }) as any))
      .rejects.toMatchObject({ status: 409 })
    expect(state.publicModels).toHaveLength(1)
  })

  it('rejects binding under an archived channel', async () => {
    const { service } = makeHarness({ archivedChannel: true })
    await expect(service.bind(channelId, bindingInput() as any)).rejects.toMatchObject({ status: 404 })
  })

  it('rejects create mode when the public model id already exists', async () => {
    const { service } = makeHarness()
    await expect(service.bind(channelId, bindingInput({ createPublicModel: true }) as any))
      .rejects.toMatchObject({ status: 409 })
  })

  it('rebinds a channel model and resets health derived from the old upstream', async () => {
    const { service, state } = makeHarness({ includeMapping: true })
    state.publicModels.push({
      id: 'deepseek-r1', displayName: 'DeepSeek R1', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek',
      contextSize: 128000, enabled: true, deletedAt: null
    })
    const result: any = await service.rebind(channelModelId, bindingInput({
      publicModelId: 'deepseek-r1', upstreamModel: 'deepseek-reasoner'
    }) as any)
    expect(result.channelModel).toMatchObject({
      publicModelId: 'deepseek-r1', upstreamModel: 'deepseek-reasoner', health: 'UNKNOWN',
      consecutiveFailures: 0, lastTestedAt: null, lastSuccessAt: null, lastErrorCode: null
    })
  })

  it('locks both source and target public models plus the mapping in a stable order before rebind', async () => {
    const { service, state, calls } = makeHarness({ includeMapping: true })
    state.publicModels.push({
      id: 'deepseek-r1', displayName: 'DeepSeek R1', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek',
      contextSize: 128000, enabled: true, deletedAt: null
    })
    await service.rebind(channelModelId, bindingInput({ publicModelId: 'deepseek-r1' }) as any)
    expect(calls.lockKeys).toEqual([
      `channel:${channelId}`, 'public-model:deepseek-r1', 'public-model:deepseek-v3'
    ])
    expect(calls.rowLocks).toEqual([channelModelId])
  })

  it('archives active procurement rules when a mapping identity changes', async () => {
    const { service, state } = makeHarness({ includeMapping: true })
    state.publicModels.push({
      id: 'deepseek-r1', displayName: 'DeepSeek R1', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek',
      contextSize: 128000, enabled: true, deletedAt: null
    })
    const result: any = await service.rebind(channelModelId, bindingInput({
      publicModelId: 'deepseek-r1', upstreamModel: 'deepseek-reasoner'
    }) as any)
    expect(result.costRulesArchived).toBe(1)
    expect(state.costRules[0]).toMatchObject({ enabled: false, deletedAt: expect.any(Date) })
  })

  it('keeps procurement rules when only capability flags change', async () => {
    const { service, state } = makeHarness({ includeMapping: true })
    const result: any = await service.rebind(channelModelId, bindingInput({ supportsTools: false }) as any)
    expect(result.costRulesArchived).toBe(0)
    expect(state.costRules[0]).toMatchObject({ enabled: true, deletedAt: null })
  })

  it('rejects rebind when the target unique mapping exists even if it is archived', async () => {
    const { service, state } = makeHarness({ includeMapping: true, conflictingMapping: true })
    state.publicModels.push({
      id: 'deepseek-r2', displayName: 'DeepSeek R2', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek',
      contextSize: 128000, enabled: true, deletedAt: null
    })
    await expect(service.rebind(channelModelId, bindingInput({ publicModelId: 'deepseek-r2' }) as any))
      .rejects.toMatchObject({ status: 409 })
  })
})
