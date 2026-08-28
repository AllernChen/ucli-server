import 'reflect-metadata'
import { HttpException, ServiceUnavailableException } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayService } from '../../apps/gateway/src/gateway.service.js'
import { encryptSecret } from '../../packages/security/src/envelope-crypto.js'

const MASTER_KEY = Buffer.alloc(32)
process.env.MASTER_KEY = MASTER_KEY.toString('base64')

const principal = { sub: 'acct1', organizationId: 'org1', deviceId: 'dev1', role: 'MEMBER' as const }

function makeKey() {
  const encrypted = encryptSecret('upstream-secret', MASTER_KEY)
  return { id: 'k1', channelId: 'ch1', ...encrypted, suffix: 'cret', priority: 0, weight: 1,
    enabled: true, health: 'HEALTHY', remainingUsd: null, expiresAt: null, isolatedUntil: null, lastUsedAt: null }
}

function makeProtocolMapping(protocol = 'OPENAI_CHAT') {
  return {
    protocol, enabled: true, deletedAt: null,
    channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }] }
  }
}

function makeAbility(overrides: Record<string, any> = {}) {
  const channelId = overrides.channelId || 'ch1'
  const inputPerMillion = overrides.inputPerMillion || '1'
  const outputPerMillion = overrides.outputPerMillion || '2'
  return { id: overrides.id || 'cm1', channelId, publicModelId: 'gpt-4o', upstreamModel: overrides.upstreamModel || 'gpt-4o-up', protocol: 'OPENAI_CHAT',
    supportsStream: true, supportsTools: true, enabled: true, health: overrides.health || 'HEALTHY',
    costRules: overrides.costRules ?? [{ id: overrides.costRuleId || 'cr1', priority: 0, daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startMinute: 0, endMinute: 0, validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null,
      createdAt: new Date('2026-01-01T00:00:00Z'), enabled: true, currency: 'CNY', inputPerMillion,
      outputPerMillion, cachedPerMillion: '0', reasoningPerMillion: '0' }],
    channel: { id: channelId, priority: overrides.priority ?? 0, weight: 1, health: 'HEALTHY', enabled: true, circuitOpenUntil: null,
      baseUrl: 'https://upstream.example', timeoutMs: 1000, maxRetries: 0, keySelection: 'WEIGHTED_RANDOM',
      costTimezone: 'UTC', keys: [{ ...makeKey(), id: overrides.keyId || 'k1', channelId }] }, ...overrides.model }
}

function makeHarness(overrides: { prisma?: Record<string, any>; quota?: Record<string, any> } = {}) {
  const prisma = {
    publicModel: {
      findMany: vi.fn().mockResolvedValue([{
        id: 'gpt-4o', displayName: 'GPT-4o', contextSize: 128000, enabled: true, policies: [], channelModels: [{
          protocol: 'OPENAI_RESPONSES', enabled: true, deletedAt: null,
          channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }] }
        }]
      }]),
      findFirst: vi.fn().mockResolvedValue({
        id: 'gpt-4o', enabled: true, policies: [],
        channelModels: [makeProtocolMapping()],
        prices: [{ id: 'p1', inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0', currency: 'CNY' }]
      })
    },
    channelModel: { findMany: vi.fn().mockResolvedValue([makeAbility()]) },
    quotaPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    usageLog: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    channelKey: { updateMany: vi.fn().mockResolvedValue({}) },
    channel: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    ...overrides.prisma
  }
  const quota = {
    reserve: vi.fn().mockResolvedValue({ keys: {}, estimate: {}, thresholds: [] }),
    settle: vi.fn().mockResolvedValue({ exceeded: false }),
    release: vi.fn().mockResolvedValue({}),
    ...overrides.quota
  }
  const service = new GatewayService(prisma as any, quota as any)
  return { service, prisma, quota }
}

function makeResponse() {
  return { status: vi.fn(), setHeader: vi.fn(), send: vi.fn(), end: vi.fn(), once: vi.fn(), writableFinished: true }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('gateway service orchestration', () => {
  it('publishes accessible active models with their configured client protocols', async () => {
    const { service, prisma } = makeHarness()

    await expect(service.models({ organizationId: principal.organizationId, accountId: principal.sub, role: principal.role }))
      .resolves.toEqual([{
        id: 'gpt-4o', displayName: 'GPT-4o', contextSize: 128000, protocols: ['openai_responses']
      }])

    expect(prisma.publicModel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ enabled: true, deletedAt: null, contextSize: { gt: 0 } })
    }))
  })

  it('relays a successful request, writes usage and marks the channel healthy', async () => {
    const { service, prisma } = makeHarness()
    let upstreamRequestId: string | undefined
    vi.stubGlobal('fetch', async (_input: URL | RequestInfo, init?: RequestInit) => {
      upstreamRequestId = (init?.headers as Record<string, string>)['x-ucli-request-id']
      return new Response(JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 2 } }), {
        status: 200, headers: { 'x-ucli-request-id': 'upstream-id', 'cache-control': 'public, max-age=3600' }
      })
    })
    const response = makeResponse()
    await service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: response as any })
    expect(response.status).toHaveBeenCalledWith(200)
    expect(response.setHeader).toHaveBeenCalledWith('x-ucli-request-id', expect.any(String))
    expect(response.setHeader).toHaveBeenCalledWith('cache-control', 'no-store')
    expect(response.send).toHaveBeenCalled()
    const data = prisma.usageLog.create.mock.calls[0][0].data
    const externalRequestId = response.setHeader.mock.calls.filter(([name]) => name === 'x-ucli-request-id').at(-1)?.[1]
    expect(upstreamRequestId).toBe(externalRequestId)
    expect(data.requestId).toBe(externalRequestId)
    expect(externalRequestId).not.toBe('upstream-id')
    expect(response.setHeader.mock.calls.filter(([name]) => name === 'cache-control').at(-1)?.[1]).toBe('no-store')
    expect(data.publicModelId).toBe('gpt-4o')
    expect(data.statusCode).toBe(200)
    expect(data.inputTokens).toBe(7)
    expect(data.outputTokens).toBe(2)
    expect(data.usageSource).toBe('UPSTREAM')
    expect(data.channelModelId).toBe('cm1')
    expect(data.channelCostRuleId).toBe('cr1')
    expect(data.priceVersionId).toBeUndefined()
    expect(data.costUsd).toBe('0.00001100')
    expect(data.costSnapshot).toMatchObject({ source: 'CHANNEL_COST_RULE', inputPerMillion: '1', outputPerMillion: '2', currency: 'CNY', timezone: 'UTC' })
    expect(prisma.channelKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deletedAt: null })
    }))
    expect(prisma.channel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deletedAt: null })
    }))
  })

  it('rejects with 429 when a quota policy denies the request', async () => {
    const { service, prisma } = makeHarness({
      prisma: { quotaPolicy: { findMany: vi.fn().mockResolvedValue([{ id: 'q1', dailyTokens: 100n }]) } },
      quota: { reserve: vi.fn().mockRejectedValue(new HttpException('DAILY_TOKEN_QUOTA', 429)) }
    })
    await expect(service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any }))
      .rejects.toMatchObject({ status: 429 })
    expect(prisma.auditLog.create).toHaveBeenCalled()
    expect(prisma.usageLog.create).not.toHaveBeenCalled()
  })

  it('returns model_protocol_unavailable before candidate or quota work', async () => {
    const { service, prisma, quota } = makeHarness()
    const response = makeResponse()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const error = await service.relay({ protocol: 'openai_responses', body: { model: 'gpt-4o', input: [] }, headers: {}, principal, response: response as any })
      .catch(error => error)

    expect(error.getResponse()).toEqual({
      statusCode: 503,
      code: 'model_protocol_unavailable',
      message: 'The model does not support the requested protocol',
      requestId: expect.any(String),
      retryable: false
    })
    const requestId = error.getResponse().requestId
    expect(prisma.channelModel.findMany).not.toHaveBeenCalled()
    expect(quota.reserve).not.toHaveBeenCalled()
    expect(prisma.usageLog.create).not.toHaveBeenCalled()
    expect(response.setHeader).toHaveBeenCalledWith('cache-control', 'no-store')
    expect(response.setHeader).toHaveBeenCalledWith('x-ucli-request-id', requestId)
    expect(warn).toHaveBeenCalledWith('gateway-route-failed', {
      event: 'gateway_route_failed', requestId, organizationId: 'org1', accountId: 'acct1', deviceId: 'dev1',
      publicModelId: 'gpt-4o', protocol: 'openai_responses', code: 'model_protocol_unavailable',
      routeAttempts: 0, timestamp: expect.any(String)
    })
  })

  it('returns model_channel_unavailable when a compatible model has no candidates', async () => {
    const { service, prisma, quota } = makeHarness({ prisma: { channelModel: { findMany: vi.fn().mockResolvedValue([]) } } })
    const response = makeResponse()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const error = await service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: response as any })
      .catch(error => error)

    expect(error.getResponse()).toEqual({
      statusCode: 503,
      code: 'model_channel_unavailable',
      message: 'No model channel is currently available',
      retryable: true,
      requestId: expect.any(String)
    })
    const requestId = error.getResponse().requestId
    expect(quota.reserve).not.toHaveBeenCalled()
    expect(prisma.usageLog.create).not.toHaveBeenCalled()
    expect(response.setHeader).toHaveBeenCalledWith('cache-control', 'no-store')
    expect(response.setHeader).toHaveBeenCalledWith('x-ucli-request-id', requestId)
    expect(warn).toHaveBeenCalledWith('gateway-route-failed', {
      event: 'gateway_route_failed', requestId, organizationId: 'org1', accountId: 'acct1', deviceId: 'dev1',
      publicModelId: 'gpt-4o', protocol: 'openai_chat', code: 'model_channel_unavailable',
      routeAttempts: 0, timestamp: expect.any(String)
    })
  })

  it('keeps the access-control 404 ahead of protocol disclosure and request metadata', async () => {
    const { service, prisma, quota } = makeHarness({ prisma: {
      publicModel: { findFirst: vi.fn().mockResolvedValue(null) }
    } })
    const response = makeResponse()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(service.relay({ protocol: 'openai_responses', body: { model: 'hidden-model', input: [] }, headers: {}, principal, response: response as any }))
      .rejects.toMatchObject({ status: 404 })

    expect(prisma.channelModel.findMany).not.toHaveBeenCalled()
    expect(quota.reserve).not.toHaveBeenCalled()
    expect(response.setHeader).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('writes a 503 usage log and opens the circuit when the upstream fails', async () => {
    const { service, prisma } = makeHarness()
    vi.stubGlobal('fetch', async () => new Response('{"error":"down"}', { status: 503 }))
    const response = makeResponse()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = await service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: response as any })
      .catch(error => error)
    expect(error.getResponse()).toEqual({
      statusCode: 503,
      code: 'upstream_unavailable',
      message: 'No upstream channel succeeded',
      retryable: true,
      requestId: expect.any(String)
    })
    const requestId = error.getResponse().requestId
    expect(response.setHeader).toHaveBeenCalledWith('cache-control', 'no-store')
    expect(response.setHeader).toHaveBeenCalledWith('x-ucli-request-id', requestId)
    const data = prisma.usageLog.create.mock.calls[0][0].data
    expect(data).toMatchObject({ requestId, statusCode: 503, routeAttempts: 1, errorCode: 'UPSTREAM_UNAVAILABLE' })
    expect(data.channelModelId).toBe('cm1')
    expect(data.costUsd).toBe('0')
    expect(warn).toHaveBeenCalledWith('gateway-route-failed', {
      event: 'gateway_route_failed', requestId, organizationId: 'org1', accountId: 'acct1', deviceId: 'dev1',
      publicModelId: 'gpt-4o', protocol: 'openai_chat', code: 'upstream_unavailable',
      routeAttempts: 1, timestamp: expect.any(String)
    })
    expect(prisma.channelKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deletedAt: null })
    }))
    expect(prisma.channel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deletedAt: null })
    }))
  })

  it('only queries channel models that are healthy or degraded', async () => {
    const { service, prisma } = makeHarness()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }))
    await service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any })
    expect(prisma.channelModel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ health: { in: ['HEALTHY', 'DEGRADED'] } })
    }))
  })

  it('routes only through active models, channels, keys, cost rules and fallback prices', async () => {
    const { service, prisma } = makeHarness()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }))

    await service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any })

    expect(prisma.publicModel.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'gpt-4o', enabled: true, deletedAt: null }),
      include: expect.objectContaining({
        prices: expect.objectContaining({ where: expect.objectContaining({ deletedAt: null, enabled: true }) })
      })
    }))
    expect(prisma.channelModel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        publicModelId: 'gpt-4o', enabled: true, deletedAt: null,
        protocol: { in: ['OPENAI_CHAT', 'GEMINI'] },
        publicModel: expect.objectContaining({ deletedAt: null }),
        channel: expect.objectContaining({ enabled: true, deletedAt: null })
      }),
      include: expect.objectContaining({
        costRules: expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
        channel: expect.objectContaining({
          include: expect.objectContaining({ keys: expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }) })
        })
      })
    }))
  })

  it('uses the public model price only as a compatibility fallback', async () => {
    const { service, prisma } = makeHarness({ prisma: { channelModel: { findMany: vi.fn().mockResolvedValue([makeAbility({ costRules: [] })]) } } })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }))
    await service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any })
    const data = prisma.usageLog.create.mock.calls[0][0].data
    expect(data.channelCostRuleId).toBeUndefined()
    expect(data.priceVersionId).toBe('p1')
    expect(data.costSnapshot).toMatchObject({ source: 'PUBLIC_MODEL_FALLBACK', inputPerMillion: '1', outputPerMillion: '2', currency: 'CNY' })
  })

  it('reserves the maximum candidate procurement cost but settles the actual selected candidate cost', async () => {
    const cheap = makeAbility({ id: 'cm-cheap', costRuleId: 'cr-cheap', priority: 10, inputPerMillion: '1', outputPerMillion: '4' })
    const expensive = makeAbility({ id: 'cm-expensive', channelId: 'ch2', keyId: 'k2', costRuleId: 'cr-expensive', inputPerMillion: '3', outputPerMillion: '2' })
    const policy = { id: 'q1', dailyTokens: 100000n }
    const { service, quota, prisma } = makeHarness({ prisma: {
      channelModel: { findMany: vi.fn().mockResolvedValue([cheap, expensive]) },
      quotaPolicy: { findMany: vi.fn().mockResolvedValue([policy]) }
    } })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 }))
    const body = { model: 'gpt-4o', messages: [], max_tokens: 100 }
    await service.relay({ protocol: 'openai_chat', body, headers: {}, principal, response: makeResponse() as any })
    const estimatedInput = Buffer.byteLength(JSON.stringify(body), 'utf8')
    expect(quota.reserve.mock.calls[0][1].costMicroUsd).toBe(Math.round((estimatedInput * 3 + 100 * 4) / 1_000_000 * 1_000_000))
    expect(quota.settle.mock.calls[0][1].costMicroUsd).toBe(30)
    expect(prisma.usageLog.create.mock.calls[0][0].data).toMatchObject({ channelModelId: 'cm-cheap', channelCostRuleId: 'cr-cheap', costUsd: '0.00003000' })
  })

  it('does not route a candidate when neither channel nor fallback procurement cost exists', async () => {
    const { service } = makeHarness({ prisma: {
      publicModel: { findFirst: vi.fn().mockResolvedValue({
        id: 'gpt-4o', enabled: true, policies: [], channelModels: [makeProtocolMapping()], prices: []
      }) },
      channelModel: { findMany: vi.fn().mockResolvedValue([makeAbility({ costRules: [] })]) }
    } })
    await expect(service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any }))
      .rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('isolates a candidate with a corrupted cost rule and routes another valid candidate', async () => {
    const damaged = makeAbility({ id: 'cm-bad', priority: 10, inputPerMillion: '-1' })
    const healthy = makeAbility({ id: 'cm-good', channelId: 'ch2', keyId: 'k2', priority: 0 })
    const { service, prisma } = makeHarness({ prisma: {
      channelModel: { findMany: vi.fn().mockResolvedValue([damaged, healthy]) }
    } })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }))
    await service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any })
    expect(prisma.usageLog.create.mock.calls[0][0].data.channelModelId).toBe('cm-good')
  })
})
