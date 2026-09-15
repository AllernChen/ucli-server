import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AnalyticsOverview, AnalyticsPrincipal, UsageReadFilter } from '../../../packages/usage/src/analytics-types.js'
import type { AnalyticsQueryDto, UsageQueryDto } from './analytics.dto.js'
import { allocationMetricsSql, allocationWhere, hasAllocationFilter, requestStateSql, resolveUsageFilter, usageReadCte } from './usage-query.js'
import { safePrice } from './usage-detail.js'

const DAY = 86_400_000
const DIMENSIONS = {
  organization: { id: 'u.organization_id::text', name: 'COALESCE(o.name, u.organization_id::text)' },
  channel: { id: "CASE WHEN a.allocation_kind = 'UNALLOCATED' THEN NULL ELSE a.channel_id::text END", name: "CASE WHEN a.allocation_kind = 'UNALLOCATED' THEN '未分配到渠道的核算差额' ELSE COALESCE(c.name, a.channel_id::text) END" },
  model: { id: 'u.public_model_id', name: 'COALESCE(pm.display_name, u.public_model_id)' },
  channelModel: { id: 'a.channel_model_id::text', name: "COALESCE(cm.upstream_model, '未关联渠道模型')" },
  account: { id: 'u.account_id::text', name: "COALESCE(u.actor_snapshot->>'employeeName', u.account_id::text)" },
  group: { id: 'u.group_id::text', name: "COALESCE(u.actor_snapshot->>'groupName', u.group_id::text, '历史未归组')" },
  apiKey: { id: 'u.api_key_id::text', name: "COALESCE(u.actor_snapshot->>'keyName', u.api_key_id::text, '设备凭据')" },
  costRule: { id: 'a.price_key', name: "COALESCE(a.price_snapshot->>'ruleName', a.price_snapshot->>'source', '历史价格信息不足')" }
} as const
const SORTS = { requests: 'requests', costCny: 'matched_cost_cny', costUsd: 'matched_cost_cny', tokens: 'total_tokens', successRate: 'success_rate', requestSuccessRate: 'request_success_rate', p95LatencyMs: 'p95_latency_ms', name: 'name' } as const
const integer = (value: unknown) => Number(value || 0)
const nullableInteger = (value: unknown): number | null => value === null || value === undefined ? null : Math.round(Number(value))
const money = (value: unknown) => new Decimal(value?.toString() || 0).toFixed(8)
const numeric = (value: unknown) => String(value ?? 0)


function metricSource(allocationScope: boolean) {
  return allocationScope
    ? { cost: Prisma.sql`m.matched_cost_cny`, input: Prisma.sql`m.input_tokens`, output: Prisma.sql`m.output_tokens`,
        cached: Prisma.sql`m.cached_tokens`, reasoning: Prisma.sql`m.reasoning_tokens`, unsettled: Prisma.sql`m.unsettled` }
    : { cost: Prisma.sql`u.cost_usd`, input: Prisma.sql`u.input_tokens`, output: Prisma.sql`u.output_tokens`,
        cached: Prisma.sql`u.cached_tokens`, reasoning: Prisma.sql`u.reasoning_tokens`,
        unsettled: Prisma.sql`COALESCE(u.cost_snapshot->>'billingState', CASE WHEN u.usage_source::text = 'ESTIMATED' THEN 'ESTIMATED' ELSE 'CONFIRMED' END) = 'UNKNOWN'` }
}

type MetricSource = ReturnType<typeof metricSource>

// Every row entering this aggregate represents one request in its group.
function requestMetricsSql(source: MetricSource) {
  return Prisma.sql`
    COUNT(*)::bigint AS requests,
    COUNT(*) FILTER (WHERE u.status_code < 400 AND NOT ${source.unsettled})::bigint AS successes,
    COUNT(*) FILTER (WHERE ${requestStateSql} = 'SUCCESS')::bigint AS request_successes,
    COUNT(*) FILTER (WHERE ${requestStateSql} = 'FAILED')::bigint AS failed_requests,
    COUNT(*) FILTER (WHERE ${requestStateSql} = 'CANCELLED')::bigint AS cancelled_requests,
    COUNT(*) FILTER (WHERE ${requestStateSql} = 'INTERRUPTED')::bigint AS interrupted_requests,
    COUNT(*) FILTER (WHERE ${source.unsettled})::bigint AS unsettled_requests,
    COUNT(DISTINCT u.account_id)::bigint AS active_accounts,
    COALESCE(SUM(${source.input}), 0)::numeric AS input_tokens,
    COALESCE(SUM(${source.output}), 0)::numeric AS output_tokens,
    COALESCE(SUM(COALESCE(${source.input}, 0) + COALESCE(${source.output}, 0)), 0)::numeric AS total_tokens,
    COALESCE(SUM(${source.cached}), 0)::numeric AS cached_tokens,
    COALESCE(SUM(${source.reasoning}), 0)::numeric AS reasoning_tokens,
    COALESCE(SUM(GREATEST(COALESCE(${source.input}, 0) - COALESCE(${source.cached}, 0), 0)), 0)::numeric AS uncached_input_tokens,
    COALESCE(SUM(${source.cost}), 0)::numeric AS cost_usd,
    COALESCE(SUM(m.estimated_cost_cny), 0)::numeric AS estimated_cost_cny,
    COALESCE(SUM(m.unallocated_cost_cny), 0)::numeric AS unallocated_cost_cny,
    COALESCE(SUM(m.known_cached_tokens), 0)::numeric AS known_cached_tokens,
    COALESCE(SUM(m.known_input_tokens), 0)::numeric AS known_input_tokens,
    COALESCE(SUM(m.unknown_cache_calls), 0)::bigint AS unknown_cache_calls,
    COALESCE(BOOL_OR(m.token_usage_incomplete), false) AS token_usage_incomplete,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY u.duration_ms) AS p50_latency_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY u.duration_ms) AS p95_latency_ms,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY u.first_token_ms) FILTER (WHERE u.first_token_ms IS NOT NULL) AS p50_first_token_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY u.first_token_ms) FILTER (WHERE u.first_token_ms IS NOT NULL) AS p95_first_token_ms,
    COUNT(*) FILTER (WHERE u.switched)::bigint AS failovers`
}

function metrics(row: any, errorCounts: Array<{ errorCode: string; requests: number }>) {
  const requests = integer(row.requests)
  const knownInput = new Decimal(row.known_input_tokens?.toString() || 0)
  const knownCached = new Decimal(row.known_cached_tokens?.toString() || 0)
  return {
    requests, successRate: requests ? integer(row.successes) / requests : 0,
    requestSuccessRate: requests ? integer(row.request_successes) / requests : null,
    requestStates: { SUCCESS: integer(row.request_successes), FAILED: integer(row.failed_requests),
      CANCELLED: integer(row.cancelled_requests), INTERRUPTED: integer(row.interrupted_requests) },
    inputTokens: numeric(row.input_tokens), outputTokens: numeric(row.output_tokens),
    cachedTokens: numeric(row.cached_tokens), uncachedInputTokens: numeric(row.uncached_input_tokens),
    reasoningTokens: numeric(row.reasoning_tokens),
    cacheHitRate: knownInput.isZero() ? null : knownCached.div(knownInput).toNumber(),
    cacheCoverage: { knownInputTokens: knownInput.toString(), totalInputTokens: numeric(row.input_tokens), unknownCalls: integer(row.unknown_cache_calls) },
    estimatedCostCny: money(row.estimated_cost_cny), unallocatedCostCny: money(row.unallocated_cost_cny),
    tokenUsageIncomplete: Boolean(row.token_usage_incomplete), errorCounts,
    costUsd: money(row.cost_usd), currency: 'CNY' as const, costCny: money(row.cost_usd),
    unsettledRequests: integer(row.unsettled_requests)
  }
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  resolveFilter(principal: AnalyticsPrincipal, query: AnalyticsQueryDto, now = new Date()): UsageReadFilter {
    return resolveUsageFilter(principal, query, now)
  }

  async overview(principal: AnalyticsPrincipal, query: UsageQueryDto, mode: 'analytics' | 'logs' = 'analytics'): Promise<AnalyticsOverview> {
    const filter = resolveUsageFilter(principal, query, new Date(), mode)
    const source = metricSource(hasAllocationFilter(filter))
    const join = Prisma.sql`FROM scoped_usage u JOIN matched_requests m ON m.usage_log_id = u.id`
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT ${requestMetricsSql(source)} ${join}`)
    const errors = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)}
      SELECT u.error_code, COUNT(*)::bigint AS requests ${join}
      WHERE u.error_code IS NOT NULL GROUP BY u.error_code ORDER BY u.error_code`)
    const row = rows[0] || {}
    const result = metrics(row, errors.map(error => ({ errorCode: error.error_code, requests: integer(error.requests) })))
    const average = result.requests ? new Decimal(result.costCny).div(result.requests).toFixed(8) : '0.00000000'
    return { ...result, activeAccounts: integer(row.active_accounts), avgCostPerRequestUsd: average, avgCostPerRequestCny: average,
      p50LatencyMs: nullableInteger(row.p50_latency_ms), p95LatencyMs: nullableInteger(row.p95_latency_ms),
      p50FirstTokenMs: nullableInteger(row.p50_first_token_ms), p95FirstTokenMs: nullableInteger(row.p95_first_token_ms),
      failoverRate: result.requests ? integer(row.failovers) / result.requests : 0 }
  }

  async timeseries(principal: AnalyticsPrincipal, query: AnalyticsQueryDto) {
    const filter = this.resolveFilter(principal, query)
    const interval = query.interval || 'day'
    if (interval !== 'hour' && interval !== 'day') throw new BadRequestException('Interval must be hour or day')
    if (interval === 'hour' && filter.end.getTime() - filter.start.getTime() > 31 * DAY) throw new BadRequestException('Hourly analytics range cannot exceed 31 days')
    const source = metricSource(hasAllocationFilter(filter))
    const bucket = Prisma.sql`date_trunc(${interval}, u.started_at AT TIME ZONE 'UTC' AT TIME ZONE ${filter.timezone}) AT TIME ZONE ${filter.timezone}`
    const join = Prisma.sql`FROM scoped_usage u JOIN matched_requests m ON m.usage_log_id = u.id`
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)}
      SELECT ${bucket} AS bucket, ${requestMetricsSql(source)} ${join} GROUP BY 1 ORDER BY 1 ASC`)
    const errors = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)}
      SELECT ${bucket} AS bucket, u.error_code, COUNT(*)::bigint AS requests ${join}
      WHERE u.error_code IS NOT NULL GROUP BY 1, u.error_code ORDER BY 1, u.error_code`)
    const errorCounts = new Map<string, Array<{ errorCode: string; requests: number }>>()
    for (const error of errors) {
      const key = new Date(error.bucket).toISOString()
      errorCounts.set(key, [...(errorCounts.get(key) || []), { errorCode: error.error_code, requests: integer(error.requests) }])
    }
    return rows.map(row => {
      const bucket = new Date(row.bucket).toISOString()
      return { bucket, ...metrics(row, errorCounts.get(bucket) || []) }
    })
  }

  private drillQuery(dimension: keyof typeof DIMENSIONS, row: any): Record<string, string> {
    const allocation: Record<string, string> = row.allocation_kind === 'UNALLOCATED' ? { allocation: 'UNALLOCATED' } : {}
    if (dimension === 'channel' && row.allocation_kind === 'UNALLOCATED') return allocation
    if (dimension === 'channelModel' && !row.id) return { ...allocation, channelModelScope: 'UNASSOCIATED' }
    if (dimension === 'costRule') return row.id ? { ...allocation, priceKey: row.id } : allocation
    if (dimension === 'group' && !row.id) return { ...allocation, groupScope: 'UNGROUPED' }
    if (dimension === 'apiKey' && !row.id) return { ...allocation, keyScope: 'NO_KEY' }
    const key = { organization: 'organizationId', channel: 'channelId', model: 'publicModelId',
      channelModel: 'channelModelId', account: 'accountId', group: 'groupId', apiKey: 'apiKeyId' }[dimension]
    return { ...allocation, [key!]: row.id }
  }

  async breakdown(principal: AnalyticsPrincipal, query: AnalyticsQueryDto) {
    return this.groupedRows(principal, query)
  }

  async exportRows(principal: AnalyticsPrincipal, query: AnalyticsQueryDto): Promise<Array<Record<string, unknown>>> {
    const result = await this.groupedRows(principal, query, 'analytics', true)
    if (result.items.length > 5000) throw new BadRequestException('CSV export exceeds 5000 rows; narrow the filter range')
    return result.items
  }

  private async groupedRows(principal: AnalyticsPrincipal, query: UsageQueryDto, mode: 'analytics' | 'logs' = 'analytics', exporting = false) {
    const dimension = query.dimension as keyof typeof DIMENSIONS
    const sort = (query.sort || 'costUsd') as keyof typeof SORTS
    const order = String(query.order || 'desc').toLowerCase()
    if (!DIMENSIONS[dimension]) throw new BadRequestException('Unsupported analytics dimension')
    if (dimension === 'organization' && principal.role !== 'PLATFORM_ADMIN') throw new BadRequestException('Organization breakdown requires platform administrator')
    if (!SORTS[sort] || !['asc', 'desc'].includes(order)) throw new BadRequestException('Unsupported analytics sort')
    const limit = exporting ? 5001 : Math.min(200, Math.max(1, Number(query.limit) || 50))
    const offset = exporting ? 0 : Math.max(0, Number(query.offset) || 0)
    const filter = resolveUsageFilter(principal, query, new Date(), mode)
    const selected = DIMENSIONS[dimension]
    const source = metricSource(hasAllocationFilter(filter) || ['channel', 'channelModel', 'costRule'].includes(dimension))
    const search = query.q
      ? Prisma.sql`AND (${Prisma.raw(selected.id)} ILIKE ${`%${query.q}%`} OR ${Prisma.raw(selected.name)} ILIKE ${`%${query.q}%`})`
      : Prisma.empty
    const cte = Prisma.sql`${usageReadCte(filter, dimension)}, dimension_allocations AS (
      SELECT ${Prisma.raw(selected.id)} AS dimension_id, ${Prisma.raw(selected.name)} AS dimension_name, a.*
      FROM scoped_usage u JOIN allocations a ON a.usage_log_id = u.id
      LEFT JOIN organizations o ON o.id = u.organization_id
      LEFT JOIN channels c ON c.id = a.channel_id
      LEFT JOIN public_models pm ON pm.id = u.public_model_id
      LEFT JOIN channel_models cm ON cm.id = a.channel_model_id
      WHERE ${allocationWhere(filter)} ${search}
    ), dimension_requests AS (
      SELECT a.dimension_id, MAX(a.dimension_name) AS name, a.usage_log_id, ${allocationMetricsSql}
      FROM dimension_allocations a GROUP BY a.dimension_id, a.usage_log_id
    ), grouped AS (
      SELECT m.dimension_id AS id, MAX(m.name) AS name, ${requestMetricsSql(source)},
        COALESCE(SUM(m.matched_cost_cny), 0)::numeric AS matched_cost_cny,
        COALESCE(SUM(u.cost_usd), 0)::numeric AS request_cost_cny,
        COUNT(*) FILTER (WHERE u.status_code < 400 AND NOT ${source.unsettled})::numeric / NULLIF(COUNT(*), 0) AS success_rate,
        COUNT(*) FILTER (WHERE ${requestStateSql} = 'SUCCESS')::numeric / NULLIF(COUNT(*), 0) AS request_success_rate
      FROM dimension_requests m JOIN scoped_usage u ON u.id = m.usage_log_id GROUP BY m.dimension_id
    ), prices AS (
      SELECT a.dimension_id,
        CASE WHEN COUNT(DISTINCT a.price_key) = 1 AND BOOL_AND(a.price_snapshot IS NOT NULL)
          THEN (ARRAY_AGG(a.price_snapshot))[1] ELSE NULL END AS price_snapshot,
        CASE WHEN COUNT(DISTINCT a.price_key) = 1 THEN MAX(a.price_key) ELSE NULL END AS price_key,
        CASE WHEN COUNT(DISTINCT a.allocation_kind) = 1 THEN MAX(a.allocation_kind) ELSE 'MIXED' END AS allocation_kind
      FROM dimension_allocations a GROUP BY a.dimension_id
    ), errors AS (
      SELECT m.dimension_id, u.error_code, COUNT(*)::integer AS requests
      FROM dimension_requests m JOIN scoped_usage u ON u.id = m.usage_log_id
      WHERE u.error_code IS NOT NULL GROUP BY m.dimension_id, u.error_code
    )`
    const countRows = exporting ? [] : await this.prisma.$queryRaw<any[]>(Prisma.sql`${cte} SELECT COUNT(*)::bigint AS total FROM grouped`)
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`${cte}
      SELECT g.*, p.price_snapshot, p.price_key, p.allocation_kind,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('errorCode', e.error_code, 'requests', e.requests) ORDER BY e.error_code)
          FROM errors e WHERE e.dimension_id IS NOT DISTINCT FROM g.id), '[]'::jsonb) AS error_counts
      FROM grouped g JOIN prices p ON p.dimension_id IS NOT DISTINCT FROM g.id
      ORDER BY ${Prisma.raw(SORTS[sort])} ${Prisma.raw(order.toUpperCase())}, g.id ASC NULLS LAST LIMIT ${limit} OFFSET ${offset}`)
    return { items: rows.map(row => {
      const price = safePrice(row.price_snapshot)
      return { id: row.id, name: row.name, ...metrics(row, row.error_counts || []),
        totalTokens: numeric(row.total_tokens), matchedCostCny: money(row.matched_cost_cny), requestCostCny: money(row.request_cost_cny),
        p95LatencyMs: nullableInteger(row.p95_latency_ms), allocationKind: row.allocation_kind,
        priceKey: row.price_key, price,
        avgInputPerMillion: price ? money(price.inputPerMillion) : null, avgOutputPerMillion: price ? money(price.outputPerMillion) : null,
        schedule: price?.daysOfWeek && price.startMinute !== null && price.endMinute !== null
          ? { daysOfWeek: price.daysOfWeek, startMinute: price.startMinute, endMinute: price.endMinute } : null,
        drillQuery: this.drillQuery(dimension, row) }
    }), limit, offset, total: integer(countRows[0]?.total) }
  }

  async filterOptions(principal: AnalyticsPrincipal, query: UsageQueryDto, mode: 'analytics' | 'logs' = 'analytics') {
    if (query.optionDimension) {
      const optionQuery: any = { ...query, dimension: query.optionDimension, sort: 'name', order: 'asc' }
      if (query.optionDimension === 'organization') delete optionQuery.organizationId
      if (query.optionDimension === 'channel') { delete optionQuery.channelId; delete optionQuery.allocation }
      if (query.optionDimension === 'model') { delete optionQuery.publicModelId; delete optionQuery.model }
      if (query.optionDimension === 'channelModel') { delete optionQuery.channelModelId; delete optionQuery.channelModelScope }
      if (query.optionDimension === 'account') delete optionQuery.accountId
      if (query.optionDimension === 'costRule') { delete optionQuery.costRuleId; delete optionQuery.priceKey }
      if (query.optionDimension === 'group') { delete optionQuery.groupId; delete optionQuery.groupScope }
      if (query.optionDimension === 'apiKey') { delete optionQuery.apiKeyId; delete optionQuery.keyScope }
      const result = await this.groupedRows(principal, optionQuery, mode)
      const items = result.items.map(item => ({ id: item.id, name: item.name, drillQuery: item.drillQuery }))
      const empty: Array<{ id: string | null; name: string; drillQuery?: Record<string, string> }> = []
      const collection = { organizations: empty, channels: empty, models: empty, channelModels: empty, accounts: empty, costRules: empty, groups: empty, apiKeys: empty }
      const key = { organization: 'organizations', channel: 'channels', model: 'models', channelModel: 'channelModels', account: 'accounts', costRule: 'costRules', group: 'groups', apiKey: 'apiKeys' }[query.optionDimension]!
      collection[key as keyof typeof collection] = items
      return { ...collection, page: { dimension: query.optionDimension, items, total: result.total, limit: result.limit, offset: result.offset } }
    }
    const filter = resolveUsageFilter(principal, query, new Date(), mode)
    const usage = hasAllocationFilter(filter) ? Prisma.sql`scoped_usage u JOIN matched_requests m ON m.usage_log_id = u.id` : Prisma.sql`scoped_usage u`
    const [organizations, channels, models, channelModels, accounts, costRules, groups, apiKeys] = await Promise.all([
      principal.role === 'PLATFORM_ADMIN' ? this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT DISTINCT o.id::text AS id, o.name FROM ${usage} JOIN organizations o ON o.id = u.organization_id ORDER BY o.name`) : [],
      this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT DISTINCT c.id::text AS id, c.name FROM allocations a JOIN channels c ON c.id = a.channel_id WHERE ${allocationWhere(filter)} ORDER BY c.name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT DISTINCT pm.id, pm.display_name AS name FROM ${usage} JOIN public_models pm ON pm.id = u.public_model_id ORDER BY name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT DISTINCT cm.id::text AS id, cm.upstream_model AS name FROM allocations a JOIN channel_models cm ON cm.id = a.channel_model_id WHERE ${allocationWhere(filter)} ORDER BY name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT u.account_id::text AS id, MAX(COALESCE(u.actor_snapshot->>'employeeName', u.account_id::text)) AS name FROM ${usage} GROUP BY u.account_id ORDER BY name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT DISTINCT a.price_key AS id, COALESCE(a.price_snapshot->>'ruleName', a.price_snapshot->>'source', '历史价格信息不足') AS name FROM allocations a WHERE ${allocationWhere(filter)} ORDER BY name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT u.group_id::text AS id, MAX(COALESCE(u.actor_snapshot->>'groupName', u.group_id::text)) AS name FROM ${usage} WHERE u.group_id IS NOT NULL GROUP BY u.group_id ORDER BY name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT u.api_key_id::text AS id, MAX(COALESCE(u.actor_snapshot->>'keyName', u.api_key_id::text)) AS name FROM ${usage} WHERE u.api_key_id IS NOT NULL GROUP BY u.api_key_id ORDER BY name`)
    ])
    return { organizations, channels, models, channelModels, accounts, costRules, groups, apiKeys, page: null }
  }
}
