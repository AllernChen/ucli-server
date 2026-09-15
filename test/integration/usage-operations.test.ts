import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import Decimal from 'decimal.js'
import { AnalyticsService } from '../../apps/api/src/analytics.service.js'
import { AnalyticsController } from '../../apps/api/src/analytics.controller.js'
import { UsageController } from '../../apps/api/src/usage.controller.js'
import { GroupBudgetService } from '../../packages/quota/src/group-budget.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'

const range = { start: '2026-09-15T00:00:00Z', end: '2026-09-17T00:00:00Z' }
async function fixture(db: PrismaClient) {
  const owner = await createOrganization(db)
  const channel = await db.channel.create({ data: { name: 'Alpha', provider: 'test', protocol: 'OPENAI', baseUrl: 'http://127.0.0.1' } })
  const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Model' } })
  const device = await db.device.create({ data: { organizationId: owner.organization.id, accountId: owner.account.id, name: 'Device', refreshTokenHash: randomUUID() } })
  const at = new Date('2026-09-15T01:00:00Z')
  const log = (data: Partial<Prisma.UsageLogUncheckedCreateInput> = {}) => db.usageLog.create({ data: {
    requestId: randomUUID(), organizationId: owner.organization.id, accountId: owner.account.id, deviceId: device.id,
    credentialType: 'DEVICE', publicModelId: model.id, upstreamModel: 'upstream', channelId: channel.id,
    protocol: 'OPENAI_CHAT', startedAt: at, finishedAt: at, durationMs: 10, statusCode: 200, costUsd: '1',
    usageSource: 'UPSTREAM', streaming: false, inputTokens: 100, outputTokens: 10, cachedTokens: 20, reasoningTokens: 7, ...data
  } })
  const route = (usageLogId: string, attempt: number, data: Partial<Prisma.RouteAttemptUncheckedCreateInput> = {}) => db.routeAttempt.create({ data: {
    usageLogId, channelId: channel.id, attempt, startedAt: at, durationMs: 1, costCny: '1', billingState: 'CONFIRMED',
    usageSnapshot: { source: 'upstream', inputTokens: 10, outputTokens: 1, cachedTokens: 2, reasoningTokens: 0 }, ...data
  } })
  return { ...owner, channel, model, device, log, route, service: new AnalyticsService(db as PrismaService) }
}

const historicalPrice = (extra = {}) => ({ id: randomUUID(), source: 'CHANNEL_COST_RULE', inputPerMillion: '1', cachedPerMillion: '0.5',
  outputPerMillion: '2', reasoningPerMillion: '0', timezone: 'Asia/Shanghai', daysOfWeek: [1, 2], startMinute: 0, endMinute: 1440,
  validFrom: '2026-01-01T00:00:00Z', internalSecret: { credential: 'must-not-leak' }, ...extra })

describe.skipIf(!process.env.TEST_DATABASE_URL)('routed operational usage analytics', () => {
  it('shows safe request-only legacy prices consistently with analytics despite changed current prices and enforces detail scope', () => withTestDatabase(async db => {
    const f = await fixture(db), usage = new UsageController(db as PrismaService), request = { principal: f.actor }
    const model = await db.channelModel.create({ data: { channelId: f.channel.id, publicModelId: f.model.id, upstreamModel: 'legacy', protocol: 'OPENAI_CHAT' } })
    const price = historicalPrice({ ruleName: '请求历史价格', channelModelId: model.id })
    await db.channelModelCostRule.create({ data: { id: price.id, channelModelId: model.id, name: 'Current price', daysOfWeek: [1], startMinute: 0, endMinute: 1439,
      inputPerMillion: '999', outputPerMillion: '999', validFrom: new Date('2026-09-01T00:00:00Z') } })
    const log = await f.log({ channelModelId: model.id, channelCostRuleId: price.id, costSnapshot: price, costUsd: '1.5' })
    // Legacy attempts can exist without billed route evidence; they must not gain invented route prices.
    await f.route(log.id, 1, { billingState: null, costCny: null, usageSnapshot: {} })
    const detail = await usage.detail(request, log.id, range)
    expect(detail).toMatchObject({ requestPrice: { inputPerMillion: '1', cachedPerMillion: '0.5', outputPerMillion: '2', reasoningPerMillion: '0', ruleName: '请求历史价格' }, costCny: '1.50000000', routes: [{ price: null }] })
    expect(JSON.stringify(detail)).not.toMatch(/Current price|must-not-leak|internalSecret|costSnapshot|usageSnapshot/)
    expect((await f.service.breakdown(f.actor, { ...range, dimension: 'channel' })).items[0]).toMatchObject({ price: { inputPerMillion: '1' }, costCny: detail.costCny })
    const outsider = await fixture(db)
    await expect(usage.detail({ principal: outsider.actor }, log.id, { ...range, organizationId: f.organization.id })).rejects.toMatchObject({ status: 404 })
    await expect(usage.detail({ principal: { ...f.actor, sub: outsider.account.id, role: 'MEMBER' } }, log.id, { ...range, accountId: f.account.id })).rejects.toMatchObject({ status: 404 })
    const missing = await f.log()
    expect(await usage.detail(request, missing.id, range)).toHaveProperty('requestPrice', null)
  }))

  it('joins many price groups without quadratic pair checks while preserving the null allocation group', () => withTestDatabase(async db => {
    const f = await fixture(db)
    const channels = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(), name: `Plan ${index}`, provider: 'test', protocol: 'OPENAI' as const, baseUrl: 'http://127.0.0.1' }))
    await db.channel.createMany({ data: channels })
    const log = await f.log({ costUsd: '100.5' })
    await db.routeAttempt.createMany({ data: channels.map((channel, index) => ({ usageLogId: log.id, channelId: channel.id, attempt: index + 1,
      startedAt: log.startedAt, durationMs: 1, costCny: '1', billingState: 'CONFIRMED' as const, usageSnapshot: { source: 'upstream', inputTokens: 1, cachedTokens: 1 } })) })
    let selected: Prisma.Sql | undefined
    const service = new AnalyticsService({ $queryRaw: (sql: Prisma.Sql) => { if (/LIMIT/.test(sql.sql)) selected = sql; return db.$queryRaw(sql) } } as PrismaService)
    const result = await service.breakdown(f.actor, { ...range, dimension: 'channel', limit: 200 })
    expect(result.total).toBe(101)
    expect(result.items.filter(row => row.id === null)).toMatchObject([{ matchedCostCny: '0.50000000', drillQuery: { allocation: 'UNALLOCATED' } }])
    expect(result.items.reduce((sum, row) => sum.plus(row.matchedCostCny), new Decimal(0)).toFixed(8)).toBe('100.50000000')
    const plan = await db.$transaction(async tx => {
      // Small fixtures may favor nested loops; check that a linear join is possible independent of planner estimates.
      await tx.$executeRaw`SET LOCAL enable_nestloop = off`
      return tx.$queryRaw<any[]>(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${selected!}`)
    })
    const pairChecks = (node: any): number => Math.max(Number(node['Rows Removed by Join Filter'] || 0) * Number(node['Actual Loops'] || 1), ...(node.Plans || []).map(pairChecks), 0)
    // 101 groups must not compare all 101 x 101 price pairs. No timing threshold depends on machine speed.
    expect(pairChecks(plan[0]['QUERY PLAN'][0].Plan)).toBeLessThan(1000)
  }))

  it('uses the same route-call denominator for cache coverage through every aggregate while retaining request tokens', () => withTestDatabase(async db => {
    const f = await fixture(db)
    const log = await f.log({ inputTokens: 50, cachedTokens: 10, costUsd: '3.5' })
    await f.route(log.id, 1, { usageSnapshot: { source: 'upstream', inputTokens: 100, cachedTokens: 20, outputTokens: 10, reasoningTokens: 0 } })
    await f.route(log.id, 2, { usageSnapshot: { source: 'upstream', inputTokens: 200, cachedTokens: 40, outputTokens: 10, reasoningTokens: 0 } })
    await f.route(log.id, 3, { usageSnapshot: { source: 'estimated', inputTokens: 50, cachedTokens: 10, outputTokens: 10, reasoningTokens: 0 } })
    const coverage = { knownInputTokens: '300', totalInputTokens: '350', unknownCalls: 1 }
    expect(await f.service.overview(f.actor, range)).toMatchObject({ inputTokens: '50', cachedTokens: '10', costCny: '3.50000000', cacheHitRate: .2, cacheCoverage: coverage })
    expect(await f.service.timeseries(f.actor, range)).toMatchObject([{ inputTokens: '50', cacheCoverage: coverage }])
    for (const dimension of ['account', 'channel'] as const) {
      const filter = { ...range, dimension, ...(dimension === 'channel' ? { channelId: f.channel.id } : {}) }
      expect((await f.service.breakdown(f.actor, filter)).items[0]).toMatchObject({ cacheCoverage: coverage })
      expect((await f.service.exportRows(f.actor, filter))[0]).toMatchObject({ cacheCoverage: coverage })
    }
    expect(await f.service.overview(f.actor, { ...range, allocation: 'UNALLOCATED' })).toMatchObject({ cacheCoverage: { knownInputTokens: '0', totalInputTokens: '0', unknownCalls: 0 } })
  }))

  it('reconciles Decimal matched costs across log pages, both CSVs and overview with pending accounting', () => withTestDatabase(async db => {
    const f = await fixture(db), usage = new UsageController(db as PrismaService), request = { principal: f.actor }
    for (const [index, cost] of ['0.10000001', '0.20000002', '0.30000003'].entries()) {
      const log = await f.log({ costUsd: new Decimal(cost).plus('.5').toFixed(8), costSnapshot: { billingState: index === 0 ? 'UNKNOWN' : 'CONFIRMED' } })
      await f.route(log.id, 1, { costCny: cost })
    }
    const filter = { ...range, channelId: f.channel.id }
    const overview = await f.service.overview(f.actor, filter)
    const pages = await Promise.all([0, 2].map(offset => usage.logsPage(request, { ...filter, limit: 2, offset })))
    const rows = pages.flatMap(page => page.items)
    expect(pages.map(page => page.items.length)).toEqual([2, 1])
    expect(new Set(rows.map(row => row.id)).size).toBe(3)
    expect(rows.some(row => row.billingState === 'UNKNOWN')).toBe(true)
    expect(rows.reduce((sum, row) => sum.plus(row.matchedCostCny), new Decimal(0)).toFixed(8)).toBe('0.60000006')
    expect(rows.reduce((sum, row) => sum.plus(row.costCny), new Decimal(0)).toFixed(8)).toBe('2.10000006')
    expect(overview).toMatchObject({ costCny: '0.60000006', requestSuccessRate: 1 })
    const csvRows = (csv: string) => csv.replace(/^\uFEFF/, '').trim().split('\r\n').map(line => line.slice(1, -1).split('","'))
    for (const csv of [await usage.exportCsv(request, { ...filter, limit: 2, offset: 2 }), await new AnalyticsController(f.service).exportCsv(request, { ...filter, dimension: 'channel', limit: 2, offset: 2 })]) {
      const [header, ...records] = csvRows(csv)
      expect(records.reduce((sum, row) => sum.plus(row[header.indexOf('matchedCostCny')]), new Decimal(0)).toFixed(8)).toBe(overview.costCny)
    }
  }))
  it('sorts independent request success oppositely to legacy billing-dependent success without changing the old contract', () => withTestDatabase(async db => {
    const f = await fixture(db)
    const second = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Partly failed' } })
    await f.log({ costSnapshot: { billingState: 'UNKNOWN' }, errorCode: 'RECONCILIATION_REQUIRED' })
    await f.log({ publicModelId: second.id })
    await f.log({ publicModelId: second.id, statusCode: 500, errorCode: 'UPSTREAM_ERROR' })
    const operational = await f.service.breakdown(f.actor, { ...range, dimension: 'model', sort: 'requestSuccessRate', order: 'desc' })
    const legacy = await f.service.breakdown(f.actor, { ...range, dimension: 'model', sort: 'successRate', order: 'desc' })
    expect(operational.items.map(row => row.id)).toEqual([f.model.id, second.id])
    expect(legacy.items.map(row => row.id)).toEqual([second.id, f.model.id])
    expect(operational.items).toMatchObject([{ requestSuccessRate: 1, successRate: 0 }, { requestSuccessRate: .5, successRate: .5 }])
    const page = await f.service.breakdown(f.actor, { ...range, dimension: 'model', sort: 'requestSuccessRate', order: 'desc', limit: 1, offset: 1 })
    expect(page).toMatchObject({ total: 2, items: [{ id: second.id }] })
    const exported = await f.service.exportRows(f.actor, { ...range, dimension: 'model', sort: 'requestSuccessRate', order: 'desc', limit: 1, offset: 1 })
    expect(exported.map(row => row.id)).toEqual([f.model.id, second.id])
  }))
  it('keeps paging, details and both exports on the same matched request costs and safe historical names', () => withTestDatabase(async db => {
    const f = await fixture(db), usage = new UsageController(db as PrismaService), request = { principal: f.actor }
    const log = await f.log({ costUsd: '1.5', actorSnapshot: { employeeName: '=中文', internalSecret: 'DO_NOT_EXPOSE' }, costSnapshot: { billingState: 'UNKNOWN', internalSecret: 'DO_NOT_EXPOSE' }, errorCode: 'RECONCILIATION_REQUIRED' })
    await f.route(log.id, 1, { usageSnapshot: { source: 'upstream', inputTokens: 100, outputTokens: 10, cachedTokens: 20, reasoningTokens: 0, cost: historicalPrice() } })
    const breakdown = await f.service.breakdown(f.actor, { ...range, dimension: 'costRule', channelId: f.channel.id })
    const query = { ...range, ...breakdown.items[0].drillQuery, groupScope: 'UNGROUPED' as const, keyScope: 'NO_KEY' as const, billingState: 'CONFIRMED' as const }
    const page = await usage.logsPage(request, { ...query, limit: 1 })
    expect(page).toMatchObject({ total: 1, limit: 1, offset: 0, items: [{ id: log.id, requestState: 'SUCCESS', costCny: '1.50000000', matchedCostCny: '1.00000000', groupName: '历史未归组', keyName: '设备凭据' }] })
    expect(await usage.logsPage(request, { ...query, offset: 10 })).toMatchObject({ items: [], total: 1 })
    const detail = await usage.detail(request, log.id, query)
    expect(detail).toMatchObject({ matchedCostCny: '1.00000000', unallocatedCostCny: '0.50000000', budget: null, budgetAvailability: 'NOT_APPLICABLE' })
    expect(JSON.stringify(detail)).not.toMatch(/DO_NOT_EXPOSE|must-not-leak|refreshToken|secretHash/)
    expect(await usage.detail(request, log.id, { ...range, channelId: randomUUID() })).toMatchObject({ id: log.id, matchedCostCny: '0.00000000' })
    expect(await usage.logsPage(request, { ...range, channelModelScope: 'UNASSOCIATED', billingState: 'UNKNOWN' })).toMatchObject({ total: 1, items: [{ matchedCostCny: '0.50000000' }] })
    expect(await usage.logsPage(request, { ...range, billingState: 'UNKNOWN' })).toMatchObject({ total: 1, items: [{ matchedCostCny: '1.50000000' }] })
    expect(await usage.exportCsv(request, { ...query, offset: 50, limit: 1 })).toContain('"\'=中文"')
    expect(await usage.exportCsv(request, query)).toContain('"1.00000000"')
    const rows = await f.service.exportRows(f.actor, { ...query, dimension: 'channel', offset: 50, limit: 1 })
    expect(rows).toMatchObject([{ matchedCostCny: '1.00000000', requestCostCny: '1.50000000' }])
    const csv = await new AnalyticsController(f.service).exportCsv(request, { ...query, dimension: 'channel' })
    expect(csv).toContain('matchedCostCny'); expect(csv).not.toContain('must-not-leak')
    expect(await usage.summary(request, query)).toMatchObject({ requests: 1, costCny: '1.00000000', matchedCostCny: '1.00000000', requestSuccessRate: 1 })
    const outsider = await fixture(db)
    await expect(usage.detail({ principal: outsider.actor }, log.id, { ...range, organizationId: f.organization.id, accountId: f.account.id })).rejects.toMatchObject({ status: 404 })
    await expect(usage.detail(request, 'not-a-uuid', {})).rejects.toMatchObject({ status: 404 })
  }))

  it('supports historical logs options without relaxing analytics limits or member scope and authorizes old detail IDs independently', () => withTestDatabase(async db => {
    const f = await fixture(db), usage = new UsageController(db as PrismaService), request = { principal: f.actor }
    const old = await f.log({ startedAt: new Date('2025-01-01T00:00:00Z'), actorSnapshot: { employeeName: 'Historical' } })
    const other = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Other' } })
    const otherLog = await f.log({ accountId: other.id, startedAt: old.startedAt })
    const historical = { start: '2025-01-01T00:00:00Z', end: '2026-09-17T00:00:00Z', optionDimension: 'account' as const }
    expect((await usage.logs(request, {})).some(row => row.id === old.id)).toBe(true)
    expect(await usage.logsPage(request, {})).toMatchObject({ total: 0 })
    expect(await usage.summary(request, {})).toMatchObject({ requests: 2 })
    expect(await usage.detail(request, old.id, {})).toMatchObject({ id: old.id, matchedCostCny: '1.00000000' })
    expect(await usage.options(request, { ...historical, requestId: old.requestId })).toMatchObject({ page: { total: 1, items: [{ id: f.account.id, name: 'Historical' }] } })
    expect(await usage.options(request, { ...historical, interval: 'hour', requestId: old.requestId })).toMatchObject({ page: { total: 1 } })
    await expect(f.service.filterOptions(f.actor, { start: '2026-01-01', end: '2026-02-15', interval: 'hour', optionDimension: 'account' })).rejects.toMatchObject({ status: 400 })
    for (const extra of [{ sessionId: randomUUID() }, { projectId: randomUUID() }, { requestId: randomUUID() }]) {
      expect(await usage.options(request, { ...historical, ...extra })).toMatchObject({ page: { total: 0, items: [] } })
    }
    await expect(f.service.filterOptions(f.actor, historical)).rejects.toMatchObject({ status: 400 })
    expect(await usage.options({ principal: { ...f.actor, role: 'MEMBER' } }, { ...historical, accountId: other.id, organizationId: randomUUID() })).toMatchObject({ page: { total: 1, items: [{ id: f.account.id }] } })
    await expect(usage.detail({ principal: { ...f.actor, role: 'MEMBER' } }, otherLog.id, { accountId: other.id })).rejects.toMatchObject({ status: 404 })
  }))

  it('joins budget only by the authorized log identity and preserves cumulative reservation through hold then settle', () => withTestDatabase(async db => {
    const f = await fixture(db), usage = new UsageController(db as PrismaService), request = { principal: f.actor }
    const group = await db.usageGroup.create({ data: { organizationId: f.organization.id, name: 'Group', type: 'PROJECT', defaultLimitCny: '10' } })
    await db.groupMember.create({ data: { organizationId: f.organization.id, groupId: group.id, accountId: f.account.id } })
    const key = await db.employeeApiKey.create({ data: { organizationId: f.organization.id, groupId: group.id, accountId: f.account.id, createdById: f.account.id, name: 'Current key', secretHint: 'secret hint', secretHash: randomUUID() } })
    const budget = new GroupBudgetService(db as PrismaService), at = new Date('2026-09-15T01:00:00Z')
    const reservation = await budget.reserve({ identity: { ...f.actor, groupId: group.id, credentialType: 'API_KEY', apiKeyId: key.id }, requestId: randomUUID(), startedAt: at, estimateCny: '3', snapshot: { internalSecret: 'DO_NOT_EXPOSE' } })
    await budget.extend(reservation, '1', { attemptId: '2' })
    const logData = { requestId: reservation.requestId, organizationId: f.organization.id, accountId: f.account.id, groupId: group.id, credentialType: 'API_KEY' as const, apiKeyId: key.id,
      channelId: f.channel.id, publicModelId: f.model.id, upstreamModel: 'upstream', protocol: 'OPENAI_CHAT' as const, startedAt: at, finishedAt: at,
      durationMs: 10, statusCode: 200, errorCode: 'RECONCILIATION_REQUIRED', costUsd: '1', costSnapshot: { billingState: 'UNKNOWN' }, usageSource: 'UPSTREAM' as const, streaming: false }
    await budget.hold(reservation, { actualCny: '1', unresolvedCny: '0.5', usage: logData, reason: 'pending' })
    const log = await db.usageLog.findUniqueOrThrow({ where: { requestId: reservation.requestId } })
    expect(await usage.detail(request, log.id, {})).toMatchObject({ employeeName: f.account.id, keyName: key.id, keyHint: null, groupName: group.id,
      budgetAvailability: 'AVAILABLE', budget: { cumulativeReservedCny: '4.00000000', currentHeldCny: '0.50000000', settledCny: '1.00000000' } })
    await budget.settle(reservation, { actualCny: '1.25', usage: { ...logData, costUsd: '1.25', errorCode: null, costSnapshot: { billingState: 'CONFIRMED' } } })
    const result = await usage.detail(request, log.id, {})
    expect(result.budget).toMatchObject({ status: 'SETTLED', cumulativeReservedCny: '4.00000000', currentHeldCny: '0.00000000', settledCny: '1.25000000' })
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EXPOSE|secret hint|Current key/)
    const other = await createOrganization(db)
    await db.membership.create({ data: { organizationId: f.organization.id, accountId: other.account.id, role: 'MEMBER' } })
    const anotherGroup = await db.usageGroup.create({ data: { organizationId: f.organization.id, name: 'Other group', type: 'PROJECT' } })
    const anotherPeriod = await db.groupBudgetPeriod.create({ data: { organizationId: f.organization.id, groupId: anotherGroup.id, periodKey: 'TOTAL', timezone: 'Asia/Shanghai', limitCny: '10' } })
    const outsideGroup = await db.usageGroup.create({ data: { organizationId: other.organization.id, name: 'Outside', type: 'PROJECT' } })
    const outsidePeriod = await db.groupBudgetPeriod.create({ data: { organizationId: other.organization.id, groupId: outsideGroup.id, periodKey: 'TOTAL', timezone: 'Asia/Shanghai', limitCny: '10' } })
    const original = { organizationId: f.organization.id, groupId: group.id, periodId: reservation.periodId, requestId: reservation.requestId,
      kind: 'REQUEST' as const, actorAccountId: null, accountId: f.account.id, credentialType: 'API_KEY' as const, credentialId: key.id }
    for (const mismatch of [{ kind: 'COST_ADJUSTMENT' as const, requestId: null, actorAccountId: f.account.id }, { accountId: other.account.id },
      { credentialType: 'DEVICE' as const }, { credentialId: randomUUID() }, { groupId: anotherGroup.id, periodId: anotherPeriod.id },
      { organizationId: other.organization.id, groupId: outsideGroup.id, periodId: outsidePeriod.id, accountId: other.account.id }]) {
      await db.groupBudgetEntry.update({ where: { id: reservation.id }, data: { ...original, ...mismatch } })
      expect(await usage.detail(request, log.id, { accountId: other.account.id, organizationId: other.organization.id, apiKeyId: randomUUID() })).toMatchObject({ budget: null, budgetAvailability: 'NOT_FOUND' })
    }
    await db.groupBudgetEntry.update({ where: { id: reservation.id }, data: original })
    expect(await usage.detail(request, log.id, { accountId: other.account.id, organizationId: other.organization.id })).toMatchObject({ budgetAvailability: 'AVAILABLE', budget: { settledCny: '1.25000000' } })
    const deviceLog = await f.log({ groupId: group.id })
    expect(await usage.detail(request, deviceLog.id, {})).toMatchObject({ budget: null, budgetAvailability: 'NOT_FOUND' })
    const deviceReservation = await budget.reserve({ identity: { ...f.actor, groupId: group.id, credentialType: 'DEVICE', deviceId: f.device.id }, requestId: randomUUID(), startedAt: at, estimateCny: '0.2', snapshot: {} })
    await budget.settle(deviceReservation, { actualCny: '0.1', usage: { ...logData, requestId: deviceReservation.requestId, credentialType: 'DEVICE', deviceId: f.device.id, apiKeyId: null, costUsd: '0.1' } })
    const settledDevice = await db.usageLog.findUniqueOrThrow({ where: { requestId: deviceReservation.requestId } })
    expect(await usage.detail(request, settledDevice.id, {})).toMatchObject({ budgetAvailability: 'AVAILABLE', budget: { settledCny: '0.10000000' } })
  }))
  it('deduplicates request latency and sorts the log-authoritative token and latency totals', () => withTestDatabase(async db => {
    const f = await fixture(db)
    const first = await f.log({ inputTokens: 1000, reasoningTokens: 70, costUsd: '2' })
    await f.route(first.id, 1)
    await f.route(first.id, 2)
    const second = await f.log({ durationMs: 100 })
    await f.route(second.id, 1)
    for (const extra of [{ dimension: 'channel' as const }, { dimension: 'account' as const, channelId: f.channel.id }]) {
      const result = await f.service.breakdown(f.actor, { ...range, ...extra })
      expect(result.items[0]).toMatchObject({ requests: 2, p95LatencyMs: 96 })
    }
    const other = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Other' } })
    const third = await f.log({ accountId: other.id, inputTokens: 500, durationMs: 94, costUsd: '1' })
    await f.route(third.id, 1, { usageSnapshot: { source: 'upstream', inputTokens: 5000, outputTokens: 1, cachedTokens: 1, reasoningTokens: 0 } })
    const tokens = await f.service.breakdown(f.actor, { ...range, dimension: 'account', sort: 'tokens' })
    expect(tokens.items.map(item => item.id)).toEqual([f.account.id, other.id])
    expect(tokens.items[0]).toMatchObject({ inputTokens: '1100', totalTokens: '1120', reasoningTokens: '77', p95LatencyMs: 96 })
    const latency = await f.service.breakdown(f.actor, { ...range, dimension: 'account', sort: 'p95LatencyMs' })
    expect(latency.items.map(item => item.id)).toEqual([f.account.id, other.id])
  }))

  it('preserves known tokens and unknown cache evidence, and exposes real errors and deltas', () => withTestDatabase(async db => {
    const f = await fixture(db)
    const log = await f.log({ costUsd: '1.5', errorCode: 'UPSTREAM_ERROR', statusCode: 500 })
    await f.route(log.id, 1, { usageSnapshot: { inputTokens: 100, cachedTokens: 20 } })
    const overview = await f.service.overview(f.actor, { ...range, channelId: f.channel.id })
    expect(overview).toMatchObject({ inputTokens: '100', outputTokens: '0', tokenUsageIncomplete: true, cacheCoverage: { unknownCalls: 1 }, unallocatedCostCny: '0.00000000' })
    const channel = await f.service.breakdown(f.actor, { ...range, dimension: 'channel', channelId: f.channel.id })
    expect(channel.items[0]).toMatchObject({ totalTokens: '100', inputTokens: '100', tokenUsageIncomplete: true, cacheCoverage: { unknownCalls: 1 }, errorCounts: [{ errorCode: 'UPSTREAM_ERROR', requests: 1 }], avgInputPerMillion: null, avgOutputPerMillion: null, schedule: null })
    const series = await f.service.timeseries(f.actor, range)
    expect(series[0]).toMatchObject({ unallocatedCostCny: '0.50000000', errorCounts: [{ errorCode: 'UPSTREAM_ERROR', requests: 1 }] })
    const account = await f.service.breakdown(f.actor, { ...range, dimension: 'account' })
    expect(account.items[0]).toMatchObject({ unallocatedCostCny: '0.50000000', errorCounts: [{ errorCode: 'UPSTREAM_ERROR', requests: 1 }] })
  }))

  it('requires one complete historical price and reads the nested historical model on the matching route', () => withTestDatabase(async db => {
    const f = await fixture(db)
    const early = await db.channelModel.create({ data: { channelId: f.channel.id, publicModelId: f.model.id, upstreamModel: 'early', protocol: 'OPENAI_CHAT' } })
    const later = await db.channelModel.create({ data: { channelId: f.channel.id, publicModelId: f.model.id, upstreamModel: 'later', protocol: 'ANTHROPIC_MESSAGES' } })
    const price = historicalPrice({ channelModelId: early.id })
    const finalPrice = historicalPrice({ channelModelId: later.id, inputPerMillion: '9' })
    for (const [id, channelModelId] of [[price.id, early.id], [finalPrice.id, later.id]]) {
      await db.channelModelCostRule.create({ data: { id, channelModelId, name: 'Current renamed rule', daysOfWeek: [1], startMinute: 0, endMinute: 1439,
        inputPerMillion: '999', outputPerMillion: '999', validFrom: new Date('2026-09-01T00:00:00Z') } })
    }
    const log = await f.log({ costUsd: '2', channelModelId: later.id, channelCostRuleId: finalPrice.id, costSnapshot: finalPrice })
    await f.route(log.id, 1, { usageSnapshot: { source: 'upstream', inputTokens: 10, cachedTokens: 2, outputTokens: 1, reasoningTokens: 0, cost: price } })
    const second = await f.route(log.id, 2)
    const breakdown = () => f.service.breakdown(f.actor, { ...range, dimension: 'channel' })
    expect((await breakdown()).items[0].price).toBeNull()
    expect(await f.service.overview(f.actor, { ...range, channelModelScope: 'UNASSOCIATED' })).toMatchObject({ requests: 1, costCny: '1.00000000' })
    await db.routeAttempt.update({ where: { id: second.id }, data: { usageSnapshot: { cost: { ...price, billingState: 'UNKNOWN' } } } })
    const same = (await breakdown()).items[0]
    expect(same.price).toMatchObject({ inputPerMillion: '1', validFrom: price.validFrom })
    expect(JSON.stringify(same.price)).not.toContain('internalSecret')
    expect((await f.service.breakdown(f.actor, { ...range, dimension: 'costRule' })).total).toBe(1)
    await db.routeAttempt.update({ where: { id: second.id }, data: { usageSnapshot: { cost: { ...price, inputPerMillion: '3' } } } })
    expect((await f.service.breakdown(f.actor, { ...range, dimension: 'costRule' })).total).toBe(2)
    expect((await breakdown()).items[0].price).toBeNull()
    await db.routeAttempt.update({ where: { id: second.id }, data: { usageSnapshot: { cost: finalPrice } } })
    expect((await breakdown()).items[0].price).toBeNull()
    const rules = await f.service.breakdown(f.actor, { ...range, dimension: 'costRule' })
    expect(rules.total).toBe(2)
    for (const item of rules.items) {
      expect(await f.service.overview(f.actor, { ...range, ...item.drillQuery })).toMatchObject({ requests: item.requests, costCny: item.costCny })
    }
    const models = await f.service.breakdown(f.actor, { ...range, dimension: 'channelModel', channelModelId: early.id })
    expect(models.items[0]).toMatchObject({ id: early.id, costCny: '1.00000000' })
    expect(await f.service.overview(f.actor, { ...range, ...models.items[0].drillQuery, costRuleId: price.id })).toMatchObject({ requests: 1, costCny: '1.00000000' })
    expect(await f.service.overview(f.actor, { ...range, channelModelId: early.id, costRuleId: finalPrice.id })).toMatchObject({ requests: 0 })
    await db.routeAttempt.update({ where: { id: second.id }, data: { usageSnapshot: { cost: { ...finalPrice, inputPerMillion: 'NaN' } } } })
    expect((await f.service.breakdown(f.actor, { ...range, dimension: 'channelModel', channelModelId: later.id })).items[0].price).toBeNull()
  }))

  it('keeps account delta drills narrow and option pages in stable name/id order with principal scope', () => withTestDatabase(async db => {
    const f = await fixture(db)
    const other = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Renamed' } })
    const beta = await db.channel.create({ data: { name: 'Beta', provider: 'test', protocol: 'OPENAI', baseUrl: 'http://127.0.0.1' } })
    const alphaTwin = await db.channel.create({ data: { name: 'Alpha', provider: 'test', protocol: 'OPENAI', baseUrl: 'http://127.0.0.1' } })
    for (const [accountId, channelId, costUsd] of [[f.account.id, f.channel.id, '1.5'], [other.id, beta.id, '9.5'], [f.account.id, alphaTwin.id, '1.5']]) {
      const log = await f.log({ accountId, channelId, costUsd, actorSnapshot: { employeeName: accountId === other.id ? 'Historical' : 'Self' } })
      await f.route(log.id, 1, { channelId, costCny: String(Number(costUsd) - 0.5) })
    }
    const groups = await f.service.breakdown(f.actor, { ...range, dimension: 'account', allocation: 'UNALLOCATED' })
    for (const row of groups.items) {
      expect(row.drillQuery).toMatchObject({ accountId: row.id, allocation: 'UNALLOCATED' })
      expect(await f.service.overview(f.actor, { ...range, ...row.drillQuery })).toMatchObject({ requests: row.requests, costCny: row.costCny })
    }
    const expected = [f.channel.id, alphaTwin.id].sort().concat(beta.id)
    for (let offset = 0; offset < expected.length; offset++) {
      const options = await f.service.filterOptions(f.actor, { ...range, optionDimension: 'channel', channelId: beta.id, sort: 'costCny', limit: 1, offset })
      expect(options.page?.items[0].id).toBe(expected[offset])
    }
    const outsider = await fixture(db)
    await outsider.log()
    const scoped = await f.service.filterOptions({ ...f.actor, role: 'MEMBER' }, { ...range, organizationId: outsider.organization.id, accountId: other.id, optionDimension: 'account', channelId: f.channel.id })
    expect(scoped.page?.items).toEqual([{ id: f.account.id, name: 'Self', drillQuery: { accountId: f.account.id } }])
    expect((await f.service.filterOptions(f.actor, { ...range, organizationId: outsider.organization.id, optionDimension: 'account' })).page?.items.map(item => item.id).sort())
      .toEqual([f.account.id, other.id].sort())
    expect((await f.service.filterOptions(f.actor, { ...range, optionDimension: 'account', channelId: beta.id })).page?.items).toEqual([{ id: other.id, name: 'Historical', drillQuery: { accountId: other.id } }])
    expect((await f.service.filterOptions(f.actor, { ...range, optionDimension: 'channel', offset: 99 })).page).toMatchObject({ items: [], total: 4 })
  }))
  it('keeps route usage and costs together, exposes the reconciliation delta, and drills unassociated channel models safely', () => withTestDatabase(async db => {
    const { actor, organization, account } = await createOrganization(db)
    const channels = await Promise.all(['Alpha route', 'Beta route'].map(name => db.channel.create({ data: { name, provider: 'test', protocol: 'OPENAI', baseUrl: 'http://127.0.0.1' } })))
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
      cacheHitRate: 1 / 3,
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
    await expect(service.breakdown(actor, { ...filter, dimension: 'channel', offset: 99 })).resolves.toMatchObject({ items: [], total: 3, offset: 99 })
    await expect(service.overview(actor, { start: '2026-09-16T00:00:00Z', end: '2026-09-17T00:00:00Z' })).resolves.toMatchObject({ requests: 0, requestSuccessRate: null })
    await expect(service.timeseries(actor, { ...filter, interval: 'day' })).resolves.toMatchObject([{ requestSuccessRate: 1, cachedTokens: '150', estimatedCostCny: '2.00000000' }])
    await expect(service.filterOptions(actor, { ...filter, channelId: channels[1].id, optionDimension: 'channel', q: 'Alpha route', limit: 1 })).resolves.toMatchObject({
      channels: [{ id: channels[0].id, name: 'Alpha route' }], page: { dimension: 'channel', total: 1, limit: 1, offset: 0, items: [{ id: channels[0].id, drillQuery: { channelId: channels[0].id } }] }
    })
  }))

  it('keeps failed, cancelled, interrupted, unknown and no-charge requests operationally distinct', () => withTestDatabase(async db => {
    const { actor, organization, account } = await createOrganization(db)
    const channel = await db.channel.create({ data: { name: 'Operations channel', provider: 'test', protocol: 'OPENAI', baseUrl: 'http://127.0.0.1' } })
    const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Operations model' } })
    const device = await db.device.create({ data: { organizationId: organization.id, accountId: account.id, name: 'Operations device', refreshTokenHash: randomUUID() } })
    const at = new Date('2026-09-15T15:59:59Z')
    const base = { organizationId: organization.id, accountId: account.id, deviceId: device.id, credentialType: 'DEVICE' as const, publicModelId: model.id, upstreamModel: 'upstream', channelId: channel.id, protocol: 'OPENAI_CHAT' as const, startedAt: at, finishedAt: at, durationMs: 10, inputTokens: 10, outputTokens: 1, cachedTokens: 0, usageSource: 'UPSTREAM' as const, streaming: false }
    await db.usageLog.createMany({ data: [
      { ...base, requestId: randomUUID(), statusCode: 500, errorCode: 'UPSTREAM_ERROR', costUsd: '1', costSnapshot: { billingState: 'CONFIRMED' } },
      { ...base, requestId: randomUUID(), statusCode: 499, clientCancelled: true, costUsd: '0.2', costSnapshot: { billingState: 'CONFIRMED' } },
      { ...base, requestId: randomUUID(), statusCode: 500, streamInterrupted: true, costUsd: '0.3', costSnapshot: { billingState: 'CONFIRMED' } },
      { ...base, requestId: randomUUID(), statusCode: 200, costUsd: '0', costSnapshot: { billingState: 'NO_CHARGE' } },
      { ...base, requestId: randomUUID(), statusCode: 200, errorCode: 'RECONCILIATION_REQUIRED', costUsd: '0.4', costSnapshot: { billingState: 'UNKNOWN' } }
    ] })
    const service = new AnalyticsService(db as PrismaService)
    const filter = { start: '2026-09-15T15:00:00Z', end: '2026-09-16T16:00:00Z', timezone: 'Asia/Shanghai' as const }
    await expect(service.overview(actor, filter)).resolves.toMatchObject({
      requests: 5, requestSuccessRate: 2 / 5, requestStates: { SUCCESS: 2, FAILED: 1, CANCELLED: 1, INTERRUPTED: 1 },
      costCny: '1.90000000', cacheHitRate: null, cacheCoverage: { knownInputTokens: '0', totalInputTokens: '50', unknownCalls: 5 },
      errorCounts: [{ errorCode: 'RECONCILIATION_REQUIRED', requests: 1 }, { errorCode: 'UPSTREAM_ERROR', requests: 1 }]
    })
    await expect(service.overview(actor, { ...filter, billingState: 'NO_CHARGE' })).resolves.toMatchObject({ requests: 1, costCny: '0.00000000' })
    await expect(service.timeseries(actor, { ...filter, interval: 'day' })).resolves.toMatchObject([{ bucket: '2026-09-14T16:00:00.000Z', requests: 5 }])
    await expect(service.breakdown(actor, { ...filter, billingState: 'UNKNOWN', dimension: 'channel' })).resolves.toMatchObject({
      items: [{ requests: 1, successRate: 0, requestSuccessRate: 1 }]
    })
    await expect(service.overview(actor, { ...filter, billingState: 'UNKNOWN' })).resolves.toMatchObject({ requests: 1, successRate: 0, requestSuccessRate: 1 })
    await expect(service.timeseries(actor, { ...filter, billingState: 'UNKNOWN' })).resolves.toMatchObject([{ requests: 1, successRate: 0, requestSuccessRate: 1 }])
    await db.usageLog.create({ data: { ...base, startedAt: new Date('2026-09-15T16:00:00Z'), requestId: randomUUID(), statusCode: 200, costUsd: '0' } })
    expect((await service.timeseries(actor, { ...filter, interval: 'day' })).map(row => ({ bucket: row.bucket, requests: row.requests }))).toEqual([
      { bucket: '2026-09-14T16:00:00.000Z', requests: 5 }, { bucket: '2026-09-15T16:00:00.000Z', requests: 1 }
    ])
    // A failed UNKNOWN request must not subtract an unrelated HTTP-successful request.
    await db.usageLog.create({ data: { ...base, requestId: randomUUID(), statusCode: 500, costUsd: '0.4', costSnapshot: { billingState: 'UNKNOWN' } } })
    expect((await service.breakdown(actor, { ...filter, dimension: 'channel' })).items[0]).toMatchObject({ successRate: 2 / 7, requestSuccessRate: 3 / 7 })
  }))
})
