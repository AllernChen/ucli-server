import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { withTestDatabase, createOrganization } from './database.js'
import { AnalyticsService } from '../../apps/api/src/analytics.service.js'
import { UsageController } from '../../apps/api/src/usage.controller.js'
import { GroupBudgetService } from '../../packages/quota/src/group-budget.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('CNY cross-dimension reconciliation', () => {
  it('counts multi-billed routes once per channel, retains ungrouped history and separates unknown billing', () => withTestDatabase(async db => {
    const { actor, organization, account } = await createOrganization(db)
    const other = await createOrganization(db)
    await db.membership.create({ data: { organizationId: organization.id, accountId: other.account.id, role: 'MEMBER' } })
    const group = await db.usageGroup.create({ data: { organizationId: organization.id, name: '原组名', type: 'PROJECT', defaultLimitCny: '10' } })
    await db.groupMember.createMany({ data: [account.id, other.account.id].map(accountId => ({ organizationId: organization.id, groupId: group.id, accountId })) })
    const key = await db.employeeApiKey.create({ data: { organizationId: organization.id, accountId: account.id, groupId: group.id, createdById: account.id, name: '原 Key', secretHint: '…test', secretHash: randomUUID() } })
    const channels = await Promise.all(['A', 'B'].map(name => db.channel.create({ data: { name, provider: 'test', protocol: 'OPENAI', baseUrl: 'http://127.0.0.1' } })))
    const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Model' } })
    const at = new Date('2026-09-15T01:00:00Z'), filter = { start: '2026-09-15T00:00:00Z', end: '2026-09-16T00:00:00Z' }
    const identity = { ...actor, groupId: group.id, credentialType: 'API_KEY' as const, apiKeyId: key.id }
    const budget = new GroupBudgetService(db as PrismaService)
    const requestId = randomUUID()
    const reservation = await budget.reserve({ identity, requestId, startedAt: at, estimateCny: '4', snapshot: {} })
    const usage = { requestId, organizationId: organization.id, accountId: account.id, groupId: group.id, apiKeyId: key.id, credentialType: 'API_KEY' as const,
      actorSnapshot: { employeeName: '原员工', groupName: '原组名', keyName: '原 Key', keyHint: '…test' },
      publicModelId: model.id, upstreamModel: 'upstream', channelId: channels[1].id, protocol: 'OPENAI_CHAT' as const,
      startedAt: at, finishedAt: at, durationMs: 10, statusCode: 200, costUsd: '3.5', usageSource: 'UPSTREAM' as const, streaming: false,
      inputTokens: 10, outputTokens: 5, costSnapshot: { billingState: 'CONFIRMED' } }
    await budget.settle(reservation, { actualCny: '3.5', usage: { ...usage, routes: { create: [
      { channelId: channels[0].id, costCny: '1', attempt: 1 }, { channelId: channels[1].id, costCny: '2', attempt: 2 }, { channelId: channels[0].id, costCny: '0.5', attempt: 3 }
    ].map(r => ({ ...r, startedAt: at, durationMs: 1, billingState: 'CONFIRMED' })) } } })
    const pendingId = randomUUID()
    const pending = await budget.reserve({ identity, requestId: pendingId, startedAt: at, estimateCny: '1', snapshot: {} })
    await budget.hold(pending, { actualCny: '0', unresolvedCny: '1', reason: 'Unknown', usage: { ...usage, requestId: pendingId, costUsd: '0', costSnapshot: { billingState: 'UNKNOWN' }, routes: { create: { channelId: channels[0].id, attempt: 1, startedAt: at, durationMs: 1, billingState: 'UNKNOWN' } } } })
    const device = await db.device.create({ data: { organizationId: organization.id, accountId: account.id, name: 'Legacy', refreshTokenHash: randomUUID() } })
    await db.usageLog.create({ data: { ...usage, requestId: randomUUID(), groupId: null, apiKeyId: null, credentialType: 'DEVICE', deviceId: device.id, actorSnapshot: undefined, costUsd: '0.5' } })
    await db.account.update({ where: { id: account.id }, data: { displayName: '新员工' } })
    await db.usageGroup.update({ where: { id: group.id }, data: { name: '新组名' } })
    await db.employeeApiKey.update({ where: { id: key.id }, data: { name: '新 Key' } })
    const service = new AnalyticsService(db as PrismaService)
    const overview = await service.overview(actor, filter)
    expect(overview).toMatchObject({ costCny: '4.00000000', costUsd: '4.00000000', currency: 'CNY', requests: 3, unsettledRequests: 1, successRate: 2 / 3 })
    for (const dimension of ['group', 'apiKey', 'account', 'model', 'channel'] as const) {
      const { items } = await service.breakdown(actor, { ...filter, dimension })
      expect(items.reduce((sum, item) => sum + Number(item.costCny), 0)).toBe(4)
    }
    const channelCosts = await service.breakdown(actor, { ...filter, dimension: 'channel' })
    expect(channelCosts.items.find(i => i.id === channels[0].id)).toMatchObject({ costCny: '1.50000000', requests: 2 })
    expect(channelCosts.items.find(i => i.id === channels[1].id)).toMatchObject({ costCny: '2.50000000', requests: 2 })
    expect(await service.overview(actor, { ...filter, channelId: channels[0].id })).toMatchObject({ costCny: '1.50000000', requests: 2 })
    expect(await service.overview({ ...actor, role: 'MEMBER' }, { ...filter, accountId: other.account.id, groupId: group.id })).toMatchObject({ costCny: '3.50000000', requests: 2 })
    expect(await service.overview(other.actor, { ...filter, groupId: group.id })).toMatchObject({ costCny: '0.00000000', requests: 0 })
    expect(await budget.summary(actor, group.id)).toMatchObject({ spentCny: '3.50000000', uncertainCny: '1.00000000' })
    const logs = await new UsageController(db as PrismaService).logs({ principal: actor }, { ...filter, groupId: group.id, apiKeyId: key.id })
    expect(logs).toHaveLength(2)
    expect(logs.find(l => l.requestId === requestId)).toMatchObject({ employeeName: '原员工', groupName: '原组名', keyName: '原 Key', costCny: '3.50000000', currency: 'CNY' })
    const options = await service.filterOptions(actor, filter)
    expect(options.groups.map(g => g.id)).toEqual([group.id])
    expect(options.apiKeys.map(k => k.id)).toEqual([key.id])
  }))
})
