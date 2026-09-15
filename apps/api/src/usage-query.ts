import { BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { AnalyticsPrincipal, UsageReadFilter } from '../../../packages/usage/src/analytics-types.js'
import type { UsageQueryDto } from './analytics.dto.js'

const DAY = 86_400_000

export const requestStateSql = Prisma.sql`CASE
  WHEN u.client_cancelled THEN 'CANCELLED'
  WHEN u.stream_interrupted THEN 'INTERRUPTED'
  WHEN u.status_code NOT BETWEEN 200 AND 299 OR (u.error_code IS NOT NULL AND u.error_code <> 'RECONCILIATION_REQUIRED') THEN 'FAILED'
  ELSE 'SUCCESS' END`

export function resolveUsageFilter(
  principal: AnalyticsPrincipal, query: UsageQueryDto, now = new Date(), mode: 'analytics' | 'logs' = 'analytics'
): UsageReadFilter {
  const end = query.end ? new Date(query.end) : now
  const start = query.start ? new Date(query.start) : new Date(end.getTime() - 7 * DAY)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new BadRequestException('Invalid usage time range')
  if (mode === 'analytics' && end.getTime() - start.getTime() > 90 * DAY) throw new BadRequestException('Analytics range cannot exceed 90 days')
  if (query.interval === 'hour' && end.getTime() - start.getTime() > 31 * DAY) throw new BadRequestException('Hourly analytics range cannot exceed 31 days')
  if (query.groupId && query.groupScope) throw new BadRequestException('groupId and groupScope cannot be combined')
  if (query.apiKeyId && query.keyScope) throw new BadRequestException('apiKeyId and keyScope cannot be combined')
  if (query.channelId && query.allocation) throw new BadRequestException('channelId and allocation cannot be combined')
  if (query.publicModelId && query.model && query.publicModelId !== query.model) throw new BadRequestException('model and publicModelId must match')
  return {
    start, end, timezone: query.timezone || 'UTC',
    organizationId: principal.role === 'PLATFORM_ADMIN' ? query.organizationId || undefined : principal.organizationId,
    accountId: principal.role === 'MEMBER' ? principal.sub : query.accountId || undefined,
    groupId: query.groupId || undefined, groupScope: query.groupScope,
    apiKeyId: query.apiKeyId || undefined, keyScope: query.keyScope, credentialType: query.credentialType,
    channelId: query.channelId || undefined, publicModelId: query.publicModelId || query.model || undefined,
    channelModelId: query.channelModelId || undefined, requestState: query.requestState, billingState: query.billingState,
    costRuleId: query.costRuleId, priceKey: query.priceKey, allocation: query.allocation,
    requestId: query.requestId, sessionId: query.sessionId, projectId: query.projectId
  }
}

export function usageWhere(filter: UsageReadFilter): Prisma.Sql {
  const conditions = [Prisma.sql`u.started_at >= (${filter.start}::timestamptz AT TIME ZONE 'UTC')`, Prisma.sql`u.started_at < (${filter.end}::timestamptz AT TIME ZONE 'UTC')`]
  if (filter.organizationId) conditions.push(Prisma.sql`u.organization_id = ${filter.organizationId}::uuid`)
  if (filter.accountId) conditions.push(Prisma.sql`u.account_id = ${filter.accountId}::uuid`)
  if (filter.groupId) conditions.push(Prisma.sql`u.group_id = ${filter.groupId}::uuid`)
  if (filter.groupScope) conditions.push(Prisma.sql`u.group_id IS NULL`)
  if (filter.apiKeyId) conditions.push(Prisma.sql`u.api_key_id = ${filter.apiKeyId}::uuid`)
  if (filter.keyScope) conditions.push(Prisma.sql`u.api_key_id IS NULL`)
  if (filter.credentialType) conditions.push(Prisma.sql`u.credential_type::text = ${filter.credentialType}`)
  if (filter.publicModelId) conditions.push(Prisma.sql`u.public_model_id = ${filter.publicModelId}`)
  if (filter.channelModelId) conditions.push(Prisma.sql`u.channel_model_id = ${filter.channelModelId}::uuid`)
  if (filter.costRuleId) conditions.push(Prisma.sql`u.channel_cost_rule_id = ${filter.costRuleId}::uuid`)
  if (filter.requestId) conditions.push(Prisma.sql`u.request_id = ${filter.requestId}`)
  if (filter.sessionId) conditions.push(Prisma.sql`u.session_id = ${filter.sessionId}::uuid`)
  if (filter.projectId) conditions.push(Prisma.sql`u.project_id = ${filter.projectId}::uuid`)
  if (filter.requestState) conditions.push(Prisma.sql`${requestStateSql} = ${filter.requestState}`)
  if (filter.billingState) conditions.push(Prisma.sql`COALESCE(u.cost_snapshot->>'billingState', CASE WHEN u.usage_source::text = 'ESTIMATED' THEN 'ESTIMATED' ELSE 'CONFIRMED' END) = ${filter.billingState}`)
  return Prisma.join(conditions, ' AND ')
}
