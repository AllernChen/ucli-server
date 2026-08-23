import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelsService } from '../../apps/api/src/channels.service.js'
import { encryptSecret } from '../../packages/security/src/envelope-crypto.js'

const channel = {
  id: '10000000-0000-4000-8000-000000000001', name: 'OpenAI A', provider: 'openai', protocol: 'OPENAI',
  baseUrl: 'https://upstream.example', enabled: true, health: 'HEALTHY', priority: 1, weight: 1,
  timeoutMs: 300000, maxRetries: 1, keySelection: 'WEIGHTED_RANDOM', costTimezone: 'UTC',
  keys: [{ id: '20000000-0000-4000-8000-000000000001', suffix: 'cret', enabled: true, health: 'HEALTHY',
    priority: 0, weight: 1, remainingUsd: null, expiresAt: null, ciphertext: 'secret-data', iv: 'iv', tag: 'tag' }],
  channelModels: [{ id: '30000000-0000-4000-8000-000000000001', health: 'HEALTHY', enabled: true }]
}

function service() {
  const prisma: any = {
    channel: {
      findMany: async () => [structuredClone(channel)],
      count: async () => 1,
      findUnique: async ({ where }: any) => where.id === channel.id ? structuredClone(channel) : null
    },
    $queryRaw: async () => []
  }
  return new ChannelsService(prisma)
}

function lifecycleHarness(archived = false) {
  const deletedAt = archived ? new Date('2026-08-21T00:00:00Z') : null
  const state: any = {
    channel: { ...structuredClone(channel), deletedAt },
    keys: channel.keys.map(item => ({ ...structuredClone(item), channelId: channel.id, deletedAt })),
    models: channel.channelModels.map(item => ({
      ...structuredClone(item), channelId: channel.id, probeEnabled: true, health: archived ? 'DISABLED' : item.health, deletedAt
    })),
    rules: [{ id: '40000000-0000-4000-8000-000000000001', channelModelId: channel.channelModels[0].id, enabled: true, deletedAt }]
  }
  const recordedWheres: any[] = []
  const lockKeys: string[] = []
  const matchesLifecycle = (item: any, where: any) => {
    if (where?.deletedAt === null) return item.deletedAt === null
    if (where?.deletedAt?.not === null) return item.deletedAt !== null
    return true
  }
  const apply = (target: any, data: any) => Object.assign(target, data)
  const prisma: any = {
    channel: {
      findMany: async ({ where }: any) => {
        recordedWheres.push(structuredClone(where))
        return matchesLifecycle(state.channel, where) ? [{ ...state.channel, keys: state.keys, channelModels: state.models }] : []
      },
      count: async ({ where }: any) => matchesLifecycle(state.channel, where) ? 1 : 0,
      findUnique: async ({ where }: any) => where.id === state.channel.id ? state.channel : null,
      update: async ({ where, data }: any) => apply(where.id === state.channel.id ? state.channel : null, data)
    },
    channelKey: {
      findFirst: async ({ where }: any) => state.keys.find((item: any) => item.id === where.id && item.channelId === where.channelId) || null,
      update: async ({ where, data }: any) => apply(state.keys.find((item: any) => item.id === where.id), data),
      updateMany: async ({ where, data }: any) => {
        const items = state.keys.filter((item: any) => item.channelId === where.channelId)
        items.forEach((item: any) => apply(item, data)); return { count: items.length }
      }
    },
    channelModel: {
      findMany: async ({ where }: any) => state.models.filter((item: any) => item.channelId === where.channelId),
      updateMany: async ({ where, data }: any) => {
        const items = state.models.filter((item: any) => item.channelId === where.channelId)
        items.forEach((item: any) => apply(item, data)); return { count: items.length }
      }
    },
    channelModelCostRule: {
      updateMany: async ({ where, data }: any) => {
        const ids = where.channelModelId.in
        const items = state.rules.filter((item: any) => ids.includes(item.channelModelId))
        items.forEach((item: any) => apply(item, data)); return { count: items.length }
      }
    },
    $queryRaw: async (query: any) => { if (typeof query.values?.[0] === 'string') lockKeys.push(query.values[0]); return [] },
    $transaction: async (operation: any) => operation(prisma)
  }
  return { service: new ChannelsService(prisma), state, recordedWheres, lockKeys }
}

describe('channel catalog service', () => {
  it('returns paginated summaries without encrypted key material', async () => {
    const result: any = await service().list({ limit: 20, offset: 0, q: 'OpenAI' })
    expect(result).toMatchObject({ total: 1, limit: 20, offset: 0 })
    expect(result.items[0]).toMatchObject({ availableKeys: 1, healthyModels: 1, modelCount: 1 })
    expect(JSON.stringify(result)).not.toContain('secret-data')
  })

  it('returns a channel detail without ciphertext, iv or authentication tag', async () => {
    const result: any = await service().detail(channel.id)
    expect(result.keys[0]).toEqual(expect.objectContaining({ suffix: 'cret' }))
    expect(result.keys[0]).not.toHaveProperty('ciphertext')
    expect(result.keys[0]).not.toHaveProperty('iv')
    expect(result.keys[0]).not.toHaveProperty('tag')
  })

  it('discovers upstream models without writing them and marks existing mappings', async () => {
    const masterKey = Buffer.alloc(32, 7)
    process.env.MASTER_KEY = masterKey.toString('base64')
    const encrypted = encryptSecret('upstream-key', masterKey)
    const prisma: any = { channel: { findUnique: async () => ({
      ...channel, keys: [{ ...channel.keys[0], ...encrypted }], channelModels: [{ upstreamModel: 'gpt-4o' }]
    }) } }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }] }), { status: 200 }))
    await expect(new ChannelsService(prisma).discoverModels(channel.id)).resolves.toEqual([
      { upstreamModel: 'gpt-4.1', alreadyMapped: false },
      { upstreamModel: 'gpt-4o', alreadyMapped: true }
    ])
  })

  it('uses the configured model discovery URL instead of deriving one from the base URL', async () => {
    const masterKey = Buffer.alloc(32, 7)
    process.env.MASTER_KEY = masterKey.toString('base64')
    const encrypted = encryptSecret('upstream-key', masterKey)
    const prisma: any = { channel: { findUnique: async () => ({
      ...channel,
      protocol: 'ANTHROPIC',
      baseUrl: 'https://api.deepseek.com/anthropic',
      modelDiscoveryUrl: 'https://api.deepseek.com/models',
      keys: [{ ...channel.keys[0], ...encrypted }],
      channelModels: []
    }) } }
    vi.stubGlobal('fetch', async (input: string | URL | Request) => String(input) === 'https://api.deepseek.com/models'
      ? new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), { status: 200 })
      : new Response(null, { status: 404 }))

    await expect(new ChannelsService(prisma).discoverModels(channel.id)).resolves.toEqual([
      { upstreamModel: 'deepseek-v4-flash', alreadyMapped: false }
    ])
  })

  it('rejects a configured model discovery URL on a different origin', async () => {
    const masterKey = Buffer.alloc(32, 7)
    process.env.MASTER_KEY = masterKey.toString('base64')
    const encrypted = encryptSecret('upstream-key', masterKey)
    const prisma: any = { channel: { findUnique: async () => ({
      ...channel,
      baseUrl: 'https://api.deepseek.com/anthropic',
      modelDiscoveryUrl: 'https://credentials.example/models',
      keys: [{ ...channel.keys[0], ...encrypted }],
      channelModels: []
    }) } }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))

    await expect(new ChannelsService(prisma).discoverModels(channel.id)).rejects.toThrow(
      'Model discovery URL must use the same origin as channel base URL'
    )
  })

  it('stores a configured model discovery URL when creating a channel', async () => {
    const prisma: any = { channel: { create: async ({ data }: any) => data } }

    await expect(new ChannelsService(prisma).create({
      name: 'DeepSeek Anthropic', provider: 'deepseek', protocol: 'ANTHROPIC',
      baseUrl: 'https://api.deepseek.com/anthropic', modelDiscoveryUrl: 'https://api.deepseek.com/models'
    })).resolves.toMatchObject({ modelDiscoveryUrl: 'https://api.deepseek.com/models' })
  })

  it('rejects a cross-origin model discovery URL before storing the channel', async () => {
    const prisma: any = { channel: { create: vi.fn(async () => ({})) } }

    expect(() => new ChannelsService(prisma).create({
      name: 'Unsafe', provider: 'deepseek', protocol: 'OPENAI',
      baseUrl: 'https://api.deepseek.com', modelDiscoveryUrl: 'https://credentials.example/models'
    })).toThrow('Model discovery URL must use the same origin as channel base URL')
    expect(prisma.channel.create).not.toHaveBeenCalled()
  })

  it('clears a configured model discovery URL when updating a channel', async () => {
    const prisma: any = { channel: {
      findUnique: async () => ({ id: channel.id, deletedAt: null }),
      update: async ({ data }: any) => data
    } }

    await expect(new ChannelsService(prisma).update(channel.id, { modelDiscoveryUrl: null })).resolves.toMatchObject({
      modelDiscoveryUrl: null
    })
  })

  it('archives a channel and all runtime children without deleting history', async () => {
    const { service, state, lockKeys } = lifecycleHarness()

    await expect((service as any).archive(channel.id)).resolves.toMatchObject({ id: channel.id, lifecycle: 'ARCHIVED' })

    expect(state.channel).toMatchObject({ enabled: false, health: 'DISABLED' })
    expect(state.channel.deletedAt).toBeInstanceOf(Date)
    expect(state.keys.every((item: any) => item.deletedAt && !item.enabled && item.health === 'DISABLED')).toBe(true)
    expect(state.models.every((item: any) => item.deletedAt && !item.enabled && !item.probeEnabled && item.health === 'DISABLED')).toBe(true)
    expect(state.rules.every((item: any) => item.deletedAt && !item.enabled)).toBe(true)
    expect(lockKeys).toEqual([`channel:${channel.id}`])
  })

  it('restores a channel as disabled without restoring its children', async () => {
    const { service, state } = lifecycleHarness(true)

    await expect((service as any).restore(channel.id)).resolves.toEqual({ id: channel.id, lifecycle: 'ACTIVE', deletedAt: null })

    expect(state.channel).toMatchObject({ deletedAt: null, enabled: false, health: 'DISABLED' })
    expect(state.keys.every((item: any) => item.deletedAt)).toBe(true)
    expect(state.models.every((item: any) => item.deletedAt)).toBe(true)
  })

  it('excludes archived channels by default and supports archived lifecycle filtering', async () => {
    const active = lifecycleHarness()
    await active.service.list()
    expect(active.recordedWheres[0]).toMatchObject({ deletedAt: null })

    const archived = lifecycleHarness(true)
    await archived.service.list({ lifecycle: 'ARCHIVED' } as any)
    expect(archived.recordedWheres[0]).toMatchObject({ deletedAt: { not: null } })
  })

  it('archives and restores a key only within its owning channel', async () => {
    const { service, state } = lifecycleHarness()
    const keyId = state.keys[0].id

    await expect((service as any).archiveKey(channel.id, keyId)).resolves.toMatchObject({ id: keyId, lifecycle: 'ARCHIVED' })
    expect(state.keys[0]).toMatchObject({ enabled: false, health: 'DISABLED' })
    expect(state.keys[0].deletedAt).toBeInstanceOf(Date)

    await expect((service as any).restoreKey(channel.id, keyId)).resolves.toEqual({ id: keyId, lifecycle: 'ACTIVE', deletedAt: null })
    expect(state.keys[0]).toMatchObject({ deletedAt: null, enabled: false, health: 'DISABLED' })
  })

  it('does not allow an archived key to be edited or enabled', async () => {
    const { service, state } = lifecycleHarness(true)
    state.channel.deletedAt = null

    await expect(service.updateKey(channel.id, state.keys[0].id, { enabled: true })).rejects.toMatchObject({ status: 409 })
  })
})

afterEach(() => vi.unstubAllGlobals())
