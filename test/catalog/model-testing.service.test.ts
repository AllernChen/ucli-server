import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { ModelTestingService } from '../../apps/api/src/model-testing.service.js'

const channelId = '10000000-0000-4000-8000-000000000001'
const channelModelId = '20000000-0000-4000-8000-000000000001'

function makeHarness(protocol = 'OPENAI_CHAT', fetcher: typeof fetch = vi.fn()) {
  const model: any = {
    id: channelModelId, channelId, upstreamModel: 'upstream-model', protocol, enabled: true,
    health: 'HEALTHY', consecutiveFailures: 0, lastTestedAt: null, probeIntervalMinutes: 15,
    costRules: [{
      id: '40000000-0000-4000-8000-000000000001', name: 'base', enabled: true, priority: 0,
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 0,
      inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0',
      currency: 'USD', validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null, createdAt: new Date('2026-01-01T00:00:00Z')
    }],
    publicModel: { prices: [] },
    channel: {
      id: channelId, enabled: true, baseUrl: 'https://provider.example', maxRetries: 0, timeoutMs: 50,
      keySelection: 'ROUND_ROBIN', costTimezone: 'UTC',
      keys: [{
        id: '30000000-0000-4000-8000-000000000001', enabled: true, health: 'HEALTHY',
        suffix: '1234', plaintext: 'test-key', ciphertext: 'cipher', iv: 'iv', tag: 'tag', priority: 0, weight: 1,
        remainingUsd: null, expiresAt: null, isolatedUntil: null
      }]
    }
  }
  const probes: any[] = []
  const prisma: any = {
    channelModel: {
      findUnique: vi.fn(async ({ where }: any) => where.id === model.id ? model : null),
      findMany: vi.fn(async () => [model]),
      update: vi.fn(async ({ data }: any) => Object.assign(model, data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where.id !== model.id) return { count: 0 }
        if (where.consecutiveFailures !== undefined && where.consecutiveFailures !== model.consecutiveFailures) return { count: 0 }
        if (where.lastTestedAt !== undefined && where.lastTestedAt !== model.lastTestedAt) return { count: 0 }
        Object.assign(model, data)
        return { count: 1 }
      })
    },
    channelModelProbe: {
      create: vi.fn(async ({ data }: any) => { probes.push(data); return { id: `probe-${probes.length}`, ...data } }),
      deleteMany: vi.fn(async () => ({ count: 0 }))
    }
  }
  return { service: new ModelTestingService(prisma, fetcher), model, probes, prisma }
}

function okPayload(protocol: string) {
  if (protocol === 'GEMINI') return { candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }
  if (protocol === 'ANTHROPIC_MESSAGES') return { content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 3, output_tokens: 1 } }
  return { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }
}

describe('model testing service', () => {
  for (const protocol of ['OPENAI_CHAT', 'ANTHROPIC_MESSAGES', 'GEMINI']) {
    it(`records a successful ${protocol} probe without prompt or response content`, async () => {
      const fetcher = vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body)
        expect(JSON.stringify(body)).toContain('Reply OK.')
        return new Response(JSON.stringify(okPayload(protocol)), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as any
      const { service, model, probes } = makeHarness(protocol, fetcher)

      const result = await service.testChannelModel(channelModelId, {}, 'actor-1', 'MANUAL')

      expect(result).toMatchObject({ channelModelId, ok: true, statusCode: 200, inputTokens: 3, outputTokens: 1, keySuffix: '1234', health: 'HEALTHY' })
      expect(model).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 0, lastErrorCode: null })
      expect(probes).toHaveLength(1)
      expect(JSON.stringify(probes[0])).not.toContain('Reply OK.')
      expect(JSON.stringify(probes[0])).not.toContain('choices')
    })
  }

  it('marks an authentication failure terminal immediately', async () => {
    const { service, model, probes } = makeHarness('OPENAI_CHAT', vi.fn(async () => new Response('{}', { status: 401 })) as any)
    const result = await service.testChannelModel(channelModelId, {}, 'actor-1', 'MANUAL')
    expect(result).toMatchObject({ ok: false, statusCode: 401, errorCode: 'UPSTREAM_AUTH_FAILED', health: 'UNHEALTHY' })
    expect(model).toMatchObject({ consecutiveFailures: 1, health: 'UNHEALTHY', lastErrorCode: 'UPSTREAM_AUTH_FAILED' })
    expect(probes[0]).toMatchObject({ statusCode: 401, health: 'UNHEALTHY' })
  })

  it('treats ordinary 400 and generic 404 responses as transient', async () => {
    for (const status of [400, 404]) {
      const { service } = makeHarness('OPENAI_CHAT', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'invalid_request' } }), { status })) as any)
      await expect(service.testChannelModel(channelModelId)).resolves.toMatchObject({ health: 'DEGRADED', statusCode: status })
    }
  })

  it('marks an explicit model_not_found response terminal immediately', async () => {
    const { service } = makeHarness('OPENAI_CHAT', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 404 })) as any)
    await expect(service.testChannelModel(channelModelId)).resolves.toMatchObject({
      health: 'UNHEALTHY', statusCode: 404, errorCode: 'UPSTREAM_MODEL_NOT_FOUND'
    })
  })

  it.each([429, 503])('accumulates transient status %s failures', async status => {
    const { service, model } = makeHarness('OPENAI_CHAT', vi.fn(async () => new Response('{}', { status })) as any)
    const first = await service.testChannelModel(channelModelId, {}, null, 'SCHEDULED')
    const second = await service.testChannelModel(channelModelId, {}, null, 'SCHEDULED')
    const third = await service.testChannelModel(channelModelId, {}, null, 'SCHEDULED')
    expect(first.health).toBe('DEGRADED')
    expect(second.health).toBe('DEGRADED')
    expect(third.health).toBe('UNHEALTHY')
    expect(model.consecutiveFailures).toBe(3)
  })

  it('normalizes an aborted upstream request as a timeout probe', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const { service, probes } = makeHarness('OPENAI_CHAT', vi.fn(async () => { throw abort }) as any)
    const result = await service.testChannelModel(channelModelId, {}, null, 'SCHEDULED')
    expect(result).toMatchObject({ ok: false, statusCode: 0, errorCode: 'UPSTREAM_TIMEOUT', health: 'DEGRADED' })
    expect(probes[0]).toMatchObject({ statusCode: null, errorCode: 'UPSTREAM_TIMEOUT' })
  })

  it('batch-tests only models belonging to the channel and isolates failures', async () => {
    const { service } = makeHarness('OPENAI_CHAT', vi.fn(async () => new Response(JSON.stringify(okPayload('OPENAI_CHAT')), { status: 200 })) as any)
    const results = await service.testChannelModels(channelId, [channelModelId], 'actor-1')
    expect(results).toEqual([expect.objectContaining({ channelModelId, ok: true })])
    await expect(service.testChannelModels('10000000-0000-4000-8000-000000000099', [channelModelId], 'actor-1'))
      .rejects.toMatchObject({ status: 400 })
  })

  it('forwards real upstream stream deltas and records first-token metrics', async () => {
    const upstream = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`,
      'data: [DONE]\n\n'
    ].join('')
    const fetcher = vi.fn(async () => new Response(upstream, {
      status: 200, headers: { 'content-type': 'text/event-stream' }
    })) as any
    const { service, probes } = makeHarness('OPENAI_CHAT', fetcher)
    const deltas: string[] = []
    const result = await service.runConversation({
      channelModelId, messages: [{ role: 'user', content: 'Hi' }], temperature: 0, maxTokens: 16, stream: true
    }, 'actor-1', undefined, content => deltas.push(content))
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(result).toMatchObject({ assistantMessage: 'Hello', inputTokens: 4, outputTokens: 2, statusCode: 200 })
    expect(result.firstTokenMs).toEqual(expect.any(Number))
    expect(probes.at(-1)).toMatchObject({ source: 'CONVERSATION', firstTokenMs: expect.any(Number) })
  })

  it('claims a due scheduled probe so concurrent workers do not test it twice', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(okPayload('OPENAI_CHAT')), { status: 200 })) as any
    const { service } = makeHarness('OPENAI_CHAT', fetcher)
    const now = new Date('2026-08-21T00:00:00Z')
    const results = await Promise.all([service.testDueChannelModels(now), service.testDueChannelModels(now)])
    expect(results.flat()).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
