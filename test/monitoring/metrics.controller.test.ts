import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'

const { redisMock } = vi.hoisted(() => ({ redisMock: vi.fn() }))
vi.mock('ioredis', () => ({ default: redisMock }))

import { MetricsController } from '../../packages/monitoring/src/metrics.controller.js'

describe('MetricsController', () => {
  it('healthz reports ok when postgres and redis respond', async () => {
    redisMock.mockReturnValue({ status: 'wait', connect: vi.fn().mockResolvedValue(undefined), ping: vi.fn().mockResolvedValue('PONG'), quit: vi.fn() })
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) }
    const controller = new MetricsController(prisma as any)
    await expect(controller.health()).resolves.toMatchObject({ status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' }, timestamp: expect.any(String) })
  })
  it('does not return a healthy result when an actual dependency check fails', async () => {
    redisMock.mockReturnValue({ status: 'ready', ping: vi.fn().mockRejectedValue(new Error('redis check failed')), quit: vi.fn() })
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) }
    await expect(new MetricsController(prisma as any).health()).rejects.toThrow('redis check failed')
    prisma.$queryRaw.mockRejectedValue(new Error('postgres check failed'))
    await expect(new MetricsController(prisma as any).health()).rejects.toThrow('postgres check failed')
  })
  it('metrics exposes the registry content', async () => {
    redisMock.mockReturnValue({ status: 'end', quit: vi.fn() })
    const controller = new MetricsController({} as any)
    const out = await controller.metrics()
    expect(out).toContain('ucli_process_cpu_seconds_total')
  })
})
