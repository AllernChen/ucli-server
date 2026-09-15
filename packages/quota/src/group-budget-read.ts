import type { Prisma } from '@prisma/client'
import { availableCny, budgetPeriodKey } from './group-budget.js'

export interface GroupBudgetSummary {
  groupId: string; periodId: string | null; periodKey: string; budgetMode: 'TOTAL' | 'MONTHLY'; budgetTimezone: string
  unlimited: boolean; defaultUnlimited: boolean; defaultLimitCny: string; limitCny: string
  spentCny: string; reservedCny: string; uncertainCny: string; availableCny: string | null
}

export async function readGroupBudgets(db: Prisma.TransactionClient, organizationId: string, groupIds: readonly string[], now = new Date()): Promise<Map<string, GroupBudgetSummary>> {
  if (!groupIds.length) return new Map()
  const groups = await db.usageGroup.findMany({ where: { organizationId, id: { in: [...groupIds] } } })
  if (!groups.length) return new Map()
  const keys = new Map(groups.map(group => [group.id, budgetPeriodKey(group.budgetMode, group.budgetTimezone, now)]))
  const periods = await db.groupBudgetPeriod.findMany({ where: { organizationId,
    OR: groups.map(group => ({ groupId: group.id, periodKey: keys.get(group.id)! })) } })
  const uncertain = await db.groupBudgetEntry.groupBy({ by: ['periodId'], where: { organizationId,
    periodId: { in: periods.map(period => period.id) }, kind: 'REQUEST', status: 'RECONCILIATION_REQUIRED' }, _sum: { reservedCny: true } })
  const byGroup = new Map(periods.map(period => [period.groupId, period]))
  const byPeriod = new Map(uncertain.map(entry => [entry.periodId, entry._sum.reservedCny?.toFixed(8)]))
  return new Map(groups.map(group => {
    const period = byGroup.get(group.id)
    const limitCny = (period?.limitCny ?? group.defaultLimitCny).toFixed(8)
    const unlimited = period?.unlimited ?? group.unlimited
    const spentCny = period?.spentCny.toFixed(8) ?? '0.00000000'
    const reservedCny = period?.reservedCny.toFixed(8) ?? '0.00000000'
    return [group.id, { groupId: group.id, periodId: period?.id ?? null, periodKey: keys.get(group.id)!,
      budgetMode: group.budgetMode, budgetTimezone: group.budgetTimezone, unlimited,
      defaultUnlimited: group.unlimited, defaultLimitCny: group.defaultLimitCny.toFixed(8), limitCny, spentCny, reservedCny,
      uncertainCny: (period && byPeriod.get(period.id)) || '0.00000000',
      availableCny: unlimited ? null : availableCny(limitCny, spentCny, reservedCny) }]
  }))
}
