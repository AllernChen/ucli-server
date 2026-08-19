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

function makeAbility() {
  return { channelId: 'ch1', publicModelId: 'gpt-4o', upstreamModel: 'gpt-4o-up', protocol: 'OPENAI_CHAT',
    supportsStream: true, supportsTools: true, enabled: true,
    channel: { id: 'ch1', priority: 0, weight: 1, health: 'HEALTHY', enabled: true, circuitOpenUntil: null,
      baseUrl: 'https://upstream.example', timeoutMs: 1000, maxRetries: 0, keySelection: 'WEIGHTED_RANDOM',
      keys: [makeKey()] } }
}

function makeHarness(overrides: { prisma?: Record<string, any>; quota?: Record<string, any> } = {}) {
  const prisma = {
    publicModel: { findFirst: vi.fn().mockResolvedValue({
      id: 'gpt-4o', enabled: true, policies: [],
      prices: [{ id: 'p1', inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0' }]
    }) },
    channelAbility: { findMany: vi.fn().mockResolvedValue([makeAbility()]) },
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

afterEach(() => { vi.unstubAllGlobals() })

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
    const { service } = makeHarness({ prisma: { channelAbility: { findMany: vi.fn().mockResolvedValue([]) } } })
    await expect(service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any }))
      .rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('writes a 503 usage log and opens the circuit when the upstream fails', async () => {
    const { service, prisma } = makeHarness()
    vi.stubGlobal('fetch', async () => new Response('{"error":"down"}', { status: 503 }))
    await expect(service.relay({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [] }, headers: {}, principal, response: makeResponse() as any }))
      .rejects.toThrow()
    const data = prisma.usageLog.create.mock.calls[0][0].data
    expect(data.statusCode).toBe(503)
    expect(data.routeAttempts).toBe(1)
    expect(prisma.channelKey.updateMany).toHaveBeenCalled()
    expect(prisma.channel.update).toHaveBeenCalled()
  })
})
