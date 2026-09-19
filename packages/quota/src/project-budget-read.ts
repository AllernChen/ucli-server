import type { Prisma } from '@prisma/client'
import { availableCny, budgetPeriodKey } from './group-budget.js'

export interface ProjectBudgetSummary {
  projectId: string
  periodId: string | null
  periodKey: string
  budgetMode: 'TOTAL' | 'MONTHLY'
  budgetTimezone: string
  unlimited: boolean
  limitCny: string
  spentCny: string
  reservedCny: string
  uncertainCny: string
  availableCny: string | null
}

export async function readProjectBudgets(
  db: Prisma.TransactionClient,
  organizationId: string,
  projectIds: readonly string[],
  now = new Date()
): Promise<Map<string, ProjectBudgetSummary>> {
  if (!projectIds.length) return new Map()
  const projects = await db.project.findMany({ where: { organizationId, id: { in: [...projectIds] } } })
  if (!projects.length) return new Map()
  const keys = new Map(projects.map(project => [project.id, budgetPeriodKey(project.budgetMode, project.budgetTimezone, now)]))
  const periods = await db.projectBudgetPeriod.findMany({ where: { organizationId,
    OR: projects.map(project => ({ projectId: project.id, periodKey: keys.get(project.id)! })) } })
  const uncertain = await db.projectBudgetEntry.groupBy({ by: ['periodId'], where: { organizationId,
    periodId: { in: periods.map(period => period.id) }, kind: 'REQUEST', status: 'RECONCILIATION_REQUIRED' },
    _sum: { reservedCny: true } })
  const byProject = new Map(periods.map(period => [period.projectId, period]))
  const byPeriod = new Map(uncertain.map(entry => [entry.periodId, entry._sum.reservedCny?.toFixed(8)]))
  return new Map(projects.map(project => {
    const period = byProject.get(project.id)
    const limitCny = (period?.limitCny ?? 0).toFixed(8)
    const spentCny = period?.spentCny.toFixed(8) ?? '0.00000000'
    const reservedCny = period?.reservedCny.toFixed(8) ?? '0.00000000'
    return [project.id, {
      projectId: project.id,
      periodId: period?.id ?? null,
      periodKey: keys.get(project.id)!,
      budgetMode: project.budgetMode,
      budgetTimezone: project.budgetTimezone,
      unlimited: period?.unlimited ?? false,
      limitCny,
      spentCny,
      reservedCny,
      uncertainCny: (period && byPeriod.get(period.id)) || '0.00000000',
      availableCny: (period?.unlimited ?? false) ? null : availableCny(limitCny, spentCny, reservedCny)
    }]
  }))
}
