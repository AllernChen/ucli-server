import 'reflect-metadata'
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { ModelTestingController } from '../../apps/api/src/model-testing.controller.js'
import { ModelTestingService } from '../../apps/api/src/model-testing.service.js'
import { ROLES_KEY } from '../../packages/security/src/auth.js'

const channelModelId = '20000000-0000-4000-8000-000000000001'

function harness(fetcher: typeof fetch) {
  const probes: any[] = []
  const model: any = {
    id: channelModelId, channelId: '10000000-0000-4000-8000-000000000001', publicModelId: 'gpt-4o',
    upstreamModel: 'fixed-upstream', protocol: 'OPENAI_CHAT', enabled: true, health: 'HEALTHY', consecutiveFailures: 0,
    costRules: [{ id: '40000000-0000-4000-8000-000000000001', priority: 0, daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startMinute: 0, endMinute: 0, validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null,
      createdAt: new Date('2026-01-01T00:00:00Z'), enabled: true, currency: 'USD', inputPerMillion: '1',
      outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0' }],
    publicModel: { prices: [] },
    channel: { id: '10000000-0000-4000-8000-000000000001', enabled: true, baseUrl: 'https://fixed.example',
      maxRetries: 0, timeoutMs: 1000, keySelection: 'ROUND_ROBIN', costTimezone: 'UTC', keys: [{
        id: '30000000-0000-4000-8000-000000000001', plaintext: 'test-key', suffix: '1234', enabled: true,
        health: 'HEALTHY', priority: 0, weight: 1, remainingUsd: null, expiresAt: null, isolatedUntil: null
      }] }
  }
  const prisma: any = {
    channelModel: {
      findUnique: vi.fn(async () => model), update: vi.fn(async ({ data }: any) => Object.assign(model, data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where.consecutiveFailures !== model.consecutiveFailures) return { count: 0 }
        Object.assign(model, data); return { count: 1 }
      })
    },
    channelModelProbe: { create: vi.fn(async ({ data }: any) => { probes.push(data); return data }) },
    usageLog: { create: vi.fn() }
  }
  const service = new ModelTestingService(prisma, fetcher)
  return { service, controller: new ModelTestingController(service), model, probes, prisma }
}

const request = {
  channelModelId,
  messages: [{ role: 'system' as const, content: 'Be concise.' }, { role: 'user' as const, content: 'Hello' }],
  temperature: 0.2, maxTokens: 64
}

describe('admin model test controller', () => {
  it('is restricted to platform administrators', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ModelTestingController)).toEqual(['PLATFORM_ADMIN'])
  })

  it('uses only the selected channel model and persists metadata but no conversation content', async () => {
    const fetcher = vi.fn(async (_url: any, init: any) => {
      expect(String(_url)).toContain('fixed.example')
      expect(JSON.parse(init.body).model).toBe('fixed-upstream')
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Hi' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200 })
    }) as any
    const { controller, probes, prisma } = harness(fetcher)
    const result = await controller.test(request as any, { principal: { sub: 'admin-1' } } as any)
    expect(result).toMatchObject({ channelModelId, assistantMessage: 'Hi', inputTokens: 5, outputTokens: 2,
      estimatedProcurementCostUsd: '0.00000900', appliedCost: { source: 'CHANNEL_COST_RULE' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(probes).toHaveLength(1)
    expect(JSON.stringify(probes)).not.toContain('Be concise.')
    expect(JSON.stringify(probes)).not.toContain('Hello')
    expect(prisma.usageLog.create).not.toHaveBeenCalled()
  })

  it('rejects a conversation whose aggregate content exceeds 100,000 characters', async () => {
    const { service } = harness(vi.fn() as any)
    await expect(service.runConversation({ ...request, messages: [
      { role: 'user', content: 'a'.repeat(60_000) }, { role: 'assistant', content: 'b'.repeat(40_001) }
    ] }, 'admin-1')).rejects.toBeInstanceOf(BadRequestException)
  })

  it('does not switch to another model when the fixed upstream fails', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 503 })) as any
    const { service, probes } = harness(fetcher)
    const result = await service.runConversation(request, 'admin-1')
    expect(result).toMatchObject({ ok: false, statusCode: 503, errorCode: 'UPSTREAM_5XX' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(probes).toHaveLength(1)
  })
})
