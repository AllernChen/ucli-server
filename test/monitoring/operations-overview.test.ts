import 'reflect-metadata'
import { expect, it, vi } from 'vitest'
import { Reflector } from '@nestjs/core'
import { AuthGuard } from '../../packages/security/src/auth.js'
import { MonitoringController } from '../../apps/api/src/monitoring.controller.js'
import { randomUUID } from 'node:crypto'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from '../integration/database.js'

it('bounds current alerts, preserves true totals, and restricts budgets to the current organization', async () => {
  const channels = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: `Channel ${i}`, enabled: true, health: i % 2 ? 'DEGRADED' : 'UNHEALTHY', deletedAt: null }))
  channels.push({ id: 'disabled', name: 'Disabled', enabled: false, health: 'UNHEALTHY', deletedAt: null })
  const logs = Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, requestId: `r${i}`, startedAt: new Date(`2025-01-0${i + 1}T00:00:00Z`),
    costUsd: { toFixed: () => '0.10000000' }, organization: { name: 'Company' }, account: { displayName: 'Employee' }, group: null,
    costSnapshot: { billingState: 'UNKNOWN' } }))
  const channelMatches = (where: any) => channels.filter(c => c.enabled === where.enabled && c.deletedAt === where.deletedAt && where.health.in.includes(c.health))
  const prisma = { channel: {
    findMany: vi.fn(async (q) => channelMatches(q.where).slice(0, q.take)), count: vi.fn(async (q) => channelMatches(q.where).length)
  }, usageLog: {
    findMany: vi.fn(async (q) => logs.filter(l => l.costSnapshot.billingState === q.where.costSnapshot.equals && l.startedAt < q.where.startedAt.lt).slice(0, q.take)),
    count: vi.fn(async (q) => logs.filter(l => l.costSnapshot.billingState === q.where.costSnapshot.equals && l.startedAt < q.where.startedAt.lt).length),
    aggregate: vi.fn(async (_query: any) => ({ _min: { startedAt: logs[0].startedAt } }))
  } }
  const allGroups = [...Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, organizationId: 'current', budget: { availableCny: '0.00000000' } })), { id: 'foreign', organizationId: 'other' }]
  const groups = { list: vi.fn(async (org, q) => ({ items: allGroups.filter(g => g.organizationId === org).slice(q.offset, q.limit), total: allGroups.filter(g => g.organizationId === org).length })) }
  const controller = new MonitoringController(prisma as any, groups as any)
  const result = await controller.overview({ principal: { organizationId: 'current' } } as any)
  expect(result).toMatchObject({ budgetOrganizationId: 'current', channels: { total: 6 }, budgets: { total: 6 }, unsettled: { total: 6, start: '2025-01-01T00:00:00.000Z' } })
  for (const section of [result.channels, result.budgets, result.unsettled]) expect(section.items).toHaveLength(5)
  expect(groups.list).toHaveBeenCalledWith('current', expect.objectContaining({ budgetRisk: 'ATTENTION', status: 'active', limit: 5, offset: 0 }))
  expect(result.unsettled.items[0]).toEqual({ id: 'l0', requestId: 'r0', label: 'Company · 历史未归组 · Employee', costCny: '0.10000000', startedAt: logs[0].startedAt })
  expect(prisma.usageLog.findMany.mock.calls[0][0]).toMatchObject({ take: 5, select: { id: true, requestId: true }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] })
  expect(prisma.usageLog.aggregate.mock.calls[0][0].where).toEqual(prisma.usageLog.count.mock.calls[0][0].where)
  expect(result.unsettled.end).toBe(result.timestamp)
})

it.each(['MEMBER', 'ORG_ADMIN'])('keeps %s out of platform monitoring with the existing role-denial status', async role => {
  const guard = new AuthGuard(new Reflector(), {} as any)
  vi.spyOn(guard, 'authenticateToken').mockResolvedValue({ role } as any)
  await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer test' } }) }),
    getHandler: () => MonitoringController.prototype.overview, getClass: () => MonitoringController } as any)).rejects.toMatchObject({ status: 401 })
})

it.skipIf(!process.env.TEST_DATABASE_URL)('reads actual PostgreSQL current-state alerts with bounded results and no budget writes', () => withTestDatabase(async db => {
  const rollback = new Error('rollback synthetic overview fixture')
  await expect(db.$transaction(async tx => {
    const owner = await createOrganization(tx as any), other = await createOrganization(tx as any)
    const devices = await Promise.all([owner, other].map(user => tx.device.create({ data: { organizationId: user.organization.id,
      accountId: user.account.id, name: 'Overview fixture', refreshTokenHash: randomUUID() } })))
    const prisma = tx as unknown as PrismaService
    const controller = new MonitoringController(prisma, new UsageGroupsService(prisma))
    const request = { principal: { ...owner.actor, role: 'PLATFORM_ADMIN' as const } }
    const baseline = await controller.overview(request)
    const model = await tx.publicModel.create({ data: { id: randomUUID(), displayName: 'Overview fixture' } })
    for (let i = 0; i < 6; i++) {
      const channel = await tx.channel.create({ data: { name: `Overview ${i}`, provider: 'test', protocol: 'OPENAI', baseUrl: 'http://127.0.0.1', health: i % 2 ? 'DEGRADED' : 'UNHEALTHY' } })
      await tx.usageGroup.create({ data: { organizationId: owner.organization.id, name: `Risk ${i}`, type: 'PROJECT' } })
      const actor = i === 5 ? other.actor : owner.actor
      await tx.usageLog.create({ data: { requestId: randomUUID(), organizationId: actor.organizationId, accountId: actor.sub, deviceId: devices[i === 5 ? 1 : 0].id,
        publicModelId: model.id, upstreamModel: 'test', channelId: channel.id, protocol: 'OPENAI_CHAT',
        startedAt: new Date('2025-01-01T00:00:00Z'), finishedAt: new Date('2025-01-01T00:00:01Z'), durationMs: 1000,
        usageSource: 'UPSTREAM', streaming: false, statusCode: 200, costUsd: '0.12345678', costSnapshot: { billingState: 'UNKNOWN', secret: 'must-not-leak' } } })
    }
    await tx.usageGroup.create({ data: { organizationId: other.organization.id, name: 'Foreign risk', type: 'PROJECT' } })
    await tx.channel.create({ data: { name: 'Disabled unhealthy', provider: 'test', protocol: 'OPENAI', baseUrl: 'http://127.0.0.1', enabled: false, health: 'UNHEALTHY' } })
    const result = await controller.overview(request)
    expect(result.channels.total - baseline.channels.total).toBe(6)
    expect(result.unsettled.total - baseline.unsettled.total).toBe(6)
    expect(result.budgets.total).toBe(6)
    for (const section of [result.channels, result.budgets, result.unsettled]) expect(section.items).toHaveLength(5)
    expect(result.budgets.items.every(group => group.organizationId === owner.organization.id)).toBe(true)
    expect(result.budgets.items.map(group => group.name)).toEqual(['Risk 0', 'Risk 1', 'Risk 2', 'Risk 3', 'Risk 4'])
    expect(await tx.groupBudgetPeriod.count({ where: { organizationId: owner.organization.id } })).toBe(0)
    expect(await tx.groupBudgetEntry.count({ where: { organizationId: owner.organization.id } })).toBe(0)
    expect(result.unsettled.items.every(item => Object.keys(item).sort().join(',') === 'costCny,id,label,requestId,startedAt')).toBe(true)
    expect(result.unsettled.start).toBe((await tx.usageLog.aggregate({ where: { costSnapshot: { path: ['billingState'], equals: 'UNKNOWN' }, startedAt: { lt: new Date(result.unsettled.end) } }, _min: { startedAt: true } }))._min.startedAt!.toISOString())
    throw rollback
  }, { isolationLevel: 'RepeatableRead', timeout: 15_000 })).rejects.toBe(rollback)
}))
