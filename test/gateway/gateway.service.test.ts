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

function makeAbility(overrides: Record<string, any> = {}) {
  const channelId = overrides.channelId || 'ch1'
  const inputPerMillion = overrides.inputPerMillion || '1'
  const outputPerMillion = overrides.outputPerMillion || '2'
  return { id: overrides.id || 'cm1', channelId, publicModelId: 'gpt-4o', upstreamModel: overrides.upstreamModel || 'gpt-4o-up', protocol: 'OPENAI_CHAT',
    supportsStream: true, supportsTools: true, enabled: true, health: overrides.health || 'HEALTHY',
    costRules: overrides.costRules ?? [{ id: overrides.costRuleId || 'cr1', priority: 0, daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startMinute: 0, endMinute: 0, validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null,
      createdAt: new Date('2026-01-01T00:00:00Z'), enabled: true, currency: 'USD', inputPerMillion,
      outputPerMillion, cachedPerMillion: '0', reasoningPerMillion: '0' }],
    channel: { id: channelId, priority: overrides.priority ?? 0, weight: 1, health: 'HEALTHY', enabled: true, circuitOpenUntil: null,
      baseUrl: 'https://upstream.example', timeoutMs: 1000, maxRetries: 0, keySelection: 'WEIGHTED_RANDOM',
      costTimezone: 'UTC', keys: [{ ...makeKey(), id: overrides.keyId || 'k1', channelId }] }, ...overrides.model }
}

function makeHarness(overrides: { prisma?: Record<string, any>; quota?: Record<string, any> } = {}) {
  const prisma = {
    publicModel: { findFirst: vi.fn().mockResolvedValue({
      id: 'gpt-4o', enabled: true, policies: [],
      prices: [{ id: 'p1', inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0' }]
    }) },
    channelModel: { findMany: vi.fn().mockResolvedValue([makeAbility()]) },
    quotaPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    usageLog: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    channelKey: { updateMany: vi.fn().mockResolvedValue({}) },
    channel: { update: vi.fn().mockResolvedValue({}) },
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

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('gateway service orchestration', () => {
  it('relays a successful request, writes usage and marks the channel healthy', async () => {
    const { service, prisma } = makeHarness()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 2 } }), { status: 200 }))
    const response = makeResponse()
    await service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: response as any })
    expect(response.status).toHaveBeenCalledWith(200)
    expect(response.setHeader).toHaveBeenCalledWith('x-ucli-request-id', expect.any(String))
    expect(response.send).toHaveBeenCalled()
    const data = prisma.usageLog.create.mock.calls[0][0].data
    expect(data.publicModelId).toBe('gpt-4o')
    expect(data.statusCode).toBe(200)
    expect(data.inputTokens).toBe(7)
    expect(data.outputTokens).toBe(2)
    expect(data.usageSource).toBe('UPSTREAM')
    expect(data.channelModelId).toBe('cm1')
    expect(data.channelCostRuleId).toBe('cr1')
    expect(data.priceVersionId).toBeUndefined()
    expect(data.costUsd).toBe('0.00001100')
    expect(data.costSnapshot).toMatchObject({ source: 'CHANNEL_COST_RULE', inputPerMillion: '1', outputPerMillion: '2', currency: 'USD', timezone: 'UTC' })
    expect(prisma.channelKey.updateMany).toHaveBeenCalled()
    expect(prisma.channel.update).toHaveBeenCalled()
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

  it('returns 503 when no healthy channel is available', async () => {
    const { service } = makeHarness({ prisma: { channelModel: { findMany: vi.fn().mockResolvedValue([]) } } })
    await expect(service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any }))
      .rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('writes a 503 usage log and opens the circuit when the upstream fails', async () => {
    const { service, prisma } = makeHarness()
    vi.stubGlobal('fetch', async () => new Response('{"error":"down"}', { status: 503 }))
    await expect(service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any }))
      .rejects.toMatchObject({ status: 503 })
    const data = prisma.usageLog.create.mock.calls[0][0].data
    expect(data.statusCode).toBe(503)
    expect(data.routeAttempts).toBe(1)
    expect(data.channelModelId).toBe('cm1')
    expect(data.costUsd).toBe('0')
    expect(prisma.channelKey.updateMany).toHaveBeenCalled()
    expect(prisma.channel.update).toHaveBeenCalled()
  })

  it('only queries channel models that are healthy or degraded', async () => {
    const { service, prisma } = makeHarness()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }))
    await service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any })
    expect(prisma.channelModel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ health: { in: ['HEALTHY', 'DEGRADED'] } })
    }))
  })

  it('uses the public model price only as a compatibility fallback', async () => {
    const { service, prisma } = makeHarness({ prisma: { channelModel: { findMany: vi.fn().mockResolvedValue([makeAbility({ costRules: [] })]) } } })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }))
    await service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any })
    const data = prisma.usageLog.create.mock.calls[0][0].data
    expect(data.channelCostRuleId).toBeUndefined()
    expect(data.priceVersionId).toBe('p1')
    expect(data.costSnapshot).toMatchObject({ source: 'PUBLIC_MODEL_FALLBACK', inputPerMillion: '1', outputPerMillion: '2' })
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
      publicModel: { findFirst: vi.fn().mockResolvedValue({ id: 'gpt-4o', enabled: true, policies: [], prices: [] }) },
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
