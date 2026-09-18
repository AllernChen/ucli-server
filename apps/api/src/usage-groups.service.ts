import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, type UsageGroup } from '@prisma/client'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AuthPrincipal } from '../../../packages/security/src/auth.js'
import { lockUsageGroup } from '../../../packages/security/src/group-access.js'
import { canAccessModel } from '../../../packages/gateway-core/src/access-policy.js'
import { modelCapabilitiesSelect } from '../../../packages/gateway-core/src/model-catalog.service.js'
import { configuredClientProtocols } from '../../../packages/gateway-core/src/model-capabilities.js'
import { readGroupBudgets } from '../../../packages/quota/src/group-budget-read.js'
import { cny } from '../../../packages/quota/src/group-budget.js'
import { PageQueryDto } from './catalog.dto.js'
import { UsageGroupPageQueryDto, type CreateUsageGroupDto, type UpdateUsageGroupDto } from './usage-groups.dto.js'

const retryRevocation = Symbol('retryRevocation')

@Injectable()
export class UsageGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(actor: AuthPrincipal) {
    if (!['PLATFORM_ADMIN', 'ORG_ADMIN'].includes(actor.role)) throw new ForbiddenException('Administrator required')
  }

  private audit(db: Prisma.TransactionClient, actor: AuthPrincipal, id: string, action: string, metadata: Prisma.InputJsonObject = {}) {
    return db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
      action: `usage_group.${action}`, resourceType: 'usage_group', resourceId: id, metadata } })
  }

  private async mutate<T>(actor: AuthPrincipal, id: string, action: string,
    change: (db: Prisma.TransactionClient, group: UsageGroup) => Promise<T>, metadata: Prisma.InputJsonObject = {}) {
    this.assertAdmin(actor)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(async db => {
          const group = await lockUsageGroup(db, actor.organizationId, id)
          if (group.archivedAt) throw new ConflictException('Archived groups cannot be modified')
          const result = await change(db, group)
          await this.audit(db, actor, id, action, metadata)
          return result
        }, { timeout: 15_000 })
      } catch (error) {
        const conflict = error === retryRevocation || (error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || (error.code === 'P2010' && error.meta?.code === '40P01')))
        if (!conflict) throw error
      }
    }
    throw new ConflictException('Concurrent credential change; retry the operation')
  }

  async create(actor: AuthPrincipal, input: CreateUsageGroupDto) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.create({ data: { organizationId: actor.organizationId,
        name: input.name, type: input.type, description: input.description,
        budgetMode: input.type === 'DEPARTMENT' ? 'MONTHLY' : 'TOTAL' } })
      await this.audit(db, actor, group.id, 'create', { name: input.name, type: input.type })
      return group
    })
  }

  async list(organizationId: string, query = new UsageGroupPageQueryDto()) {
    const now = new Date()
    const risk = query.budgetRisk ? await this.riskPage(organizationId, query, now) : null
    const where: Prisma.UsageGroupWhereInput = { organizationId, type: query.type,
      ...(risk ? { id: { in: risk.ids } } : {}),
      ...(query.status === 'archived' ? { archivedAt: { not: null } } : query.status === 'all' ? {} :
        { archivedAt: null, enabled: query.status === 'active' }),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}) }
    const [items, total] = await Promise.all([
      this.prisma.usageGroup.findMany({ where, skip: risk ? 0 : query.offset, take: query.limit, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: { _count: { select: { members: { where: { removedAt: null } }, models: true } } } }),
      risk ? Promise.resolve(risk.total) : this.prisma.usageGroup.count({ where })
    ])
    if (risk) {
      const order = new Map(risk.ids.map((id, index) => [id, index]))
      items.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    }
    const groupId = { in: items.map(group => group.id) }
    const [budgets, members, keys] = await Promise.all([
      readGroupBudgets(this.prisma, organizationId, groupId.in, now),
      this.prisma.groupMember.groupBy({ by: ['groupId'], where: { organizationId, groupId, removedAt: null,
        group: { enabled: true, archivedAt: null, organization: { enabled: true } },
        membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } } }, _count: true }),
      this.prisma.employeeApiKey.groupBy({ by: ['groupId'], where: { organizationId, groupId, revokedAt: null, disabledAt: null, deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, _count: true })
    ])
    const memberCounts = new Map(members.map(row => [row.groupId, row._count]))
    const keyCounts = new Map(keys.map(row => [row.groupId, row._count]))
    return { items: items.map(group => ({ ...group, budget: budgets.get(group.id)!, activeMembers: memberCounts.get(group.id) ?? 0,
      activeKeys: keyCounts.get(group.id) ?? 0 })), total, limit: query.limit, offset: query.offset }
  }

  private async riskPage(organizationId: string, query: UsageGroupPageQueryDto, now: Date) {
    const status = query.status === 'archived' ? Prisma.sql`g.archived_at IS NOT NULL` : query.status === 'all' ? Prisma.sql`TRUE` :
      Prisma.sql`g.archived_at IS NULL AND g.enabled = ${query.status === 'active'}`
    // Interval offsets use Intl's ISO sign; PostgreSQL text offsets use the opposite POSIX sign.
    const month = Prisma.sql`to_char(CASE WHEN g.budget_timezone ~ '^[+-][0-9]{2}(:?[0-9]{2})?$'
      THEN ${now}::timestamptz AT TIME ZONE
        (substring(g.budget_timezone, 1, 3) || ':' || CASE WHEN length(g.budget_timezone) = 3 THEN '00' ELSE right(g.budget_timezone, 2) END)::interval
      ELSE ${now}::timestamptz AT TIME ZONE g.budget_timezone END, 'YYYY-MM')`
    const budgets = Prisma.sql`WITH budgets AS (
      SELECT g.id, g.name, COALESCE(p.unlimited, g.unlimited) AS unlimited,
        COALESCE(p.limit_cny, g.default_limit_cny) AS limit_cny,
        COALESCE(p.spent_cny, 0) + COALESCE(p.reserved_cny, 0) AS occupied,
        COALESCE((SELECT SUM(e.reserved_cny) FROM group_budget_entries e
          WHERE e.organization_id = g.organization_id AND e.group_id = g.id AND e.period_id = p.id
            AND e.kind = 'REQUEST' AND e.status = 'RECONCILIATION_REQUIRED'), 0) AS uncertain
      FROM usage_groups g LEFT JOIN group_budget_periods p ON p.organization_id = g.organization_id AND p.group_id = g.id
        AND p.period_key = CASE WHEN g.budget_mode = 'TOTAL' THEN 'TOTAL' ELSE ${month} END
      WHERE g.organization_id = ${organizationId}::uuid AND ${status}
        ${query.type ? Prisma.sql`AND g.type = ${query.type}::"UsageGroupType"` : Prisma.empty}
        ${query.q ? Prisma.sql`AND g.name ILIKE ${`%${query.q}%`}` : Prisma.empty}
    ), risks AS (
      SELECT id, name, NOT unlimited AND (limit_cny <= 0 OR occupied >= limit_cny) AS exhausted,
        uncertain > 0 AS unsettled,
        NOT unlimited AND limit_cny > 0 AND occupied >= limit_cny * 0.8 AND occupied < limit_cny AS near_limit
      FROM budgets
    )`
    const filter = query.budgetRisk === 'EXHAUSTED' ? Prisma.sql`exhausted` : query.budgetRisk === 'UNSETTLED' ? Prisma.sql`unsettled` :
      query.budgetRisk === 'NEAR_LIMIT' ? Prisma.sql`near_limit` : Prisma.sql`(exhausted OR unsettled OR near_limit)`
    const [rows, counts] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`${budgets} SELECT id FROM risks WHERE ${filter}
        ORDER BY CASE WHEN exhausted THEN 0 WHEN unsettled THEN 1 ELSE 2 END, name, id LIMIT ${query.limit} OFFSET ${query.offset}`),
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`${budgets} SELECT COUNT(*) AS total FROM risks WHERE ${filter}`)
    ])
    return { ids: rows.map(row => row.id), total: Number(counts[0].total) }
  }

  async detail(organizationId: string, id: string) {
    const group = await this.prisma.usageGroup.findFirst({ where: { id, organizationId } })
    if (!group) throw new NotFoundException('Usage group not found')
    return group
  }

  update(actor: AuthPrincipal, id: string, input: UpdateUsageGroupDto) {
    return this.mutate(actor, id, 'update', db => db.usageGroup.update({ where: { id },
      data: { name: input.name, description: input.description } }), { ...input })
  }

  setEnabled(actor: AuthPrincipal, id: string, enabled: boolean) {
    return this.mutate(actor, id, enabled ? 'enable' : 'disable', db => db.usageGroup.update({ where: { id }, data: { enabled } }))
  }

  archive(actor: AuthPrincipal, id: string) {
    return this.mutate(actor, id, 'archive', async db => {
      const now = new Date()
      await this.revokeCredentials(db, actor.organizationId, id, now)
      return db.usageGroup.update({ where: { id }, data: { enabled: false, archivedAt: now } })
    })
  }

  async members(organizationId: string, id: string, query = new PageQueryDto()) {
    await this.detail(organizationId, id)
    const where = { organizationId, groupId: id, removedAt: null }
    const [items, total] = await Promise.all([
      this.prisma.groupMember.findMany({ where, skip: query.offset, take: query.limit, orderBy: { accountId: 'asc' },
        include: { membership: { select: { status: true, role: true,
          account: { select: { id: true, displayName: true, email: true, status: true } } } } } }),
      this.prisma.groupMember.count({ where })
    ])
    return { items, total, limit: query.limit, offset: query.offset }
  }

  addMember(actor: AuthPrincipal, id: string, accountId: string) {
    return this.mutate(actor, id, 'add_member', async db => {
      const member = await db.membership.findFirst({ where: { organizationId: actor.organizationId, accountId,
        status: 'ACTIVE', account: { status: 'ACTIVE' } } })
      if (!member) throw new ForbiddenException('Active organization member required')
      return db.groupMember.upsert({ where: { groupId_accountId: { groupId: id, accountId } },
        create: { organizationId: actor.organizationId, groupId: id, accountId }, update: { removedAt: null, joinedAt: new Date() } })
    }, { accountId })
  }

  removeMember(actor: AuthPrincipal, id: string, accountId: string) {
    return this.mutate(actor, id, 'remove_member', async db => {
      const now = new Date()
      const result = await db.groupMember.updateMany({ where: { organizationId: actor.organizationId, groupId: id, accountId, removedAt: null },
        data: { removedAt: now } })
      if (!result.count) throw new NotFoundException('Group member not found')
      await this.revokeCredentials(db, actor.organizationId, id, now, accountId)
      return { accountId, removedAt: now }
    }, { accountId })
  }

  setLeader(actor: AuthPrincipal, id: string, accountId: string, leader: boolean) {
    return this.mutate(actor, id, leader ? 'set_leader' : 'unset_leader', async db => {
      const result = await db.groupMember.updateMany({ where: { organizationId: actor.organizationId, groupId: id, accountId, removedAt: null },
        data: { role: leader ? 'LEADER' : 'MEMBER' } })
      if (!result.count) throw new NotFoundException('Group member not found')
      return { accountId, role: leader ? 'LEADER' as const : 'MEMBER' as const }
    }, { accountId, leader })
  }

  async applications(organizationId: string, id: string, query = new PageQueryDto()) {
    await this.detail(organizationId, id)
    const where = { organizationId, groupId: id }
    const [items, total] = await Promise.all([
      this.prisma.groupBudgetApplication.findMany({ where, skip: query.offset, take: query.limit, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: { applicant: { select: { account: { select: { displayName: true } } } } } }),
      this.prisma.groupBudgetApplication.count({ where })
    ])
    return { items, total, limit: query.limit, offset: query.offset }
  }

  createApplication(actor: AuthPrincipal, id: string, input: { requestedCny: string; reason: string; applicantAccountId?: string }) {
    return this.mutate(actor, id, 'application_register', async db => {
      const amount = cny(input.requestedCny)
      if (new Decimal(amount).lte(0)) throw new BadRequestException('Requested amount must be greater than zero')
      const applicantAccountId = input.applicantAccountId || actor.sub
      const applicant = await db.membership.findFirst({ where: { organizationId: actor.organizationId, accountId: applicantAccountId, status: 'ACTIVE' } })
      if (!applicant) throw new ForbiddenException('Active organization member required')
      return db.groupBudgetApplication.create({ data: { organizationId: actor.organizationId, groupId: id,
        applicantAccountId, requestedCny: amount, reason: input.reason } })
    }, { requestedCny: input.requestedCny, reason: input.reason })
  }

  rejectApplication(actor: AuthPrincipal, id: string, applicationId: string, note?: string) {
    return this.mutate(actor, id, 'application_reject', async db => {
      const result = await db.groupBudgetApplication.updateMany({ where: { organizationId: actor.organizationId, groupId: id, id: applicationId, status: 'REGISTERED' },
        data: { status: 'REJECTED', decidedById: actor.sub, decidedAt: new Date(), ...(note ? { decisionNote: note } : {}) } })
      if (!result.count) {
        const application = await db.groupBudgetApplication.findFirst({ where: { organizationId: actor.organizationId, groupId: id, id: applicationId } })
        if (!application) throw new NotFoundException('Budget application not found')
        throw new ConflictException('Budget application already decided')
      }
      return { id: applicationId, status: 'REJECTED' as const }
    }, { applicationId })
  }

  async models(organizationId: string, id: string) {
    await this.detail(organizationId, id)
    return this.prisma.groupModelAccess.findMany({ where: { organizationId, groupId: id }, orderBy: { publicModelId: 'asc' },
      include: { publicModel: { select: { id: true, displayName: true, enabled: true, deletedAt: true } } } })
  }

  async modelOptions(organizationId: string, id: string, accountId?: string) {
    const group = await this.detail(organizationId, id)
    const member = accountId ? await this.prisma.groupMember.findFirst({ where: { organizationId, groupId: id, accountId, removedAt: null },
      include: { membership: { include: { account: { select: { status: true } } } } } }) : null
    if (accountId && !member) throw new ForbiddenException('Group member required')
    const selected = new Set((await this.models(organizationId, id)).map(m => m.publicModelId))
    const models = await this.prisma.publicModel.findMany({ where: { OR: [{ deletedAt: null }, { id: { in: [...selected] } }] },
      include: { policies: true, channelModels: { select: modelCapabilitiesSelect } }, orderBy: { id: 'asc' } })
    return models.map(model => {
      const protocols = configuredClientProtocols(model.channelModels)
      const reasons: string[] = []
      if (!group.enabled || group.archivedAt) reasons.push('用量组已停用或归档')
      if (!model.enabled || model.deletedAt || !model.contextSize) reasons.push('模型未发布或上下文未配置')
      if (!protocols.length) reasons.push('没有已配置的可用协议')
      if (member) {
        if (member.membership.status !== 'ACTIVE' || member.membership.account.status !== 'ACTIVE') reasons.push('员工已停用')
        if (!canAccessModel(model.policies, { organizationId, accountId: member.accountId, role: member.membership.role })) reasons.push('现有模型策略不允许该员工使用')
        if (!selected.has(model.id)) reasons.push('组未允许此模型')
      }
      return { id: model.id, displayName: model.displayName, protocols, selected: selected.has(model.id),
        archived: Boolean(model.deletedAt), allowed: member ? reasons.length === 0 : null, reasons }
    })
  }

  replaceModels(actor: AuthPrincipal, id: string, publicModelIds: string[]) {
    return this.mutate(actor, id, 'replace_models', async db => {
      const ids = [...new Set(publicModelIds)]
      const count = await db.publicModel.count({ where: { id: { in: ids }, deletedAt: null } })
      if (count !== ids.length) throw new BadRequestException('Unknown or archived model')
      await db.groupModelAccess.deleteMany({ where: { organizationId: actor.organizationId, groupId: id } })
      await db.groupModelAccess.createMany({ data: ids.map(publicModelId => ({ organizationId: actor.organizationId, groupId: id, publicModelId })) })
      return { publicModelIds: ids }
    }, { publicModelIds })
  }

  private async revokeCredentials(db: Prisma.TransactionClient, organizationId: string, groupId: string, now: Date, accountId?: string) {
    await db.employeeApiKey.updateMany({ where: { organizationId, groupId, accountId, revokedAt: null }, data: { revokedAt: now } })
    const grants = await db.deviceGrant.findMany({ where: { organizationId, groupId, accountId, deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true } })
    for (const { id } of grants) {
      // Same link-before-grant lock order as redemption/regeneration, including consumed retry links.
      const links = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM device_grant_links WHERE device_grant_id = ${id}::uuid ORDER BY issuance_order DESC FOR UPDATE
      `)
      await db.$queryRaw(Prisma.sql`SELECT id FROM device_grants WHERE id = ${id}::uuid FOR UPDATE`)
      const current = await db.deviceGrantLink.findMany({ where: { deviceGrantId: id }, select: { id: true } })
      if (current.some(link => !links.some(locked => locked.id === link.id))) throw retryRevocation
      const grant = await db.deviceGrant.findUniqueOrThrow({ where: { id }, select: { deviceId: true } })
      await db.deviceGrantLink.updateMany({ where: { deviceGrantId: id, revokedAt: null }, data: { revokedAt: now, secretEncrypted: Prisma.DbNull } })
      await db.deviceGrant.update({ where: { id }, data: { deletedAt: now } })
      if (grant.deviceId) await db.device.update({ where: { id: grant.deviceId }, data: { revokedAt: now } })
    }
  }
}
