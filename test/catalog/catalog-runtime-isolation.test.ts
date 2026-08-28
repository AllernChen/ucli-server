import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientController } from '../../apps/api/src/client.controller.js'
import { MonitoringController } from '../../apps/api/src/monitoring.controller.js'
import { WorkerService } from '../../apps/worker/src/worker.service.js'
import { encryptSecret } from '../../packages/security/src/envelope-crypto.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function workerChannel(modelDiscoveryUrl = 'https://api.deepseek.com/models') {
  const masterKey = Buffer.alloc(32, 7)
  vi.stubEnv('MASTER_KEY', masterKey.toString('base64'))
  const encrypted = encryptSecret('test-key', masterKey)
  return {
    id: 'channel-1', enabled: true, protocol: 'ANTHROPIC', baseUrl: 'https://api.deepseek.com/anthropic',
    modelDiscoveryUrl, keys: [{ id: 'key-1', enabled: true, health: 'HEALTHY', ...encrypted }],
    channelModels: [{ id: 'channel-model-1', enabled: true }]
  }
}

describe('catalog runtime isolation', () => {
  it('employee bootstrap publishes configured protocols for accessible public models', async () => {
    const prisma: any = {
      organization: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'org-1', name: '研发部', timezone: 'Asia/Shanghai' }) },
      publicModel: { findMany: vi.fn().mockResolvedValue([
        {
          id: 'model-1', displayName: 'Model 1', contextSize: 128000, policies: [], channelModels: [
            { protocol: 'OPENAI_RESPONSES', enabled: true, deletedAt: null, channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }] } },
            { protocol: 'GEMINI', enabled: true, deletedAt: null, channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }] } },
            { protocol: 'OPENAI_CHAT', enabled: false, deletedAt: null, channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }] } },
            { protocol: 'ANTHROPIC_MESSAGES', enabled: true, deletedAt: new Date(), channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }] } },
            { protocol: 'ANTHROPIC_MESSAGES', enabled: true, deletedAt: null, channel: { enabled: true, deletedAt: null, keys: [] } }
          ]
        },
        { id: 'model-2', displayName: 'Model 2', contextSize: 128000, policies: [], channelModels: [] }
      ]) }
    }
    const controller = new ClientController(prisma)

    const result = await controller.bootstrap({ principal: { sub: 'account-1', organizationId: 'org-1', role: 'MEMBER' } })

    expect(result.models).toEqual([{
      id: 'model-1', displayName: 'Model 1', contextSize: 128000,
      protocols: ['openai_responses', 'openai_chat']
    }])
    expect(prisma.publicModel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { enabled: true, deletedAt: null, contextSize: { gt: 0 } },
      include: expect.objectContaining({
        policies: true,
        channelModels: expect.objectContaining({
          select: expect.objectContaining({ protocol: true, enabled: true, deletedAt: true, channel: expect.any(Object) })
        })
      })
    }))
  })

  it('health monitoring excludes archived channels and keys', async () => {
    const prisma: any = {
      channel: { findMany: vi.fn().mockResolvedValue([]) },
      usageLog: {
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({ _avg: { durationMs: null, firstTokenMs: null } })
      }
    }
    const controller = new MonitoringController(prisma)

    await controller.health()

    expect(prisma.channel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deletedAt: null }),
      include: expect.objectContaining({
        keys: expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) })
      })
    }))
  })

  it('legacy channel probes select only active channels, keys and channel models', async () => {
    const prisma: any = { channel: { findMany: vi.fn().mockResolvedValue([]) } }
    const worker = new WorkerService(prisma, { testDueChannelModels: vi.fn() } as any)

    await worker.probeChannels()

    expect(prisma.channel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ enabled: true, deletedAt: null }),
      include: expect.objectContaining({
        keys: expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
        channelModels: expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null, publicModel: expect.objectContaining({ deletedAt: null }) })
        })
      })
    }))
  })

  it('legacy channel probes use the configured model discovery URL', async () => {
    const fetcher = vi.fn(async () => new Response('{"data":[]}', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const prisma: any = {
      channel: {
        findMany: vi.fn().mockResolvedValue([workerChannel()]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      channelKey: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    }
    const worker = new WorkerService(prisma, { testDueChannelModels: vi.fn() } as any)

    await worker.probeChannels()

    expect(fetcher).toHaveBeenCalledWith(new URL('https://api.deepseek.com/models'), expect.objectContaining({
      redirect: 'error'
    }))
    expect(prisma.channel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ health: 'HEALTHY', circuitOpenUntil: null })
    }))
  })

  it('discovery transport failures degrade a channel without opening its request circuit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const prisma: any = {
      channel: {
        findMany: vi.fn().mockResolvedValue([workerChannel()]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      channelKey: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    }
    const worker = new WorkerService(prisma, { testDueChannelModels: vi.fn() } as any)

    await worker.probeChannels()

    expect(prisma.channel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ health: 'DEGRADED', circuitOpenUntil: null })
    }))
  })

  it('marks discovery authentication failures unhealthy without disabling keys when auto-disable is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    const prisma: any = {
      channel: {
        findMany: vi.fn().mockResolvedValue([workerChannel()]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      channelKey: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    }
    const worker = new WorkerService(prisma, { testDueChannelModels: vi.fn() } as any)

    await worker.probeChannels()

    expect(prisma.channelKey.updateMany).not.toHaveBeenCalled()
    expect(prisma.channel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ health: 'UNHEALTHY', circuitOpenUntil: null })
    }))
  })
})
