import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { readGroupBudgets } from '../../../packages/quota/src/group-budget-read.js'
import { cny } from '../../../packages/quota/src/group-budget.js'
import { usageWhere } from './usage-query.js'
import type { UsageReadFilter } from '../../../packages/usage/src/analytics-types.js'
import type { AuthPrincipal } from '../../../packages/security/src/auth.js'

const DAY = 86_400_000
const LED_USAGE_LIMIT = 100

function integer(value: unknown): number {
  return Number(value ?? 0)
}

function money(value: unknown): string {
  return new Prisma.Decimal(value?.toString() || 0).toFixed(8)
}

@Injectable()
export class LedGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  private webActor(actor: AuthPrincipal) {
    if (actor.deviceId) throw new ForbiddenException('Web login required')
    return actor
  }

  private ledWhere(actor: AuthPrincipal, groupId?: string) {
    return { organizationId: actor.organizationId, accountId: actor.sub, removedAt: null, role: 'LEADER' as const, ...(groupId ? { groupId } : {}) }
  }

  private async requireLedGroup(actor: AuthPrincipal, groupId: string) {
    const member = await this.prisma.groupMember.findFirst({ where: this.ledWhere(actor, groupId), select: { groupId: true } })
    if (!member) throw new ForbiddenException('Group leader required')
    return member
  }

  async list(actor: AuthPrincipal) {
    this.webActor(actor)
    const now = new Date()
    const memberships = await this.prisma.groupMember.findMany({
      where: this.ledWhere(actor),
      select: { joinedAt: true, group: { select: { id: true, name: true, type: true, description: true, enabled: true, archivedAt: true } } },
      orderBy: { group: { name: 'asc' } } })
    const budgets = await readGroupBudgets(this.prisma, actor.organizationId, memberships.map(item => item.group.id), now)
    return memberships.map(({ joinedAt, group }) => ({
      id: group.id, name: group.name, type: group.type, description: group.description,
      enabled: group.enabled, archivedAt: group.archivedAt, joinedAt, budget: budgets.get(group.id) ?? null
    }))
  }

  async budget(actor: AuthPrincipal, groupId: string) {
    this.webActor(actor)
    await this.requireLedGroup(actor, groupId)
    const summary = (await readGroupBudgets(this.prisma, actor.organizationId, [groupId])).get(groupId)
    if (!summary) throw new ForbiddenException('Group leader required')
    return summary
  }

  async applications(actor: AuthPrincipal, groupId: string, query: { offset?: number; limit?: number }) {
    this.webActor(actor)
    await this.requireLedGroup(actor, groupId)
    const limit = Math.min(LED_USAGE_LIMIT, Math.max(1, Number(query.limit) || 20))
    const offset = Math.max(0, Number(query.offset) || 0)
    const where = { organizationId: actor.organizationId, groupId }
    const [items, total] = await Promise.all([
      this.prisma.groupBudgetApplication.findMany({ where, skip: offset, take: limit, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: { applicant: { select: { account: { select: { displayName: true } } } } } }),
      this.prisma.groupBudgetApplication.count({ where })
    ])
    return { items, total, limit, offset }
  }

  async submitApplication(actor: AuthPrincipal, groupId: string, input: { requestedCny: string; reason: string }) {
    this.webActor(actor)
    await this.requireLedGroup(actor, groupId)
    const amount = cny(input.requestedCny)
    if (new Decimal(amount).lte(0)) throw new BadRequestException('Requested amount must be greater than zero')
    const group = await this.prisma.usageGroup.findFirst({ where: { id: groupId, organizationId: actor.organizationId }, select: { archivedAt: true } })
    if (!group || group.archivedAt) throw new BadRequestException('Archived groups cannot receive applications')
    const application = await this.prisma.groupBudgetApplication.create({ data: {
      organizationId: actor.organizationId, groupId, applicantAccountId: actor.sub, requestedCny: amount, reason: input.reason } })
    await this.prisma.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
      action: 'usage_group.application_submit', resourceType: 'usage_group', resourceId: groupId,
      metadata: { applicationId: application.id, requestedCny: amount } } })
    return application
  }

  private resolveRange(start?: string, end?: string) {
    const now = new Date()
    const rangeEnd = end ? new Date(end) : now
    const rangeStart = start ? new Date(start) : new Date(rangeEnd.getTime() - 7 * DAY)
    if (!Number.isFinite(rangeStart.getTime()) || !Number.isFinite(rangeEnd.getTime()) || rangeStart >= rangeEnd) {
      throw new BadRequestException('Invalid usage time range')
    }
    if (rangeEnd.getTime() - rangeStart.getTime() > 90 * DAY) throw new BadRequestException('Usage range cannot exceed 90 days')
    return { start: rangeStart, end: rangeEnd }
  }

  async usage(actor: AuthPrincipal, groupId: string, query: { start?: string; end?: string; offset?: number; limit?: number }) {
    this.webActor(actor)
    await this.requireLedGroup(actor, groupId)
    const { start, end } = this.resolveRange(query.start, query.end)
    const where = usageWhere({ start, end, timezone: 'UTC', organizationId: actor.organizationId, groupId } as UsageReadFilter)
    const metrics = Prisma.sql`COUNT(*)::bigint AS requests,
      COUNT(*) FILTER (WHERE u.status_code < 400)::bigint AS successes,
      COALESCE(SUM(u.input_tokens), 0)::bigint AS input_tokens,
      COALESCE(SUM(u.output_tokens), 0)::bigint AS output_tokens,
      COALESCE(SUM(u.cost_usd), 0)::numeric AS cost_cny,
      COALESCE(AVG(u.duration_ms), 0)::int AS avg_duration_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY u.duration_ms), 0)::int AS p95_duration_ms`
    const limit = Math.min(LED_USAGE_LIMIT, Math.max(1, Number(query.limit) || 20))
    const offset = Math.max(0, Number(query.offset) || 0)
    const [overviewRows, byAccount, byModel, detail, totalRows] = await Promise.all([
      this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT ${metrics} FROM usage_logs u WHERE ${where}`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT u.account_id AS id, a.display_name AS name, ${metrics}
        FROM usage_logs u JOIN accounts a ON a.id = u.account_id
        WHERE ${where} GROUP BY u.account_id, a.display_name ORDER BY cost_cny DESC, u.account_id ASC`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT u.public_model_id AS id, pm.display_name AS name, ${metrics}
        FROM usage_logs u JOIN public_models pm ON pm.id = u.public_model_id
        WHERE ${where} GROUP BY u.public_model_id, pm.display_name ORDER BY cost_cny DESC, u.public_model_id ASC`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT u.id, u.started_at, u.account_id, a.display_name AS account_name, u.public_model_id, pm.display_name AS model_name,
          u.protocol, u.input_tokens, u.output_tokens, u.cost_usd AS cost_cny, u.status_code, u.duration_ms
        FROM usage_logs u JOIN accounts a ON a.id = u.account_id JOIN public_models pm ON pm.id = u.public_model_id
        WHERE ${where} ORDER BY u.started_at DESC, u.id ASC LIMIT ${limit} OFFSET ${offset}`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT COUNT(*)::bigint AS total FROM usage_logs u WHERE ${where}`)
    ])
    const row = (item: any) => ({
      requests: integer(item.requests), successes: integer(item.successes),
      inputTokens: integer(item.input_tokens), outputTokens: integer(item.output_tokens),
      costCny: money(item.cost_cny), avgDurationMs: integer(item.avg_duration_ms), p95DurationMs: integer(item.p95_duration_ms)
    })
    return {
      range: { start: start.toISOString(), end: end.toISOString() },
      overview: row(overviewRows[0] || {}),
      byAccount: byAccount.map(item => ({ id: item.id, name: item.name, ...row(item) })),
      byModel: byModel.map(item => ({ id: item.id, name: item.name, ...row(item) })),
      items: detail.map(item => ({ id: item.id, startedAt: item.started_at, accountId: item.account_id, accountName: item.account_name,
        publicModelId: item.public_model_id, modelName: item.model_name, protocol: item.protocol,
        inputTokens: integer(item.input_tokens), outputTokens: integer(item.output_tokens),
        costCny: money(item.cost_cny), statusCode: item.status_code, durationMs: item.duration_ms })),
      total: integer(totalRows[0]?.total), limit, offset
    }
  }
}
