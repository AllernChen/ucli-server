import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerService } from '../../apps/worker/src/worker.service.js'
import { encryptSecret } from '../../packages/security/src/envelope-crypto.js'

function makeHarness(options: { discoveryUrl?: string; status?: number; autoDisable?: boolean } = {}) {
  const masterKey = Buffer.alloc(32, 7)
  process.env.MASTER_KEY = masterKey.toString('base64')
  const encrypted = encryptSecret('upstream-key', masterKey)
  const channel = {
    id: '10000000-0000-4000-8000-000000000001', protocol: 'OPENAI',
    baseUrl: 'https://api.deepseek.com', modelDiscoveryUrl: options.discoveryUrl ?? null,
    autoDisable: options.autoDisable ?? true,
    keys: [{ id: '20000000-0000-4000-8000-000000000001', enabled: true, health: 'HEALTHY', ...encrypted }],
    channelModels: [{ id: '30000000-0000-4000-8000-000000000001', enabled: true }]
  }
  const updates: any[] = []
  const keyUpdates: any[] = []
  const prisma: any = {
    channel: {
      findMany: async () => [channel],
      updateMany: async (args: any) => { updates.push(args); return { count: 1 } }
    },
    channelKey: {
      update: async (args: any) => { keyUpdates.push(args); return args.data }
    }
  }
  const fetcher = vi.fn(async () => new Response(null, { status: options.status ?? 200 }))
  vi.stubGlobal('fetch', fetcher)
  return { service: new WorkerService(prisma, { testDueChannelModels: async () => [] } as any), fetcher, updates, keyUpdates }
}

afterEach(() => vi.unstubAllGlobals())

describe('worker channel probes', () => {
  it('never sends a channel key to a cross-origin discovery URL', async () => {
    const { service, fetcher, updates } = makeHarness({ discoveryUrl: 'https://credentials.example/models' })

    await service.probeChannels()

    expect(fetcher).not.toHaveBeenCalled()
    expect(updates.at(-1)?.data).toMatchObject({ health: 'DEGRADED' })
  })

  it('marks rejected credentials unhealthy and isolates the key when auto-disable is enabled', async () => {
    const { service, updates, keyUpdates } = makeHarness({ status: 401, autoDisable: true })

    await service.probeChannels()

    expect(updates.at(-1)?.data).toMatchObject({ health: 'UNHEALTHY' })
    expect(keyUpdates).toEqual([expect.objectContaining({
      where: { id: '20000000-0000-4000-8000-000000000001' }, data: { health: 'DISABLED' }
    })])
  })
})
