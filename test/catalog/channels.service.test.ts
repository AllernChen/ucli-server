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

  it('clears a configured model discovery URL when updating a channel', async () => {
    const prisma: any = { channel: { update: async ({ data }: any) => data } }

    await expect(new ChannelsService(prisma).update(channel.id, { modelDiscoveryUrl: null })).resolves.toMatchObject({
      modelDiscoveryUrl: null
    })
  })
})

afterEach(() => vi.unstubAllGlobals())
