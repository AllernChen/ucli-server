import { ForbiddenException, Injectable } from '@nestjs/common'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { readProjectBudgets } from '../../../packages/quota/src/project-budget-read.js'
import type { AuthPrincipal } from '../../../packages/security/src/auth.js'
import { AnalyticsService } from './analytics.service.js'
import type { AnalyticsQueryDto } from './analytics.dto.js'

type BreakdownItem = {
  id: string | null
  name: string
  requests: number
  totalTokens: string
  costCny: string
}

@Injectable()
export class ProfileUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService
  ) {}

  async summary(actorInput: AuthPrincipal, query: AnalyticsQueryDto) {
    const actor = this.webActor(actorInput)
    const ownQuery: AnalyticsQueryDto = { ...query, organizationId: actor.organizationId, accountId: actor.sub }
    const [overview, groups, projectUsage, keyUsage] = await Promise.all([
      this.analytics.overview(actor, ownQuery),
      this.analytics.breakdown(actor, { ...ownQuery, dimension: 'group', limit: 20, offset: query.offset || 0 }),
      this.analytics.breakdown(actor, { ...ownQuery, dimension: 'project', limit: 200 }),
      this.analytics.breakdown(actor, { ...ownQuery, dimension: 'apiKey', limit: 200 })
    ])

    const projects = await this.prisma.project.findMany({
      where: {
        organizationId: actor.organizationId,
        status: 'ACTIVE',
        region: {
          orgType: { in: ['REGION', 'FUNCTIONAL', 'EXECUTIVE'] },
          enabled: true,
          archivedAt: null,
          organization: { enabled: true }
        },
        OR: [
          { members: { some: { accountId: actor.sub, membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } } } } },
          { region: { members: { some: { accountId: actor.sub, removedAt: null, membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } } } } } }
        ]
      },
      select: {
        id: true, code: true, name: true, category: true, budgetMode: true, budgetTimezone: true,
        region: { select: { id: true, name: true } }
      },
      orderBy: [{ region: { name: 'asc' } }, { name: 'asc' }]
    })
    const budgets = await readProjectBudgets(this.prisma, actor.organizationId, projects.map(project => project.id))
    const ownProjectUsage = new Map(projectUsage.items.filter(item => item.id).map(item => [item.id!, item]))
    const ownKeyUsage = new Map(keyUsage.items.filter(item => item.id).map(item => [item.id!, item]))
    const ownTokens = new Decimal(overview.inputTokens || 0).plus(overview.outputTokens || 0)
    const ownCost = new Decimal(overview.costCny || 0)

    const projectRows = projects.map(project => {
      const budget = budgets.get(project.id)
      const usage = ownProjectUsage.get(project.id)
      const limit = new Decimal(budget?.limitCny || 0)
      const occupied = new Decimal(budget?.spentCny || 0).plus(budget?.reservedCny || 0)
      const cost = new Decimal(usage?.costCny || 0)
      return {
        id: project.id,
        code: project.code,
        name: project.name,
        category: project.category,
        budgetMode: project.budgetMode,
        budgetTimezone: project.budgetTimezone,
        region: project.region,
        budget: budget ? {
          limitCny: budget.limitCny,
          spentCny: budget.spentCny,
          reservedCny: budget.reservedCny,
          uncertainCny: budget.uncertainCny,
          availableCny: budget.availableCny,
          unlimited: budget.unlimited,
          usagePercent: share(occupied, limit, !budget.unlimited)
        } : null,
        usage: {
          requests: usage?.requests ?? 0,
          totalTokens: usage?.totalTokens ?? '0',
          costCny: cost.toFixed(8)
        },
        shares: {
          budgetPercent: budget ? share(cost, limit, !budget.unlimited) : null,
          projectUsagePercent: share(cost, occupied, occupied.greaterThan(0))
        }
      }
    })

    const keys = await this.prisma.employeeApiKey.findMany({
      where: { organizationId: actor.organizationId, accountId: actor.sub, deletedAt: null },
      select: {
        id: true, name: true, secretHint: true, expiresAt: true, disabledAt: true, revokedAt: true, lastUsedAt: true,
        group: { select: { id: true, name: true } },
        project: { select: { id: true, code: true, name: true } }
      },
      orderBy: [{ project: { name: 'asc' } }, { name: 'asc' }, { id: 'asc' }]
    })
    const keyRows = keys.map(key => {
      const usage = ownKeyUsage.get(key.id)
      const cost = new Decimal(usage?.costCny || 0)
      const budget = key.project ? budgets.get(key.project.id) : undefined
      const limit = new Decimal(budget?.limitCny || 0)
      return {
        id: key.id,
        name: key.name,
        secretHint: key.secretHint,
        status: key.revokedAt ? 'revoked' : key.disabledAt ? 'disabled' : key.expiresAt && key.expiresAt <= new Date() ? 'expired' : 'active',
        expiresAt: key.expiresAt,
        lastUsedAt: key.lastUsedAt,
        group: key.group,
        project: key.project,
        usage: {
          requests: usage?.requests ?? 0,
          totalTokens: usage?.totalTokens ?? '0',
          costCny: cost.toFixed(8)
        },
        shares: {
          ownUsagePercent: share(cost, ownCost, ownCost.greaterThan(0)),
          projectBudgetPercent: budget ? share(cost, limit, !budget.unlimited) : null
        }
      }
    })

    const finiteBudgets = projectRows.filter(row => row.budget && !row.budget.unlimited)
    const totalLimit = finiteBudgets.reduce((sum, row) => sum.plus(row.budget!.limitCny), new Decimal(0))
    const totalSpent = projectRows.reduce((sum, row) => sum.plus(row.budget?.spentCny || 0), new Decimal(0))
    const totalReserved = projectRows.reduce((sum, row) => sum.plus(row.budget?.reservedCny || 0), new Decimal(0))
    const totalOccupied = totalSpent.plus(totalReserved)
    const finiteOccupied = finiteBudgets.reduce((sum, row) =>
      sum.plus(row.budget!.spentCny).plus(row.budget!.reservedCny), new Decimal(0))
    const unlimitedProjectCount = projectRows.length - finiteBudgets.length
    const totalAvailable = Decimal.max(0, totalLimit.minus(finiteOccupied))

    return {
      overview,
      groups,
      projects: projectRows,
      keys: keyRows,
      summary: {
        projectCount: projectRows.length,
        keyCount: keyRows.length,
        activeKeyCount: keyRows.filter(key => key.status === 'active').length,
        unlimitedProjectCount,
        totalLimitCny: totalLimit.toFixed(8),
        totalSpentCny: totalSpent.toFixed(8),
        totalReservedCny: totalReserved.toFixed(8),
        totalOccupiedCny: totalOccupied.toFixed(8),
        totalAvailableCny: totalAvailable.toFixed(8),
        totalUsagePercent: unlimitedProjectCount ? null : share(totalOccupied, totalLimit, totalLimit.greaterThan(0)),
        ownUsagePercentOfTotalBudget: unlimitedProjectCount ? null : share(ownCost, totalLimit, totalLimit.greaterThan(0)),
        ownUsage: {
          requests: overview.requests,
          totalTokens: ownTokens.toFixed(0),
          costCny: ownCost.toFixed(8)
        }
      }
    }
  }

  private webActor(actor: AuthPrincipal) {
    if (actor.deviceId) throw new ForbiddenException('Web login required')
    return actor
  }
}

function share(value: Decimal, denominator: Decimal, enabled: boolean) {
  return enabled && denominator.greaterThan(0)
    ? Number(value.dividedBy(denominator).times(100).toFixed(2))
    : null
}
