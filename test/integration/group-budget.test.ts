import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { GroupBudgetService } from '../../packages/quota/src/group-budget.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'

async function fixture(db: PrismaClient, limit = '1', mode: 'TOTAL' | 'MONTHLY' = 'TOTAL') {
  const { organization, account, actor } = await createOrganization(db)
  const group = await db.usageGroup.create({ data: { organizationId: organization.id, name: 'Budget test', type: 'PROJECT', defaultLimitCny: limit, budgetMode: mode } })
  await db.groupMember.create({ data: { organizationId: organization.id, groupId: group.id, accountId: account.id } })
  const device = await db.device.create({ data: { organizationId: organization.id, accountId: account.id, name: 'Budget', refreshTokenHash: randomUUID() } })
  const channel = await db.channel.create({ data: { name: randomUUID(), provider: 'test', protocol: 'OPENAI', baseUrl: 'https://example.invalid' } })
  const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Budget model' } })
  const identity = { ...actor, credentialType: 'DEVICE' as const, groupId: group.id, deviceId: device.id }
  const service = new GroupBudgetService(db as PrismaService)
  const startedAt = new Date('2026-09-30T15:59:59Z')
  const usage = (requestId: string, costUsd: string) => ({ requestId, organizationId: organization.id, accountId: account.id, groupId: group.id,
    credentialType: 'DEVICE' as const, deviceId: device.id, channelId: channel.id, publicModelId: model.id, upstreamModel: 'test',
    protocol: 'OPENAI_CHAT' as const, startedAt, finishedAt: new Date('2026-10-01T00:00:00Z'), durationMs: 1,
    costUsd, usageSource: 'UPSTREAM' as const, streaming: false, statusCode: 200 })
  const reserve = (estimateCny = '0.75', requestId = randomUUID()) => service.reserve({ requestId, identity, startedAt, estimateCny, snapshot: {} })
  return { service, group, actor, reserve, usage, identity, startedAt }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('persistent group budget (PostgreSQL)', () => {
  it('serializes competing reservations and keeps zero distinct from unlimited', () => withTestDatabase(async db => {
    const f = await fixture(db)
    const results = await Promise.allSettled([f.reserve(), f.reserve()])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 429 } })
    const period = await db.groupBudgetPeriod.findFirstOrThrow({ where: { groupId: f.group.id } })
    expect(period.reservedCny.toFixed(8)).toBe('0.75000000')
    const zero = await fixture(db, '0')
    await expect(zero.reserve('0')).rejects.toMatchObject({ status: 429 })
    await db.usageGroup.update({ where: { id: zero.group.id }, data: { unlimited: true } })
    await expect(zero.reserve('2')).resolves.toMatchObject({ reservedCny: '2.00000000' })
  }))

  it('settles once in the starting month, detects conflicts and rolls back failed log writes', () => withTestDatabase(async db => {
    const f = await fixture(db, '1', 'MONTHLY'); const reservation = await f.reserve()
    await expect(f.service.settle(reservation, { actualCny: '0.2', usage: { ...f.usage(reservation.requestId, '0.2'), channelId: randomUUID() } })).rejects.toThrow()
    expect((await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: reservation.periodId } })).reservedCny.toFixed(8)).toBe('0.75000000')
    const input = { actualCny: '0.00000001', usage: f.usage(reservation.requestId, '0.00000001') }
    await Promise.all([f.service.settle(reservation, input), f.service.settle(reservation, input)])
    const period = await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: reservation.periodId } })
    expect(period.periodKey).toBe('2026-09'); expect(period.spentCny.toFixed(8)).toBe('0.00000001'); expect(period.reservedCny.toFixed(8)).toBe('0.00000000')
    expect(await db.usageLog.count({ where: { requestId: reservation.requestId } })).toBe(1)
    await expect(f.service.settle(reservation, { actualCny: '0.2', usage: f.usage(reservation.requestId, '0.2') })).rejects.toMatchObject({ status: 409 })
    await expect(f.service.release(reservation, 'late release')).rejects.toMatchObject({ status: 409 })
  }))

  it('retains dispatched amounts on recovery and accepts late settlement after group disable', () => withTestDatabase(async db => {
    const f = await fixture(db, '2'); const unsent = await f.reserve(); const sent = await f.reserve()
    const expired = new Date(Date.now() - 1000)
    await db.groupBudgetEntry.update({ where: { id: unsent.id }, data: { leaseUntil: expired } })
    await f.service.markDispatched(sent, expired)
    await f.service.recoverExpired(new Date())
    expect((await db.groupBudgetEntry.findUniqueOrThrow({ where: { id: unsent.id } })).status).toBe('RELEASED')
    expect((await db.groupBudgetEntry.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe('RECONCILIATION_REQUIRED')
    await expect(f.service.release(sent, 'timeout')).rejects.toMatchObject({ status: 409 })
    await db.usageGroup.update({ where: { id: f.group.id }, data: { enabled: false } })
    await f.service.settle(sent, { actualCny: '2.1', usage: f.usage(sent.requestId, '2.1') })
    const period = await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: sent.periodId } })
    expect(period.spentCny.toFixed(8)).toBe('2.10000000'); expect(period.reservedCny.toFixed(8)).toBe('0.00000000'); expect(period.alertedThreshold).toBe(100)
  }))

  it('deduplicates retry extensions and refuses overspending', () => withTestDatabase(async db => {
    const f = await fixture(db); const reservation = await f.reserve('0.4')
    const snapshot = { attemptId: '2', channel: 'test' }
    await Promise.all([f.service.extend(reservation, '0.4', snapshot), f.service.extend(reservation, '0.4', snapshot)])
    expect((await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: reservation.periodId } })).reservedCny.toFixed(8)).toBe('0.80000000')
    await expect(f.service.extend(reservation, '0.3', { attemptId: '3' })).rejects.toMatchObject({ status: 429 })
    await expect(f.service.extend(reservation, '0.3', snapshot)).rejects.toMatchObject({ status: 409 })
  }))

  it('audits idempotent current/default adjustments and forbids lowering occupied funds or crossing tenants', () => withTestDatabase(async db => {
    const f = await fixture(db, '1', 'MONTHLY'); const reservation = await f.reserve()
    const adjustment = { operationId: randomUUID(), scope: 'CURRENT' as const, limitCny: '2', unlimited: false, reason: 'Approved allocation' }
    // Use the starting period explicitly; wall clock must not move a requested adjustment to another month.
    await Promise.all([f.service.adjust(f.actor, f.group.id, { ...adjustment, periodId: reservation.periodId }),
      f.service.adjust(f.actor, f.group.id, { ...adjustment, periodId: reservation.periodId })])
    expect(await db.groupBudgetEntry.count({ where: { operationId: adjustment.operationId } })).toBe(1)
    expect((await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: reservation.periodId } })).limitCny.toFixed(8)).toBe('2.00000000')
    await expect(f.service.adjust(f.actor, f.group.id, { ...adjustment, periodId: reservation.periodId, limitCny: '3' })).rejects.toMatchObject({ status: 409 })
    await expect(f.service.adjust(f.actor, f.group.id, { ...adjustment, periodId: reservation.periodId, operationId: randomUUID(), limitCny: '0.5' })).rejects.toMatchObject({ status: 409 })
    const other = await createOrganization(db)
    await expect(f.service.adjust(other.actor, f.group.id, adjustment)).rejects.toMatchObject({ status: 404 })
    await f.service.adjust(f.actor, f.group.id, { ...adjustment, operationId: randomUUID(), scope: 'DEFAULT', limitCny: '5' })
    expect((await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: reservation.periodId } })).limitCny.toFixed(8)).toBe('2.00000000')
    expect((await db.usageGroup.findUniqueOrThrow({ where: { id: f.group.id } })).defaultLimitCny.toFixed(8)).toBe('5.00000000')
    await expect(f.service.configure(f.actor, f.group.id, { operationId: randomUUID(), budgetMode: 'TOTAL', budgetTimezone: 'UTC', reason: 'Change mode' })).rejects.toMatchObject({ status: 409 })
  }))

  it('reconciles unknown requests and makes manual final costs authoritative with an immutable audit', () => withTestDatabase(async db => {
    const f = await fixture(db); const requestId = randomUUID()
    const usage = f.usage(requestId, '0')
    const reservation = await f.service.reserve({ requestId, identity: f.identity, startedAt: f.startedAt, estimateCny: '0.75',
      snapshot: { usage: JSON.parse(JSON.stringify(usage)) } })
    await f.service.markDispatched(reservation, new Date()); await f.service.markUncertain(reservation, 'Network timeout')
    const adjustment = { operationId: randomUUID(), actualCny: '0.2', reason: 'Supplier bill confirmed', action: 'SETTLE' as const }
    await Promise.all([f.service.reconcile(f.actor, f.group.id, reservation.id, adjustment), f.service.reconcile(f.actor, f.group.id, reservation.id, adjustment)])
    expect((await db.usageLog.findUniqueOrThrow({ where: { requestId } })).costUsd.toFixed(8)).toBe('0.20000000')
    const period = await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: reservation.periodId } })
    expect(period.spentCny.toFixed(8)).toBe('0.20000000'); expect(period.reservedCny.toFixed(8)).toBe('0.00000000')
    await expect(f.service.settle(reservation, { actualCny: '0.5', usage: f.usage(requestId, '0.5') })).rejects.toMatchObject({ status: 409 })
    await f.service.reconcile(f.actor, f.group.id, reservation.id, { ...adjustment, operationId: randomUUID(), actualCny: '0.1', reason: 'Corrected supplier bill' })
    expect((await db.usageLog.findUniqueOrThrow({ where: { requestId } })).costUsd.toFixed(8)).toBe('0.10000000')
    expect(await db.auditLog.count({ where: { organizationId: f.actor.organizationId, action: 'GROUP_BUDGET_COST_ADJUSTMENT' } })).toBe(2)
    expect((await db.groupBudgetEntry.findUniqueOrThrow({ where: { id: reservation.id } })).snapshot).toMatchObject({ manualFinal: true, request: { usage: { costUsd: '0' } } })
  }))

  it.each([
    { action: 'SETTLE' as const, amount: '0.20000000', billingState: 'CONFIRMED' },
    { action: 'RELEASE' as const, amount: '0.00000000', billingState: 'NO_CHARGE' }
  ])('records $billingState when $action reconstructs a missing usage log', ({ action, amount, billingState }) => withTestDatabase(async db => {
    const f = await fixture(db); const requestId = randomUUID()
    const usage = { ...f.usage(requestId, '0'), costSnapshot: { billingState: 'UNKNOWN', source: 'PUBLIC_MODEL_FALLBACK' } }
    const reservation = await f.service.reserve({ requestId, identity: f.identity, startedAt: f.startedAt, estimateCny: '0.75',
      snapshot: { usage: JSON.parse(JSON.stringify(usage)) } })
    await f.service.markDispatched(reservation, new Date())
    await f.service.markUncertain(reservation, 'Log transaction failed')
    await f.service.reconcile(f.actor, f.group.id, reservation.id, { operationId: randomUUID(), action, actualCny: amount, reason: 'Supplier bill checked' })
    const log = await db.usageLog.findUniqueOrThrow({ where: { requestId } })
    expect(log.costSnapshot).toEqual({ billingState, source: 'PUBLIC_MODEL_FALLBACK' })
    expect(log.costUsd.toFixed(8)).toBe(amount)
    const period = await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: reservation.periodId } })
    expect(period.spentCny.toFixed(8)).toBe(amount)
    expect(period.reservedCny.toFixed(8)).toBe('0.00000000')
    expect((await db.groupBudgetEntry.findUniqueOrThrow({ where: { id: reservation.id } })).snapshot)
      .toMatchObject({ request: { usage: { costSnapshot: { billingState: 'UNKNOWN' } } } })
  }))

  it('requires an explicit route cost split and corrects supplier totals together', () => withTestDatabase(async db => {
    const f = await fixture(db); const reservation = await f.reserve()
    const usage = f.usage(reservation.requestId, '0.3')
    await f.service.settle(reservation, { actualCny: '0.3', usage: { ...usage, routes: { create: [1, 2].map(attempt => ({
      channelId: usage.channelId, attempt, startedAt: usage.startedAt, durationMs: 1, costCny: attempt === 1 ? '0.1' : '0.2', billingState: 'CONFIRMED' as const
    })) } } })
    const routes = await db.routeAttempt.findMany({ where: { usageLog: { requestId: reservation.requestId } }, orderBy: { attempt: 'asc' } })
    const input = { operationId: randomUUID(), actualCny: '0.5', reason: 'Supplier invoices', action: 'SETTLE' as const,
      routes: routes.map(route => ({ id: route.id, costCny: '0.25' })) }
    await f.service.reconcile(f.actor, f.group.id, reservation.id, input)
    expect((await db.routeAttempt.findMany({ where: { id: { in: routes.map(r => r.id) } } })).map(r => r.costCny?.toFixed(8))).toEqual(['0.25000000', '0.25000000'])
    await expect(f.service.reconcile(f.actor, f.group.id, reservation.id, { ...input, operationId: randomUUID(), actualCny: '0.4' })).rejects.toMatchObject({ status: 409 })
  }))

  it('keeps only unresolved attempt reservations while persisting known costs, then settles the remaining delta', () => withTestDatabase(async db => {
    const f = await fixture(db, '2'); const reservation = await f.reserve('1')
    const input = { actualCny: '0.2', unresolvedCny: '0.5', usage: f.usage(reservation.requestId, '0.2'), reason: 'One attempt timed out' }
    await f.service.hold(reservation, input); await f.service.hold(reservation, input)
    let period = await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: reservation.periodId } })
    expect(period.spentCny.toFixed(8)).toBe('0.20000000'); expect(period.reservedCny.toFixed(8)).toBe('0.50000000')
    await f.service.settle(reservation, { actualCny: '0.3', usage: f.usage(reservation.requestId, '0.3') })
    period = await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: reservation.periodId } })
    expect(period.spentCny.toFixed(8)).toBe('0.30000000'); expect(period.reservedCny.toFixed(8)).toBe('0.00000000')
    expect((await db.usageLog.findUniqueOrThrow({ where: { requestId: reservation.requestId } })).costUsd.toFixed(8)).toBe('0.30000000')
  }))

  it('checks key revocation again under the group reservation lock', () => withTestDatabase(async db => {
    const f = await fixture(db)
    const key = await db.employeeApiKey.create({ data: { organizationId: f.actor.organizationId, accountId: f.actor.sub, groupId: f.group.id,
      createdById: f.actor.sub, name: 'Revoked while authorizing', secretHash: randomUUID(), secretHint: 'test', revokedAt: new Date() } })
    await expect(f.service.reserve({ requestId: randomUUID(), identity: { ...f.actor, credentialType: 'API_KEY', apiKeyId: key.id, groupId: f.group.id },
      startedAt: new Date(), estimateCny: '0.1', snapshot: {} })).rejects.toMatchObject({ status: 401 })
    expect(await db.groupBudgetPeriod.count({ where: { groupId: f.group.id } })).toBe(0)
  }))
})
