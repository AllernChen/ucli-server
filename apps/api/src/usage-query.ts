import { BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { AnalyticsPrincipal, UsageReadFilter } from '../../../packages/usage/src/analytics-types.js'
import type { AnalyticsQueryDto, UsageQueryDto } from './analytics.dto.js'

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
  if (mode === 'analytics' && query.interval === 'hour' && end.getTime() - start.getTime() > 31 * DAY) throw new BadRequestException('Hourly analytics range cannot exceed 31 days')
  if (query.groupId && query.groupScope) throw new BadRequestException('groupId and groupScope cannot be combined')
  if (query.apiKeyId && query.keyScope) throw new BadRequestException('apiKeyId and keyScope cannot be combined')
  if (query.channelId && query.allocation) throw new BadRequestException('channelId and allocation cannot be combined')
  if (query.channelModelId && query.channelModelScope) throw new BadRequestException('channelModelId and channelModelScope cannot be combined')
  if (query.publicModelId && query.model && query.publicModelId !== query.model) throw new BadRequestException('model and publicModelId must match')
  return {
    start, end, timezone: query.timezone || 'UTC',
    organizationId: principal.role === 'PLATFORM_ADMIN' ? query.organizationId || undefined : principal.organizationId,
    accountId: principal.role === 'MEMBER' ? principal.sub : query.accountId || undefined,
    groupId: query.groupId || undefined, groupScope: query.groupScope,
    apiKeyId: query.apiKeyId || undefined, keyScope: query.keyScope, credentialType: query.credentialType,
    channelId: query.channelId || undefined, publicModelId: query.publicModelId || query.model || undefined,
    channelModelId: query.channelModelId || undefined, channelModelScope: query.channelModelScope, requestState: query.requestState, billingState: query.billingState,
    costRuleId: query.costRuleId, priceKey: query.priceKey, allocation: query.allocation,
    requestId: query.requestId, sessionId: query.sessionId, projectId: query.projectId
  }
}

export function usageWhere(filter: UsageReadFilter, requestOnly = false): Prisma.Sql {
  const conditions = [Prisma.sql`u.started_at >= (${filter.start}::timestamptz AT TIME ZONE 'UTC')`, Prisma.sql`u.started_at < (${filter.end}::timestamptz AT TIME ZONE 'UTC')`]
  if (filter.organizationId) conditions.push(Prisma.sql`u.organization_id = ${filter.organizationId}::uuid`)
  if (filter.accountId) conditions.push(Prisma.sql`u.account_id = ${filter.accountId}::uuid`)
  if (filter.groupId) conditions.push(Prisma.sql`u.group_id = ${filter.groupId}::uuid`)
  if (filter.groupScope) conditions.push(Prisma.sql`u.group_id IS NULL`)
  if (filter.apiKeyId) conditions.push(Prisma.sql`u.api_key_id = ${filter.apiKeyId}::uuid`)
  if (filter.keyScope) conditions.push(Prisma.sql`u.api_key_id IS NULL`)
  if (filter.credentialType) conditions.push(Prisma.sql`u.credential_type::text = ${filter.credentialType}`)
  if (filter.publicModelId) conditions.push(Prisma.sql`u.public_model_id = ${filter.publicModelId}`)
  if (!requestOnly && filter.channelModelId) conditions.push(Prisma.sql`u.channel_model_id = ${filter.channelModelId}::uuid`)
  if (!requestOnly && filter.costRuleId) conditions.push(Prisma.sql`u.channel_cost_rule_id = ${filter.costRuleId}::uuid`)
  if (filter.requestId) conditions.push(Prisma.sql`u.request_id = ${filter.requestId}`)
  if (filter.sessionId) conditions.push(Prisma.sql`u.session_id = ${filter.sessionId}::uuid`)
  if (filter.projectId) conditions.push(Prisma.sql`u.project_id = ${filter.projectId}::uuid`)
  if (filter.requestState) conditions.push(Prisma.sql`${requestStateSql} = ${filter.requestState}`)
  if (!requestOnly && filter.billingState) conditions.push(Prisma.sql`COALESCE(u.cost_snapshot->>'billingState', CASE WHEN u.usage_source::text = 'ESTIMATED' THEN 'ESTIMATED' ELSE 'CONFIRMED' END) = ${filter.billingState}`)
  return Prisma.join(conditions, ' AND ')
}

export function allocationWhere(filter: UsageReadFilter, alias = 'a'): Prisma.Sql {
  const field = (name: string) => Prisma.raw(`${alias}.${name}`)
  const conditions: Prisma.Sql[] = []
  if (filter.channelId) conditions.push(Prisma.sql`${field('channel_id')} = ${filter.channelId}::uuid`)
  if (filter.channelModelId) conditions.push(Prisma.sql`${field('channel_model_id')} = ${filter.channelModelId}::uuid`)
  if (filter.channelModelScope) conditions.push(Prisma.sql`${field('channel_model_id')} IS NULL`)
  if (filter.costRuleId) conditions.push(Prisma.sql`${field('cost_rule_id')} = ${filter.costRuleId}::uuid`)
  if (filter.priceKey) conditions.push(Prisma.sql`${field('price_key')} = ${filter.priceKey}`)
  if (filter.billingState && hasAllocationFilter(filter)) conditions.push(Prisma.sql`${field('billing_state')} = ${filter.billingState}`)
  if (filter.allocation) conditions.push(Prisma.sql`${field('allocation_kind')} = 'UNALLOCATED'`)
  return conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`true`
}

export function hasAllocationFilter(filter: UsageReadFilter): boolean {
  return Boolean(filter.channelId || filter.channelModelId || filter.channelModelScope || filter.costRuleId || filter.priceKey || filter.allocation)
}

// Shared by matched requests and per-dimension request rows; alias a is always an allocation.
export const allocationMetricsSql = Prisma.sql`
  SUM(a.cost_cny)::numeric AS matched_cost_cny,
  SUM(a.input_tokens)::numeric AS input_tokens,
  SUM(a.cached_tokens)::numeric AS cached_tokens,
  SUM(a.output_tokens)::numeric AS output_tokens,
  SUM(a.reasoning_tokens)::numeric AS reasoning_tokens,
  BOOL_OR(a.billing_state = 'UNKNOWN') AS unsettled,
  COALESCE(SUM(a.cost_cny) FILTER (WHERE a.billing_state = 'ESTIMATED' AND a.allocation_kind <> 'UNALLOCATED'), 0)::numeric AS estimated_cost_cny,
  COALESCE(SUM(a.cached_tokens) FILTER (WHERE a.usage_source = 'upstream' AND COALESCE(a.cached_tokens, 0) > 0), 0)::numeric AS known_cached_tokens,
  COALESCE(SUM(a.input_tokens) FILTER (WHERE a.usage_source = 'upstream' AND COALESCE(a.cached_tokens, 0) > 0), 0)::numeric AS known_input_tokens,
  COUNT(*) FILTER (WHERE a.allocation_kind <> 'UNALLOCATED'
    AND (a.usage_source IS DISTINCT FROM 'upstream' OR COALESCE(a.cached_tokens, 0) <= 0))::bigint AS unknown_cache_calls,
  BOOL_OR((a.input_tokens IS NULL OR a.output_tokens IS NULL OR a.cached_tokens IS NULL OR a.reasoning_tokens IS NULL)
    AND a.allocation_kind <> 'UNALLOCATED') AS token_usage_incomplete,
  COALESCE(SUM(a.cost_cny) FILTER (WHERE a.allocation_kind = 'UNALLOCATED'), 0)::numeric AS unallocated_cost_cny`

export function usageReadCte(filter: UsageReadFilter, _dimension?: AnalyticsQueryDto['dimension'], authorizedLogId?: string): Prisma.Sql {
  const routePrice = Prisma.sql`r.usage_snapshot->'cost'`
  const routeChannelModel = Prisma.sql`CASE WHEN ${routePrice}->>'channelModelId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${routePrice}->>'channelModelId')::uuid ELSE NULL END`
  const routeRule = Prisma.sql`CASE WHEN ${routePrice}->>'source' = 'CHANNEL_COST_RULE' AND ${routePrice}->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${routePrice}->>'id')::uuid ELSE NULL END`
  const priceKey = (snapshot: Prisma.Sql) => Prisma.sql`md5(jsonb_build_object(
    'id', ${snapshot}->>'id', 'source', ${snapshot}->>'source', 'inputPerMillion', ${snapshot}->>'inputPerMillion',
    'cachedPerMillion', ${snapshot}->>'cachedPerMillion', 'outputPerMillion', ${snapshot}->>'outputPerMillion',
    'reasoningPerMillion', ${snapshot}->>'reasoningPerMillion', 'timezone', ${snapshot}->>'timezone',
    'daysOfWeek', ${snapshot}->'daysOfWeek', 'startMinute', ${snapshot}->>'startMinute', 'endMinute', ${snapshot}->>'endMinute',
    'validFrom', ${snapshot}->>'validFrom', 'validTo', COALESCE(${snapshot}->>'validTo', ${snapshot}->>'validUntil')
  )::text)`
  const token = (field: string) => Prisma.sql`CASE WHEN r.usage_snapshot->>${field} ~ '^[0-9]+$' THEN (r.usage_snapshot->>${field})::numeric ELSE NULL END`
  const legacyPrice = Prisma.sql`u.cost_snapshot`
  const matching = allocationWhere(filter)
  const requestBilling = filter.billingState && !hasAllocationFilter(filter)
    ? Prisma.sql`AND COALESCE(u.cost_snapshot->>'billingState', CASE WHEN u.usage_source::text = 'ESTIMATED' THEN 'ESTIMATED' ELSE 'CONFIRMED' END) = ${filter.billingState}`
    : Prisma.empty
  return Prisma.sql`WITH scoped_usage AS (
      SELECT u.* FROM usage_logs u WHERE ${usageWhere(filter, true)} ${requestBilling}
        ${authorizedLogId ? Prisma.sql`AND u.id = ${authorizedLogId}::uuid` : Prisma.empty}
    ), allocations AS (
      SELECT u.id AS usage_log_id, r.channel_id, ${routeChannelModel} AS channel_model_id, ${routeRule} AS cost_rule_id,
        r.cost_cny::numeric AS cost_cny, ${token('inputTokens')} AS input_tokens, ${token('cachedTokens')} AS cached_tokens,
        ${token('outputTokens')} AS output_tokens, ${token('reasoningTokens')} AS reasoning_tokens,
        COALESCE(r.billing_state::text, CASE WHEN u.usage_source::text = 'ESTIMATED' THEN 'ESTIMATED' ELSE 'CONFIRMED' END) AS billing_state,
        ${routePrice} AS price_snapshot, ${priceKey(routePrice)} AS price_key, r.usage_snapshot->>'source' AS usage_source, 'ROUTE'::text AS allocation_kind
      FROM scoped_usage u JOIN route_attempts r ON r.usage_log_id = u.id
      WHERE r.billing_state IS NOT NULL OR r.cost_cny IS NOT NULL
      UNION ALL
      SELECT u.id, u.channel_id, u.channel_model_id, u.channel_cost_rule_id, u.cost_usd::numeric,
        u.input_tokens::numeric, u.cached_tokens::numeric, u.output_tokens::numeric, u.reasoning_tokens::numeric,
        COALESCE(u.cost_snapshot->>'billingState', CASE WHEN u.usage_source::text = 'ESTIMATED' THEN 'ESTIMATED' ELSE 'CONFIRMED' END),
        ${legacyPrice}, ${priceKey(legacyPrice)}, LOWER(u.usage_source::text), 'LEGACY'::text
      FROM scoped_usage u WHERE NOT EXISTS (SELECT 1 FROM route_attempts r WHERE r.usage_log_id = u.id AND (r.billing_state IS NOT NULL OR r.cost_cny IS NOT NULL))
      UNION ALL
      SELECT u.id, NULL::uuid, NULL::uuid, NULL::uuid,
        u.cost_usd::numeric - COALESCE((SELECT SUM(r.cost_cny) FROM route_attempts r WHERE r.usage_log_id = u.id AND (r.billing_state IS NOT NULL OR r.cost_cny IS NOT NULL)), 0),
        NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
        COALESCE(u.cost_snapshot->>'billingState', CASE WHEN u.usage_source::text = 'ESTIMATED' THEN 'ESTIMATED' ELSE 'CONFIRMED' END),
        NULL::jsonb, NULL::text, NULL::text, 'UNALLOCATED'::text
      FROM scoped_usage u WHERE EXISTS (SELECT 1 FROM route_attempts r WHERE r.usage_log_id = u.id AND (r.billing_state IS NOT NULL OR r.cost_cny IS NOT NULL))
        AND u.cost_usd::numeric <> COALESCE((SELECT SUM(r.cost_cny) FROM route_attempts r WHERE r.usage_log_id = u.id AND (r.billing_state IS NOT NULL OR r.cost_cny IS NOT NULL)), 0)
    ), matched_requests AS (
      SELECT a.usage_log_id, ${allocationMetricsSql}
      FROM allocations a WHERE ${matching} GROUP BY a.usage_log_id
    )`
}
