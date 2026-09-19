import 'reflect-metadata'
import { HttpException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { GatewayService } from '../../apps/gateway/src/gateway.service.js'
import { encryptSecret } from '../../packages/security/src/envelope-crypto.js'
const MASTER_KEY = Buffer.alloc(32)
process.env.MASTER_KEY = MASTER_KEY.toString('base64')

const principal = {
  sub: '11111111-1111-4111-8111-111111111111', organizationId: 'org-1', role: 'MEMBER' as const,
  credentialType: 'API_KEY' as const, apiKeyId: 'key-1',
  groupId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333'
}

function makeAbility() {
  const encrypted = encryptSecret('upstream-secret', MASTER_KEY)
  return { id: 'cm1', channelId: 'ch1', publicModelId: 'gpt-4o', upstreamModel: 'gpt-4o-up', protocol: 'OPENAI_CHAT',
    supportsStream: true, supportsTools: true, enabled: true, health: 'HEALTHY',
    costRules: [{ id: 'cr1', priority: 0, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 0,
      validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null, createdAt: new Date(), enabled: true,
      currency: 'CNY', inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0', reasoningPerMillion: '0' }],
    channel: { id: 'ch1', priority: 0, weight: 1, health: 'HEALTHY', enabled: true, circuitOpenUntil: null,
      baseUrl: 'https://upstream.example', timeoutMs: 1000, maxRetries: 0, keySelection: 'WEIGHTED_RANDOM',
      costTimezone: 'UTC', keys: [{ id: 'k1', channelId: 'ch1', ...encrypted,
        suffix: 'cret', priority: 0, weight: 1, enabled: true, health: 'HEALTHY', remainingUsd: null,
        expiresAt: null, isolatedUntil: null, lastUsedAt: null }] } }
}

function makeHarness(projectBudget: Record<string, any>) {
  const prisma = {
    publicModel: { findFirst: vi.fn().mockResolvedValue({
      id: 'gpt-4o', enabled: true, contextSize: 8192, policies: [],
      channelModels: [{ protocol: 'OPENAI_CHAT', enabled: true, deletedAt: null,
        channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }] } }],
      prices: []
    }) },
    channelModel: { findMany: vi.fn().mockResolvedValue([makeAbility()]) },
    quotaPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    usageLog: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    channelKey: { updateMany: vi.fn().mockResolvedValue({}) },
    channel: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    groupMember: { findFirst: vi.fn().mockResolvedValue({
      role: 'MEMBER', status: 'ACTIVE', account: { status: 'ACTIVE' },
      group: { models: [{ publicModelId: 'gpt-4o' }] }
    }) },
    account: { findUniqueOrThrow: vi.fn().mockResolvedValue({ displayName: 'Employee' }) },
    usageGroup: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: '广东-市局区域' }) },
    project: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: '越秀' }) },
    employeeApiKey: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: '项目 Key', secretHint: 'ucli…test' }) }
  }
  const quota = {
    reserve: vi.fn().mockResolvedValue({ keys: {}, estimate: {}, thresholds: [] }),
    settle: vi.fn().mockResolvedValue({ exceeded: false }),
    release: vi.fn().mockResolvedValue({}),
    renew: vi.fn().mockResolvedValue({})
  }
  const groupBudget = {
    reserve: vi.fn(), markDispatched: vi.fn(), extend: vi.fn(), settle: vi.fn(),
    hold: vi.fn(), syncQuota: vi.fn(), release: vi.fn(), markUncertain: vi.fn()
  }
  const service = new GatewayService(prisma as any, quota as any, undefined, groupBudget as any, projectBudget as any)
  return { service, prisma, quota, groupBudget, projectBudget }
}

function makeResponse() {
  return {
    status: vi.fn(), setHeader: vi.fn(), send: vi.fn(), once: vi.fn(), removeListener: vi.fn(), writableFinished: true
  }
}

describe('project budget gateway relay', () => {
  it('charges the key-bound project and records budgetProjectId without trusting a header', async () => {
    const projectBudget = {
      reserve: vi.fn().mockResolvedValue({ id: 'p-entry', requestId: 'request', periodId: 'period', projectId: 'project-1', reservedCny: '1' }),
      extend: vi.fn().mockImplementation(async (_ref, _amount, attempt) => ({ id: 'p-entry', requestId: 'request', periodId: 'period', projectId: 'project-1', reservedCny: '1', attempt })),
      markDispatched: vi.fn().mockResolvedValue({}),
      settle: vi.fn().mockResolvedValue({ exceeded: false }),
      hold: vi.fn().mockResolvedValue({}),
      release: vi.fn().mockResolvedValue({}),
      markUncertain: vi.fn().mockResolvedValue({}),
      syncQuota: vi.fn().mockResolvedValue({})
    }
    const h = makeHarness(projectBudget)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 }))
    const response = makeResponse()
    await h.service.relay({
      protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 },
      headers: { 'x-ucli-project-id': '44444444-4444-4444-8444-444444444444' }, principal, response: response as any
    })
    expect(projectBudget.reserve.mock.calls[0][0]).toMatchObject({
      identity: expect.objectContaining({
        groupId: '22222222-2222-4222-8222-222222222222',
        projectId: '33333333-3333-4333-8333-333333333333'
      })
    })
    expect(response.status).toHaveBeenCalledWith(200)
    expect(projectBudget.settle.mock.calls[0][1].usage).toMatchObject({
      groupId: '22222222-2222-4222-8222-222222222222',
      budgetProjectId: '33333333-3333-4333-8333-333333333333', apiKeyId: 'key-1'
    })
    expect(projectBudget.settle.mock.calls[0][1].usage.actorSnapshot).toMatchObject({
      regionName: '广东-市局区域', projectName: '越秀'
    })
  })

  it('rejects before dispatch when the project budget is exhausted', async () => {
    const projectBudget = {
      reserve: vi.fn().mockRejectedValue(new HttpException({ code: 'project_budget_exceeded' }, 429))
    }
    const h = makeHarness(projectBudget)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(h.service.relay({
      protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 }, headers: {}, principal, response: makeResponse() as any
    })).rejects.toMatchObject({ response: { code: 'project_budget_exceeded' } })
    expect(fetch).not.toHaveBeenCalled()
    expect(h.prisma.usageLog.create).not.toHaveBeenCalled()
  })
})
