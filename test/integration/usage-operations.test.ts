import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AnalyticsService } from '../../apps/api/src/analytics.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('routed operational usage analytics', () => {
  it('keeps route usage and costs together, exposes the reconciliation delta, and drills unassociated channel models safely', () => withTestDatabase(async db => {
    const { actor, organization, account } = await createOrganization(db)
    const channels = await Promise.all(['A', 'B'].map(name => db.channel.create({ data: { name, provider: 'test', protocol: 'OPENAI', baseUrl: 'http://127.0.0.1' } })))
    const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Model' } })
    const device = await db.device.create({ data: { organizationId: organization.id, accountId: account.id, name: 'Test device', refreshTokenHash: randomUUID() } })
    const at = new Date('2026-09-15T01:00:00Z')
    await db.usageLog.create({ data: {
      requestId: randomUUID(), organizationId: organization.id, accountId: account.id, credentialType: 'DEVICE', deviceId: device.id, publicModelId: model.id,
      upstreamModel: 'upstream', channelId: channels[1].id, protocol: 'OPENAI_CHAT', startedAt: at, finishedAt: at, durationMs: 10,
      statusCode: 200, costUsd: '4', usageSource: 'ESTIMATED', streaming: false, inputTokens: 350, cachedTokens: 150, outputTokens: 35,
      costSnapshot: { billingState: 'ESTIMATED' }, routes: { create: [
        { channelId: channels[0].id, attempt: 1, startedAt: at, durationMs: 1, costCny: '1', billingState: 'CONFIRMED', usageSnapshot: { source: 'upstream', inputTokens: 100, cachedTokens: 40, outputTokens: 10 } },
        { channelId: channels[0].id, attempt: 2, startedAt: at, durationMs: 1, costCny: '0.5', billingState: 'CONFIRMED', usageSnapshot: { source: 'upstream', inputTokens: 50, cachedTokens: 10, outputTokens: 5 } },
        { channelId: channels[1].id, attempt: 3, startedAt: at, durationMs: 1, costCny: '2', billingState: 'ESTIMATED', usageSnapshot: { source: 'estimated', inputTokens: 200, cachedTokens: 100, outputTokens: 20 } }
      ] }
    } })
    const service = new AnalyticsService(db as PrismaService)
    const filter = { start: '2026-09-15T00:00:00Z', end: '2026-09-16T00:00:00Z' }
    await expect(service.overview(actor, filter)).resolves.toMatchObject({
      requests: 1, costCny: '4.00000000', requestSuccessRate: 1,
      requestStates: { SUCCESS: 1, FAILED: 0, CANCELLED: 0, INTERRUPTED: 0 },
      cachedTokens: '150', unallocatedCostCny: '0.50000000', estimatedCostCny: '2.00000000',
      cacheCoverage: { knownInputTokens: '150', totalInputTokens: '350', unknownCalls: 1 }
    })
    await expect(service.overview(actor, { ...filter, billingState: 'ESTIMATED' })).resolves.toMatchObject({ requests: 1, costCny: '4.00000000' })
    await expect(service.overview(actor, { ...filter, channelId: channels[1].id, billingState: 'ESTIMATED' })).resolves.toMatchObject({ requests: 1, costCny: '2.00000000' })
    const channelsBreakdown = await service.breakdown(actor, { ...filter, dimension: 'channel' })
    expect(channelsBreakdown).toMatchObject({ total: 3 })
    expect(channelsBreakdown.items.find(item => item.id === channels[0].id)).toMatchObject({
      requests: 1, inputTokens: '150', cachedTokens: '50', costCny: '1.50000000', matchedCostCny: '1.50000000', allocationKind: 'ROUTE'
    })
    expect(channelsBreakdown.items.find(item => item.id === channels[1].id)).toMatchObject({
      requests: 1, inputTokens: '200', cachedTokens: '100', costCny: '2.00000000', matchedCostCny: '2.00000000', allocationKind: 'ROUTE'
    })
    expect(channelsBreakdown.items.find(item => item.allocationKind === 'UNALLOCATED')).toMatchObject({ costCny: '0.50000000', drillQuery: { allocation: 'UNALLOCATED' } })
    const unassociated = await service.breakdown(actor, { ...filter, dimension: 'channelModel', channelModelScope: 'UNASSOCIATED' })
    expect(unassociated.items).toHaveLength(1)
    expect(unassociated.items[0]).toMatchObject({ allocationKind: 'MIXED', costCny: '4.00000000', drillQuery: { channelModelScope: 'UNASSOCIATED' } })
  }))
})
