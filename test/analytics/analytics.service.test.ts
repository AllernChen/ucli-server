import 'reflect-metadata'
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { AnalyticsService } from '../../apps/api/src/analytics.service.js'

const now = new Date('2026-08-20T12:00:00Z')
const platform = { sub: 'platform-1', organizationId: 'org-home', role: 'PLATFORM_ADMIN' as const }
const orgAdmin = { sub: 'admin-1', organizationId: 'org-1', role: 'ORG_ADMIN' as const }
const member = { sub: 'member-1', organizationId: 'org-1', role: 'MEMBER' as const }

function makeService(rows: any[] = []) {
  const prisma: any = { $queryRaw: vi.fn(async () => rows) }
  return { service: new AnalyticsService(prisma), prisma }
}

describe('analytics service', () => {
  it('scopes platform, organization admin and member filters without trusting broader query scope', () => {
    const { service } = makeService()
    expect(service.resolveFilter(platform, { organizationId: 'org-2', accountId: 'account-2' }, now))
      .toMatchObject({ organizationId: 'org-2', accountId: 'account-2' })
    expect(service.resolveFilter(orgAdmin, { organizationId: 'org-2', accountId: 'account-2' }, now))
      .toMatchObject({ organizationId: 'org-1', accountId: 'account-2' })
    expect(service.resolveFilter(member, { organizationId: 'org-2', accountId: 'account-2' }, now))
      .toMatchObject({ organizationId: 'org-1', accountId: 'member-1' })
  })

  it('rejects invalid or overlong time ranges and hourly ranges over 31 days', async () => {
    const { service } = makeService()
    expect(() => service.resolveFilter(platform, { start: '2026-01-01', end: '2026-08-20' }, now)).toThrow(BadRequestException)
    expect(() => service.resolveFilter(platform, { start: 'bad-date' }, now)).toThrow(BadRequestException)
    await expect(service.timeseries(platform, { start: '2026-07-01', end: '2026-08-20', interval: 'hour' }))
      .rejects.toBeInstanceOf(BadRequestException)
  })

  it('normalizes database aggregate types into the overview contract', async () => {
    const { service } = makeService([{
      requests: 4n, successes: 3n, active_accounts: 2n, input_tokens: 100n, output_tokens: 40n,
      cost_usd: '1.25', p50_latency_ms: 120.4, p95_latency_ms: 450.8, p50_first_token_ms: 80,
      p95_first_token_ms: 200, failovers: 1n
    }])
    await expect(service.overview(platform, { start: '2026-08-19', end: '2026-08-20' })).resolves.toEqual({
      requests: 4, successRate: 0.75, activeAccounts: 2, inputTokens: '100', outputTokens: '40',
      costUsd: '1.25000000', avgCostPerRequestUsd: '0.31250000', p50LatencyMs: 120,
      p95LatencyMs: 451, p50FirstTokenMs: 80, p95FirstTokenMs: 200, failoverRate: 0.25
    })
  })

  it('uses fixed breakdown allowlists and restricts organization visibility', async () => {
    const { service } = makeService([])
    await expect(service.breakdown(orgAdmin, { dimension: 'organization' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.breakdown(platform, { dimension: 'channel;drop table usage_logs' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.breakdown(platform, { dimension: 'channel', sort: 'costUsd;drop', order: 'desc' }))
      .rejects.toBeInstanceOf(BadRequestException)
  })

  it('parameterizes user filter values in overview SQL', async () => {
    const { service, prisma } = makeService([])
    await service.overview(platform, { organizationId: "org' OR 1=1 --", channelId: 'channel-user-value' })
    const query = prisma.$queryRaw.mock.calls[0][0]
    expect(query.strings.join('')).not.toContain("org' OR 1=1 --")
    expect(query.strings.join('')).not.toContain('channel-user-value')
    expect(query.values).toContain("org' OR 1=1 --")
    expect(query.values).toContain('channel-user-value')
  })
})
