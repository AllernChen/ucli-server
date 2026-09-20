import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { OrgUnitType, Prisma, type UsageGroup } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AuthPrincipal } from '../../../packages/security/src/auth.js'
import { readProjectBudgets } from '../../../packages/quota/src/project-budget-read.js'
import { PageQueryDto } from './catalog.dto.js'
import { OrgUnitPageQueryDto, type CreateOrgUnitDto, type UpdateOrgUnitDto } from './org-units.dto.js'

@Injectable()
export class OrgUnitsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(actor: AuthPrincipal) {
    if (!['PLATFORM_ADMIN', 'ORG_ADMIN'].includes(actor.role)) throw new ForbiddenException('Administrator required')
  }

  private assertMutable(group: UsageGroup) {
    if (group.orgType === 'LEGACY_PROJECT') throw new ConflictException('Legacy project organizations are read-only')
  }

  private legacyType(kind: Exclude<OrgUnitType, 'LEGACY_PROJECT'>) {
    return kind === 'REGION' ? 'REGION' : 'DEPARTMENT'
  }

  private audit(db: Prisma.TransactionClient, actor: AuthPrincipal, id: string, action: string, metadata: Prisma.InputJsonObject = {}) {
    return db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
      action: `org_unit.${action}`, resourceType: 'org_unit', resourceId: id, metadata } })
  }

  async create(actor: AuthPrincipal, input: CreateOrgUnitDto) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.create({ data: {
        organizationId: actor.organizationId, name: input.name, type: this.legacyType(input.kind),
        orgType: input.kind, description: input.description ?? ''
      } })
      if (input.kind !== 'REGION') {
        await db.project.create({ data: {
          organizationId: actor.organizationId, regionId: group.id, category: 'DEPARTMENT',
          code: `DEPT-${randomUUID().slice(0, 8).toUpperCase()}`, name: `${input.name}-部门预算`, description: ''
        } })
      }
      await this.audit(db, actor, group.id, 'create', { name: input.name, kind: input.kind })
      return db.usageGroup.findUniqueOrThrow({ where: { id: group.id } })
    })
  }

  async list(organizationId: string, query = new OrgUnitPageQueryDto()) {
    const where: Prisma.UsageGroupWhereInput = {
      organizationId,
      ...(query.kind ? { orgType: query.kind } : {}),
      ...(query.status === 'archived' ? { archivedAt: { not: null } } : query.status === 'all' ? {} :
        { archivedAt: null, enabled: query.status === 'active' }),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {})
    }
    const [groups, total] = await Promise.all([
      this.prisma.usageGroup.findMany({ where, skip: query.offset, take: query.limit,
        orderBy: [{ orgType: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        include: {
          _count: { select: {
            members: { where: { removedAt: null, isPrimary: true } },
            models: true,
            keys: { where: { revokedAt: null, disabledAt: null, deletedAt: null } }
          } },
          projects: { where: { status: 'ACTIVE' },
            select: { id: true, category: true } }
        } }),
      this.prisma.usageGroup.count({ where })
    ])
    const summaries = await this.summarizeOrganizations(organizationId, groups)
    return { items: groups.map(group => {
      const departmentProject = group.projects.find(project => project.category === 'DEPARTMENT') ?? null
      return { ...group, projects: undefined, departmentProject,
        memberCount: group._count.members, modelCount: group._count.models, activeKeyCount: group._count.keys,
        budget: summaries.get(group.id)?.budget, usage: summaries.get(group.id)?.usage }
    }), total, limit: query.limit, offset: query.offset }
  }

  async detail(organizationId: string, id: string) {
    const group = await this.prisma.usageGroup.findFirst({ where: { id, organizationId },
      include: {
        _count: { select: {
          members: { where: { removedAt: null, isPrimary: true } },
          models: true,
          keys: { where: { revokedAt: null, disabledAt: null, deletedAt: null } },
          projects: { where: { status: 'ACTIVE' } }
        } },
        projects: { where: { status: 'ACTIVE' }, orderBy: [{ category: 'asc' }, { name: 'asc' }],
          select: { id: true, code: true, name: true, status: true, category: true,
            _count: { select: { members: true, employeeKeys: { where: { revokedAt: null, disabledAt: null, deletedAt: null } } } } } }
    } })
    if (!group) throw new NotFoundException('Organization unit not found')
    const { projects, _count, ...summary } = group
    const summaries = await this.summarizeOrganizations(organizationId, [group])
    return { ...summary, projects, memberCount: _count.members, modelCount: _count.models,
      activeKeyCount: _count.keys, activeProjectCount: _count.projects,
      budget: summaries.get(id)?.budget, usage: summaries.get(id)?.usage,
      departmentProject: projects.find(project => project.category === 'DEPARTMENT') ?? null }
  }

  private async summarizeOrganizations(organizationId: string, groups: UsageGroup[]) {
    const organizationsById = new Map(groups.map(group => [group.id, group]))
    const projects = await this.prisma.project.findMany({ where: {
      organizationId, regionId: { in: [...organizationsById.keys()] }, status: 'ACTIVE'
    }, select: { id: true, regionId: true, status: true, category: true } })
    const projectIds = projects.map(project => project.id)
    const since = new Date(Date.now() - 30 * 86_400_000)
    const budgets = await readProjectBudgets(this.prisma, organizationId, projectIds)
    const usageWhere = {
      organizationId, budgetProjectId: { in: projectIds }, startedAt: { gte: since }
    }
    const usageRows = projectIds.length ? await this.prisma.usageLog.groupBy({
      by: ['budgetProjectId'], where: usageWhere,
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      _max: { startedAt: true }
    }) : []
    const activeAccountRows = projectIds.length ? await this.prisma.usageLog.findMany({
      where: usageWhere, select: { budgetProjectId: true, accountId: true }, distinct: ['budgetProjectId', 'accountId']
    }) : []
    const usageByProject = new Map(usageRows.filter(row => row.budgetProjectId).map(row => [row.budgetProjectId, {
      requests: row._count._all,
      totalTokens: ((row._sum.inputTokens ?? 0n) + (row._sum.outputTokens ?? 0n)).toString(),
      costCny: new Decimal(row._sum.costUsd ?? 0).toFixed(8),
      activeAccounts: activeAccountRows.filter(item => item.budgetProjectId === row.budgetProjectId).length,
      lastUsedAt: row._max.startedAt
    }]))
    return new Map(groups.map(group => {
      const owned = projects.filter(project => project.regionId === group.id)
      const summaries = owned.map(project => ({ project, budget: budgets.get(project.id) }))
      const unlimitedCount = summaries.filter(item => item.budget?.unlimited).length
      const totalLimit = summaries.reduce((sum, item) => sum.plus(item.budget?.limitCny || 0), new Decimal(0))
      const spent = summaries.reduce((sum, item) => sum.plus(item.budget?.spentCny || 0), new Decimal(0))
      const reserved = summaries.reduce((sum, item) => sum.plus(item.budget?.reservedCny || 0), new Decimal(0))
      const occupied = spent.plus(reserved)
      const available = summaries.some(item => item.budget?.unlimited) ? null : Decimal.max(totalLimit.minus(occupied), 0)
      const alertCount = summaries.filter(item => {
        if (!item.budget || item.budget.unlimited) return false
        const limit = new Decimal(item.budget.limitCny)
        const used = new Decimal(item.budget.spentCny).plus(item.budget.reservedCny)
        return limit.greaterThan(0) && used.dividedBy(limit).greaterThanOrEqualTo(0.8)
      }).length
      const usage = owned.reduce((sum, project) => {
        const value = usageByProject.get(project.id)
        if (!value) return sum
        return {
          requests: sum.requests + value.requests,
          totalTokens: (BigInt(sum.totalTokens) + BigInt(value.totalTokens)).toString(),
          costCny: new Decimal(sum.costCny).plus(value.costCny).toFixed(8),
          activeAccounts: sum.activeAccounts + value.activeAccounts,
          lastUsedAt: !sum.lastUsedAt || (value.lastUsedAt && value.lastUsedAt > new Date(sum.lastUsedAt)) ? value.lastUsedAt?.toISOString() ?? sum.lastUsedAt : sum.lastUsedAt
        }
      }, { requests: 0, totalTokens: '0', costCny: '0.00000000', activeAccounts: 0, lastUsedAt: null as string | null })
      return [group.id, {
        budget: {
          projectCount: owned.length,
          budgetProjectCount: owned.filter(project => project.category === 'DEPARTMENT').length,
          unlimitedProjectCount: unlimitedCount,
          totalLimitCny: totalLimit.toFixed(8),
          spentCny: spent.toFixed(8),
          reservedCny: reserved.toFixed(8),
          occupiedCny: occupied.toFixed(8),
          availableCny: available?.toFixed(8) ?? null,
          usagePercent: !unlimitedCount && totalLimit.greaterThan(0) ? Number(occupied.dividedBy(totalLimit).times(100).toFixed(2)) : null,
          alertProjectCount: alertCount
        },
        usage
      }]
    }))
  }

  update(actor: AuthPrincipal, id: string, input: UpdateOrgUnitDto) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.findFirst({ where: { id, organizationId: actor.organizationId } })
      if (!group) throw new NotFoundException('Organization unit not found')
      this.assertMutable(group)
      const updated = await db.usageGroup.update({ where: { id }, data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {})
      } })
      await this.audit(db, actor, id, 'update', { ...input })
      return updated
    })
  }

  addMember(actor: AuthPrincipal, id: string, accountId: string) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.findFirst({ where: { id, organizationId: actor.organizationId } })
      if (!group) throw new NotFoundException('Organization unit not found')
      this.assertMutable(group)
      const member = await db.membership.findFirst({ where: {
        organizationId: actor.organizationId, accountId, status: 'ACTIVE', account: { status: 'ACTIVE' }
      } })
      if (!member) throw new ForbiddenException('Active organization member required')
      const now = new Date()
      const currentPrimary = await db.groupMember.findFirst({ where: {
        organizationId: actor.organizationId, accountId, removedAt: null, isPrimary: true
      }, include: { group: { select: { id: true, orgType: true } } } })
      if (currentPrimary && ['FUNCTIONAL', 'EXECUTIVE'].includes(currentPrimary.group.orgType)) {
        await db.projectMember.deleteMany({ where: { organizationId: actor.organizationId,
          project: { regionId: currentPrimary.groupId, category: 'DEPARTMENT' }, accountId } })
      }
      await db.groupMember.updateMany({ where: {
        organizationId: actor.organizationId, accountId, removedAt: null, isPrimary: true
      }, data: { removedAt: now, isPrimary: false } })
      const updated = await db.groupMember.upsert({ where: { groupId_accountId: { groupId: id, accountId } },
        create: { organizationId: actor.organizationId, groupId: id, accountId, isPrimary: true, joinedAt: now },
        update: { removedAt: null, isPrimary: true, joinedAt: now },
        include: { membership: { select: { status: true, role: true,
          account: { select: { id: true, displayName: true, email: true, status: true } } } } } })
      if (group.orgType === 'FUNCTIONAL' || group.orgType === 'EXECUTIVE') {
        const departmentProject = await db.project.findFirst({ where: {
          organizationId: actor.organizationId, regionId: id, category: 'DEPARTMENT', status: 'ACTIVE'
        }, select: { id: true } })
        if (departmentProject) {
          await db.projectMember.upsert({ where: { projectId_accountId: {
            projectId: departmentProject.id, accountId
          } }, create: { organizationId: actor.organizationId, projectId: departmentProject.id, accountId },
            update: {} })
        }
      }
      await this.audit(db, actor, id, 'member_add', { accountId })
      return updated
    })
  }

  async removeMember(actor: AuthPrincipal, id: string, accountId: string) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.findFirst({ where: { id, organizationId: actor.organizationId } })
      if (!group) throw new NotFoundException('Organization unit not found')
      this.assertMutable(group)
      const existing = await db.groupMember.findFirst({ where: {
        organizationId: actor.organizationId, groupId: id, accountId, removedAt: null
      } })
      if (!existing) throw new NotFoundException('Organization member not found')
      const now = new Date()
      await db.groupMember.update({ where: { groupId_accountId: { groupId: id, accountId } },
        data: { removedAt: now, isPrimary: false } })
      let revokedDepartmentKeyCount = 0
      if (group.orgType === 'FUNCTIONAL' || group.orgType === 'EXECUTIVE') {
        const departmentProject = await db.project.findFirst({ where: {
          organizationId: actor.organizationId, regionId: id, category: 'DEPARTMENT'
        }, select: { id: true } })
        if (departmentProject) {
          await db.projectMember.deleteMany({ where: { organizationId: actor.organizationId,
            projectId: departmentProject.id, accountId } })
          revokedDepartmentKeyCount = await db.employeeApiKey.updateMany({ where: {
            organizationId: actor.organizationId, projectId: departmentProject.id, accountId, deletedAt: null
          }, data: { revokedAt: now } }).then(result => result.count)
        }
      }
      await this.audit(db, actor, id, 'member_remove', { accountId, revokedDepartmentKeyCount })
      return { accountId, revokedDepartmentKeyCount }
    })
  }

  async setHead(actor: AuthPrincipal, id: string, accountId: string) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.findFirst({ where: { id, organizationId: actor.organizationId } })
      if (!group) throw new NotFoundException('Organization unit not found')
      this.assertMutable(group)
      const member = await db.groupMember.findFirst({ where: {
        organizationId: actor.organizationId, groupId: id, accountId, removedAt: null
      } })
      if (!member) throw new NotFoundException('Organization member not found')
      await db.groupMember.updateMany({ where: { organizationId: actor.organizationId, groupId: id, removedAt: null },
        data: { role: 'MEMBER' } })
      await db.groupMember.update({ where: { groupId_accountId: { groupId: id, accountId } }, data: { role: 'LEADER' } })
      await this.audit(db, actor, id, 'set_head', { accountId })
      return { accountId, role: 'LEADER' as const }
    })
  }

  async members(organizationId: string, id: string, query = new PageQueryDto()) {
    await this.detail(organizationId, id)
    const where = { organizationId, groupId: id, removedAt: null }
    const [items, total, organizationProjects, organizationKeys, usageRows] = await Promise.all([
      this.prisma.groupMember.findMany({ where, skip: query.offset, take: query.limit, orderBy: { accountId: 'asc' },
        include: { membership: { select: { status: true, role: true,
          account: { select: { id: true, displayName: true, email: true, status: true } } } } } }),
      this.prisma.groupMember.count({ where }),
      this.prisma.project.findMany({ where: { organizationId, regionId: id, status: 'ACTIVE' }, select: { id: true } }),
      this.prisma.employeeApiKey.groupBy({ by: ['accountId'], where: {
        organizationId, groupId: id, deletedAt: null, revokedAt: null, disabledAt: null
      }, _count: { _all: true } }),
      this.prisma.usageLog.groupBy({ by: ['accountId'], where: {
        organizationId, groupId: id, startedAt: { gte: new Date(Date.now() - 30 * 86_400_000) }
      }, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true }, _max: { startedAt: true } })
    ])
    const accountIds = items.map(item => item.accountId)
    const projectMemberRows = accountIds.length ? await this.prisma.projectMember.findMany({ where: {
      organizationId, accountId: { in: accountIds }, project: { regionId: id, status: 'ACTIVE' }
    }, select: { accountId: true, projectId: true } }) : []
    const totalCost = usageRows.reduce((sum, row) => sum.plus(row._sum.costUsd ?? 0), new Decimal(0))
    const budgets = await readProjectBudgets(this.prisma, organizationId, organizationProjects.map(project => project.id))
    const budgetLimit = organizationProjects.reduce((sum, project) => sum.plus(budgets.get(project.id)?.limitCny || 0), new Decimal(0))
    const budgetOccupied = organizationProjects.reduce((sum, project) => sum.plus(
      new Decimal(budgets.get(project.id)?.spentCny || 0).plus(budgets.get(project.id)?.reservedCny || 0)
    ), new Decimal(0))
    return { items: items.map(item => {
      const usage = usageRows.find(row => row.accountId === item.accountId)
      const cost = new Decimal(usage?._sum.costUsd ?? 0)
      const activeProjectIds = new Set(projectMemberRows.filter(row => row.accountId === item.accountId).map(row => row.projectId))
      const activeKeyCount = organizationKeys.find(row => row.accountId === item.accountId)?._count._all ?? 0
      return { ...item, activeProjectCount: activeProjectIds.size, activeKeyCount,
        usage: {
          requests: usage?._count._all ?? 0,
          totalTokens: ((usage?._sum.inputTokens ?? 0n) + (usage?._sum.outputTokens ?? 0n)).toString(),
          costCny: cost.toFixed(8),
          lastUsedAt: usage?._max.startedAt ?? null,
          usageSharePercent: totalCost.greaterThan(0) ? Number(cost.dividedBy(totalCost).times(100).toFixed(2)) : 0,
          budgetSharePercent: budgetOccupied.greaterThan(0) ? Number(cost.dividedBy(budgetOccupied).times(100).toFixed(2)) : 0
        },
        budget: {
          totalLimitCny: budgetLimit.toFixed(8),
          occupiedCny: budgetOccupied.toFixed(8),
          availableCny: budgetLimit.minus(budgetOccupied).toFixed(8),
          usagePercent: budgetLimit.greaterThan(0) ? Number(budgetOccupied.dividedBy(budgetLimit).times(100).toFixed(2)) : null
        }
      }
    }), total, limit: query.limit, offset: query.offset }
  }

  async projects(organizationId: string, id: string) {
    await this.detail(organizationId, id)
    return this.prisma.project.findMany({ where: { organizationId, regionId: id }, orderBy: [{ category: 'asc' }, { name: 'asc' }] })
  }

  async modelAccess(organizationId: string, id: string) {
    await this.detail(organizationId, id)
    return this.prisma.groupModelAccess.findMany({ where: { organizationId, groupId: id }, orderBy: { publicModelId: 'asc' },
      include: { publicModel: { select: { id: true, displayName: true, enabled: true, deletedAt: true } } } })
  }

  async replaceModels(actor: AuthPrincipal, id: string, publicModelIds: string[]) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.findFirst({ where: { id, organizationId: actor.organizationId } })
      if (!group) throw new NotFoundException('Organization unit not found')
      this.assertMutable(group)
      await db.groupModelAccess.deleteMany({ where: { organizationId: actor.organizationId, groupId: id } })
      if (publicModelIds.length) {
        const models = await db.publicModel.findMany({ where: { id: { in: publicModelIds }, deletedAt: null }, select: { id: true } })
        if (models.length !== new Set(publicModelIds).size) throw new NotFoundException('One or more models not found')
        await db.groupModelAccess.createMany({ data: models.map(model => ({
          organizationId: actor.organizationId, groupId: id, publicModelId: model.id
        })) })
      }
      await this.audit(db, actor, id, 'replace_models', { count: publicModelIds.length })
      return this.modelAccess(actor.organizationId, id)
    })
  }
}
