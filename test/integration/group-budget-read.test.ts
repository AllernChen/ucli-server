import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { readGroupBudgets } from '../../packages/quota/src/group-budget-read.js'
import { createOrganization, testDatabaseUrl, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('batch group budget reads (PostgreSQL)', () => {
  it('reads defaults without creating periods, scopes IDs and uses each group timezone', () => withTestDatabase(async db => {
    const { actor } = await createOrganization(db)
    const other = await createOrganization(db)
    const groups = await Promise.all([
      { name: 'Total', budgetMode: 'TOTAL' as const, defaultLimitCny: '3' },
      { name: 'Shanghai', budgetMode: 'MONTHLY' as const, budgetTimezone: 'Asia/Shanghai', defaultLimitCny: '2' },
      { name: 'New York', budgetMode: 'MONTHLY' as const, budgetTimezone: 'America/New_York', defaultLimitCny: '4' },
      { name: 'Zero', defaultLimitCny: '0' }, { name: 'Unlimited', unlimited: true }
    ].map(data => db.usageGroup.create({ data: { organizationId: actor.organizationId, type: 'PROJECT', ...data } })))
    const before = await db.groupBudgetPeriod.count({ where: { organizationId: actor.organizationId } })
    const result = await readGroupBudgets(db, actor.organizationId, [...groups.map(g => g.id), randomUUID()], new Date('2026-09-30T16:00:00Z'))
    expect(result.size).toBe(5)
    expect(result.get(groups[0].id)).toEqual({ groupId: groups[0].id, periodId: null, periodKey: 'TOTAL', budgetMode: 'TOTAL',
      budgetTimezone: 'Asia/Shanghai', unlimited: false, defaultUnlimited: false, defaultLimitCny: '3.00000000',
      limitCny: '3.00000000', spentCny: '0.00000000', reservedCny: '0.00000000', uncertainCny: '0.00000000', availableCny: '3.00000000' })
    expect(result.get(groups[1].id)).toMatchObject({ periodKey: '2026-10', reservedCny: '0.00000000', availableCny: '2.00000000' })
    expect(result.get(groups[2].id)).toMatchObject({ periodKey: '2026-09', availableCny: '4.00000000' })
    expect(result.get(groups[3].id)).toMatchObject({ unlimited: false, availableCny: '0.00000000' })
    expect(result.get(groups[4].id)).toMatchObject({ unlimited: true, availableCny: null })
    expect(await db.groupBudgetPeriod.count({ where: { organizationId: actor.organizationId } })).toBe(before)
    expect(await readGroupBudgets(db, other.actor.organizationId, groups.map(g => g.id))).toEqual(new Map())
    expect(await readGroupBudgets(db, actor.organizationId, [])).toEqual(new Map())
  }))

  it('bounds reads to three queries for twenty groups and ignores historical uncertainty', async () => {
    const queries: string[] = []
    const db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } }, log: [{ emit: 'event', level: 'query' }] })
    db.$on('query', event => queries.push(event.query))
    try {
      const { actor } = await createOrganization(db)
      const groups = await Promise.all(Array.from({ length: 20 }, (_, i) => db.usageGroup.create({ data: {
        organizationId: actor.organizationId, name: `Group ${i}`, type: 'DEPARTMENT', budgetMode: 'MONTHLY', defaultLimitCny: '2' } })))
      const period = await db.groupBudgetPeriod.create({ data: { organizationId: actor.organizationId, groupId: groups[0].id,
        periodKey: '2026-10', timezone: 'Asia/Shanghai', limitCny: '1', spentCny: '0.7', reservedCny: '0.5' } })
      const historical = await db.groupBudgetPeriod.create({ data: { organizationId: actor.organizationId, groupId: groups[0].id,
        periodKey: '2026-09', timezone: 'Asia/Shanghai', limitCny: '10', reservedCny: '4' } })
      await db.groupBudgetEntry.createMany({ data: [
        { periodId: period.id, reservedCny: '0.3', status: 'RECONCILIATION_REQUIRED' as const },
        { periodId: period.id, reservedCny: '0.2', status: 'RESERVED' as const },
        { periodId: historical.id, reservedCny: '4', status: 'RECONCILIATION_REQUIRED' as const }
      ].map(entry => ({ ...entry, organizationId: actor.organizationId, groupId: groups[0].id, kind: 'REQUEST', operationId: randomUUID(),
        requestId: randomUUID(), accountId: actor.sub, credentialType: 'DEVICE', credentialId: randomUUID(), snapshot: {} })) })
      queries.length = 0
      const result = await readGroupBudgets(db, actor.organizationId, groups.map(g => g.id), new Date('2026-09-30T16:00:00Z'))
      expect(queries).toHaveLength(3)
      expect(queries.every(query => /^SELECT\b/i.test(query))).toBe(true)
      expect(result.size).toBe(20)
      expect(result.get(groups[0].id)).toMatchObject({ periodId: period.id, defaultLimitCny: '2.00000000', limitCny: '1.00000000',
        spentCny: '0.70000000', reservedCny: '0.50000000', uncertainCny: '0.30000000', availableCny: '-0.20000000' })
    } finally { await db.$disconnect() }
  })
})
