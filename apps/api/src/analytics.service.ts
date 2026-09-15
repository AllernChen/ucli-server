import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AnalyticsOverview, AnalyticsPrincipal, UsageReadFilter } from '../../../packages/usage/src/analytics-types.js'
import type { AnalyticsQueryDto } from './analytics.dto.js'
import { allocationWhere, hasAllocationFilter, requestStateSql, resolveUsageFilter, usageReadCte } from './usage-query.js'

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
const SORTS = { requests: 'requests', costCny: 'matched_cost_cny', costUsd: 'matched_cost_cny', tokens: 'total_tokens', successRate: 'success_rate', p95LatencyMs: 'p95_latency_ms' } as const
const integer = (value: unknown) => Number(value || 0)
const nullableInteger = (value: unknown): number | null => value === null || value === undefined ? null : Math.round(Number(value))
const money = (value: unknown) => new Decimal(value?.toString() || 0).toFixed(8)
const numeric = (value: unknown) => String(value ?? 0)
function safePrice(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const snapshot = value as Record<string, unknown>
  const rate = (key: string) => {
    try { const amount = new Decimal(String(snapshot[key])); return amount.isFinite() ? amount.toString() : null } catch { return null }
  }
  const inputPerMillion = rate('inputPerMillion'); const cachedPerMillion = rate('cachedPerMillion'); const outputPerMillion = rate('outputPerMillion'); const reasoningPerMillion = rate('reasoningPerMillion')
  if ([inputPerMillion, cachedPerMillion, outputPerMillion, reasoningPerMillion].some(value => value === null)) return null
  return { id: typeof snapshot.id === 'string' ? snapshot.id : null, source: typeof snapshot.source === 'string' ? snapshot.source : null,
    inputPerMillion, cachedPerMillion, outputPerMillion, reasoningPerMillion, timezone: typeof snapshot.timezone === 'string' ? snapshot.timezone : null,
    daysOfWeek: Array.isArray(snapshot.daysOfWeek) && snapshot.daysOfWeek.every(value => Number.isInteger(value)) ? snapshot.daysOfWeek : null,
    startMinute: Number.isInteger(snapshot.startMinute) ? snapshot.startMinute : null, endMinute: Number.isInteger(snapshot.endMinute) ? snapshot.endMinute : null,
    validFrom: typeof snapshot.validFrom === 'string' ? snapshot.validFrom : null, validTo: typeof snapshot.validTo === 'string' ? snapshot.validTo : typeof snapshot.validUntil === 'string' ? snapshot.validUntil : null }
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  resolveFilter(principal: AnalyticsPrincipal, query: AnalyticsQueryDto, now = new Date()): UsageReadFilter { return resolveUsageFilter(principal, query, now) }

  private source(filter: UsageReadFilter) {
    if (hasAllocationFilter(filter)) return { join: Prisma.sql`FROM scoped_usage u JOIN matched_requests m ON m.usage_log_id = u.id`, cost: Prisma.raw('m.matched_cost_cny'), input: Prisma.raw('m.input_tokens'), cached: Prisma.raw('m.cached_tokens'), output: Prisma.raw('m.output_tokens'), reasoning: Prisma.raw('m.reasoning_tokens'), unsettled: Prisma.raw('m.unsettled'), estimatedCost: Prisma.raw('m.estimated_cost_cny'), knownCached: Prisma.raw('m.known_cached_tokens'), knownInput: Prisma.raw('m.known_input_tokens'), unknownCache: Prisma.raw('m.unknown_cache_calls'), incomplete: Prisma.raw('m.token_usage_incomplete') }
    return { join: Prisma.sql`FROM scoped_usage u LEFT JOIN matched_requests m ON m.usage_log_id = u.id`, cost: Prisma.raw('u.cost_usd'), input: Prisma.raw('u.input_tokens'), cached: Prisma.raw('u.cached_tokens'), output: Prisma.raw('u.output_tokens'), reasoning: Prisma.raw('u.reasoning_tokens'), unsettled: Prisma.raw("COALESCE(u.cost_snapshot->>'billingState', CASE WHEN u.usage_source::text = 'ESTIMATED' THEN 'ESTIMATED' ELSE 'CONFIRMED' END) = 'UNKNOWN'"), estimatedCost: Prisma.raw('COALESCE(m.estimated_cost_cny, 0)'), knownCached: Prisma.raw('COALESCE(m.known_cached_tokens, 0)'), knownInput: Prisma.raw('COALESCE(m.known_input_tokens, 0)'), unknownCache: Prisma.raw('COALESCE(m.unknown_cache_calls, 0)'), incomplete: Prisma.raw('COALESCE(m.token_usage_incomplete, false)') }
  }

  async overview(principal: AnalyticsPrincipal, query: AnalyticsQueryDto): Promise<AnalyticsOverview> {
    const filter = this.resolveFilter(principal, query); const source = this.source(filter)
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)}
      SELECT COUNT(*)::bigint AS requests, COUNT(*) FILTER (WHERE ${requestStateSql} = 'SUCCESS')::bigint AS request_successes,
        COUNT(*) FILTER (WHERE u.status_code < 400 AND NOT ${source.unsettled})::bigint AS successes, COUNT(*) FILTER (WHERE ${source.unsettled})::bigint AS unsettled_requests,
        COUNT(DISTINCT u.account_id)::bigint AS active_accounts, COALESCE(SUM(${source.input}), 0)::numeric AS input_tokens, COALESCE(SUM(${source.output}), 0)::numeric AS output_tokens,
        COALESCE(SUM(${source.cached}), 0)::numeric AS cached_tokens, COALESCE(SUM(${source.reasoning}), 0)::numeric AS reasoning_tokens,
        COALESCE(SUM(GREATEST(COALESCE(${source.input}, 0) - COALESCE(${source.cached}, 0), 0)), 0)::numeric AS uncached_input_tokens, COALESCE(SUM(${source.cost}), 0)::numeric AS cost_usd,
        COUNT(*) FILTER (WHERE ${requestStateSql} = 'FAILED')::bigint AS failed_requests, COUNT(*) FILTER (WHERE ${requestStateSql} = 'CANCELLED')::bigint AS cancelled_requests,
        COUNT(*) FILTER (WHERE ${requestStateSql} = 'INTERRUPTED')::bigint AS interrupted_requests,
        COALESCE(SUM(${source.estimatedCost}), 0)::numeric AS estimated_cost_cny,
        COALESCE(SUM(${source.knownCached}), 0)::numeric AS known_cached_tokens,
        COALESCE(SUM(${source.knownInput}), 0)::numeric AS known_input_tokens,
        COALESCE(SUM(${source.unknownCache}), 0)::bigint AS unknown_cache_calls,
        COALESCE(BOOL_OR(${source.incomplete}), false) AS token_usage_incomplete,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY u.duration_ms) AS p50_latency_ms, percentile_cont(0.95) WITHIN GROUP (ORDER BY u.duration_ms) AS p95_latency_ms,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY u.first_token_ms) FILTER (WHERE u.first_token_ms IS NOT NULL) AS p50_first_token_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY u.first_token_ms) FILTER (WHERE u.first_token_ms IS NOT NULL) AS p95_first_token_ms, COUNT(*) FILTER (WHERE u.switched)::bigint AS failovers,
        COALESCE((SELECT SUM(a.cost_cny) FROM allocations a WHERE a.allocation_kind = 'UNALLOCATED' AND ${allocationWhere(filter)}), 0)::numeric AS unallocated_cost_cny
      ${source.join}`)
    const row = rows[0] || {}; const requests = integer(row.requests); const costUsd = money(row.cost_usd); const knownInput = new Decimal(row.known_input_tokens?.toString() || 0); const knownCached = new Decimal(row.known_cached_tokens?.toString() || 0)
    const errors = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT u.error_code, COUNT(*)::bigint AS requests ${source.join} WHERE u.error_code IS NOT NULL GROUP BY u.error_code ORDER BY u.error_code`)
    return { requests, successRate: requests ? integer(row.successes) / requests : 0, requestSuccessRate: requests ? integer(row.request_successes) / requests : null,
      requestStates: { SUCCESS: integer(row.request_successes), FAILED: integer(row.failed_requests), CANCELLED: integer(row.cancelled_requests), INTERRUPTED: integer(row.interrupted_requests) }, activeAccounts: integer(row.active_accounts), inputTokens: numeric(row.input_tokens), outputTokens: numeric(row.output_tokens), cachedTokens: numeric(row.cached_tokens), uncachedInputTokens: numeric(row.uncached_input_tokens), reasoningTokens: numeric(row.reasoning_tokens), cacheHitRate: knownInput.isZero() ? null : knownCached.div(knownInput).toNumber(), cacheCoverage: { knownInputTokens: knownInput.toString(), totalInputTokens: numeric(row.input_tokens), unknownCalls: integer(row.unknown_cache_calls) }, estimatedCostCny: money(row.estimated_cost_cny), unallocatedCostCny: money(row.unallocated_cost_cny), tokenUsageIncomplete: Boolean(row.token_usage_incomplete), errorCounts: errors.map(item => ({ errorCode: item.error_code, requests: integer(item.requests) })), costUsd, avgCostPerRequestUsd: requests ? new Decimal(costUsd).div(requests).toFixed(8) : '0.00000000', currency: 'CNY', costCny: costUsd, avgCostPerRequestCny: requests ? new Decimal(costUsd).div(requests).toFixed(8) : '0.00000000', unsettledRequests: integer(row.unsettled_requests), p50LatencyMs: nullableInteger(row.p50_latency_ms), p95LatencyMs: nullableInteger(row.p95_latency_ms), p50FirstTokenMs: nullableInteger(row.p50_first_token_ms), p95FirstTokenMs: nullableInteger(row.p95_first_token_ms), failoverRate: requests ? integer(row.failovers) / requests : 0 }
  }

  async timeseries(principal: AnalyticsPrincipal, query: AnalyticsQueryDto) {
    const filter = this.resolveFilter(principal, query); const interval = query.interval || 'day'; const source = this.source(filter)
    if (interval !== 'hour' && interval !== 'day') throw new BadRequestException('Interval must be hour or day')
    if (interval === 'hour' && filter.end.getTime() - filter.start.getTime() > 31 * DAY) throw new BadRequestException('Hourly analytics range cannot exceed 31 days')
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT date_trunc(${Prisma.raw(`'${interval}'`)}, u.started_at AT TIME ZONE 'UTC' AT TIME ZONE ${filter.timezone}) AT TIME ZONE ${filter.timezone} AS bucket, COUNT(*)::bigint AS requests, COUNT(*) FILTER (WHERE u.status_code < 400 AND NOT ${source.unsettled})::bigint AS successes, COUNT(*) FILTER (WHERE ${requestStateSql} = 'SUCCESS')::bigint AS request_successes, COUNT(*) FILTER (WHERE ${requestStateSql} = 'FAILED')::bigint AS failed_requests, COUNT(*) FILTER (WHERE ${requestStateSql} = 'CANCELLED')::bigint AS cancelled_requests, COUNT(*) FILTER (WHERE ${requestStateSql} = 'INTERRUPTED')::bigint AS interrupted_requests, COUNT(*) FILTER (WHERE ${source.unsettled})::bigint AS unsettled_requests, COALESCE(SUM(${source.input}), 0)::numeric AS input_tokens, COALESCE(SUM(${source.output}), 0)::numeric AS output_tokens, COALESCE(SUM(${source.cached}), 0)::numeric AS cached_tokens, COALESCE(SUM(${source.reasoning}), 0)::numeric AS reasoning_tokens, COALESCE(SUM(GREATEST(COALESCE(${source.input}, 0) - COALESCE(${source.cached}, 0), 0)), 0)::numeric AS uncached_input_tokens, COALESCE(SUM(${source.cost}), 0)::numeric AS cost_usd, COALESCE(SUM(${source.estimatedCost}), 0)::numeric AS estimated_cost_cny, COALESCE(SUM(${source.knownCached}), 0)::numeric AS known_cached_tokens, COALESCE(SUM(${source.knownInput}), 0)::numeric AS known_input_tokens, COALESCE(SUM(${source.unknownCache}), 0)::bigint AS unknown_cache_calls, COALESCE(BOOL_OR(${source.incomplete}), false) AS token_usage_incomplete ${source.join} GROUP BY 1 ORDER BY 1 ASC`)
    return rows.map(row => { const knownInput = new Decimal(row.known_input_tokens?.toString() || 0); const knownCached = new Decimal(row.known_cached_tokens?.toString() || 0); const requests = integer(row.requests); return { bucket: new Date(row.bucket).toISOString(), requests, successRate: requests ? integer(row.successes) / requests : 0, requestSuccessRate: requests ? integer(row.request_successes) / requests : null, requestStates: { SUCCESS: integer(row.request_successes), FAILED: integer(row.failed_requests), CANCELLED: integer(row.cancelled_requests), INTERRUPTED: integer(row.interrupted_requests) }, inputTokens: numeric(row.input_tokens), outputTokens: numeric(row.output_tokens), cachedTokens: numeric(row.cached_tokens), uncachedInputTokens: numeric(row.uncached_input_tokens), reasoningTokens: numeric(row.reasoning_tokens), cacheHitRate: knownInput.isZero() ? null : knownCached.div(knownInput).toNumber(), cacheCoverage: { knownInputTokens: knownInput.toString(), totalInputTokens: numeric(row.input_tokens), unknownCalls: integer(row.unknown_cache_calls) }, estimatedCostCny: money(row.estimated_cost_cny), tokenUsageIncomplete: Boolean(row.token_usage_incomplete), costUsd: money(row.cost_usd), currency: 'CNY', costCny: money(row.cost_usd), unsettledRequests: integer(row.unsettled_requests) } })
  }

  private drillQuery(dimension: keyof typeof DIMENSIONS, row: any): Record<string, string> {
    if (row.allocation_kind === 'UNALLOCATED') return { allocation: 'UNALLOCATED' }
    if (dimension === 'channelModel' && !row.id) return { channelModelScope: 'UNASSOCIATED' }
    if (dimension === 'costRule') return { priceKey: row.id }
    if (dimension === 'group' && !row.id) return { groupScope: 'UNGROUPED' }
    if (dimension === 'apiKey' && !row.id) return { keyScope: 'NO_KEY' }
    const key = { organization: 'organizationId', channel: 'channelId', model: 'publicModelId', channelModel: 'channelModelId', account: 'accountId', group: 'groupId', apiKey: 'apiKeyId' }[dimension]
    return { [key!]: row.id }
  }

  async breakdown(principal: AnalyticsPrincipal, query: AnalyticsQueryDto) {
    const dimension = query.dimension as keyof typeof DIMENSIONS; const sort = (query.sort || 'costUsd') as keyof typeof SORTS; const order = String(query.order || 'desc').toLowerCase()
    if (!DIMENSIONS[dimension]) throw new BadRequestException('Unsupported analytics dimension')
    if (dimension === 'organization' && principal.role !== 'PLATFORM_ADMIN') throw new BadRequestException('Organization breakdown requires platform administrator')
    if (!SORTS[sort] || !['asc', 'desc'].includes(order)) throw new BadRequestException('Unsupported analytics sort')
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50)); const offset = Math.max(0, Number(query.offset) || 0); const filter = this.resolveFilter(principal, query); const selected = DIMENSIONS[dimension]
    const useRequestTokens = !hasAllocationFilter(filter) && !['channel', 'channelModel', 'costRule'].includes(dimension)
    const search = query.q ? Prisma.sql`AND (${Prisma.raw(selected.id)} ILIKE ${`%${query.q}%`} OR ${Prisma.raw(selected.name)} ILIKE ${`%${query.q}%`})` : Prisma.empty
    const countRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter, dimension)} SELECT COUNT(*)::bigint AS total FROM (
      SELECT ${Prisma.raw(selected.id)} FROM scoped_usage u JOIN allocations a ON a.usage_log_id = u.id
      LEFT JOIN organizations o ON o.id = u.organization_id LEFT JOIN channels c ON c.id = a.channel_id LEFT JOIN public_models pm ON pm.id = u.public_model_id LEFT JOIN channel_models cm ON cm.id = a.channel_model_id
      WHERE ${allocationWhere(filter)} ${search} GROUP BY 1
    ) grouped_count`)
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter, dimension)}, grouped AS (
      SELECT ${Prisma.raw(selected.id)} AS id, MAX(${Prisma.raw(selected.name)}) AS name, ARRAY_AGG(DISTINCT u.id) AS request_ids, COUNT(DISTINCT u.id)::bigint AS requests, COUNT(DISTINCT u.id) FILTER (WHERE ${requestStateSql} = 'SUCCESS')::bigint AS successes, COUNT(DISTINCT u.id) FILTER (WHERE ${requestStateSql} = 'FAILED')::bigint AS failed_requests, COUNT(DISTINCT u.id) FILTER (WHERE ${requestStateSql} = 'CANCELLED')::bigint AS cancelled_requests, COUNT(DISTINCT u.id) FILTER (WHERE ${requestStateSql} = 'INTERRUPTED')::bigint AS interrupted_requests, COUNT(DISTINCT u.id) FILTER (WHERE ${requestStateSql} = 'SUCCESS')::numeric / NULLIF(COUNT(DISTINCT u.id), 0) AS success_rate, COUNT(DISTINCT u.id) FILTER (WHERE a.billing_state = 'UNKNOWN')::bigint AS unsettled_requests, COALESCE(SUM(a.input_tokens + a.output_tokens), 0)::numeric AS total_tokens, COALESCE(SUM(a.input_tokens), 0)::numeric AS input_tokens, COALESCE(SUM(a.cached_tokens), 0)::numeric AS cached_tokens, COALESCE(SUM(a.reasoning_tokens), 0)::numeric AS reasoning_tokens, COALESCE(SUM(a.cost_cny), 0)::numeric AS matched_cost_cny, COALESCE(SUM(a.cost_cny) FILTER (WHERE a.billing_state = 'ESTIMATED' AND a.allocation_kind <> 'UNALLOCATED'), 0)::numeric AS estimated_cost_cny, COALESCE(SUM(a.cost_cny) FILTER (WHERE a.allocation_kind = 'UNALLOCATED'), 0)::numeric AS unallocated_cost_cny, COALESCE(SUM(a.cached_tokens) FILTER (WHERE a.usage_source = 'upstream' AND COALESCE(a.cached_tokens, 0) > 0), 0)::numeric AS known_cached_tokens, COALESCE(SUM(a.input_tokens) FILTER (WHERE a.usage_source = 'upstream' AND COALESCE(a.cached_tokens, 0) > 0), 0)::numeric AS known_input_tokens, COUNT(*) FILTER (WHERE a.allocation_kind <> 'UNALLOCATED' AND NOT (a.usage_source = 'upstream' AND COALESCE(a.cached_tokens, 0) > 0))::bigint AS unknown_cache_calls, BOOL_OR(a.input_tokens IS NULL AND a.allocation_kind <> 'UNALLOCATED') AS token_usage_incomplete, percentile_cont(0.95) WITHIN GROUP (ORDER BY u.duration_ms) AS p95_latency_ms, (ARRAY_AGG(a.price_snapshot) FILTER (WHERE a.price_snapshot IS NOT NULL))[1] AS price_snapshot, COUNT(DISTINCT a.price_key) FILTER (WHERE a.price_snapshot IS NOT NULL)::bigint AS price_key_count, MAX(a.price_key) AS price_key, CASE WHEN COUNT(DISTINCT a.allocation_kind) = 1 THEN MAX(a.allocation_kind) ELSE 'MIXED' END AS allocation_kind
      FROM scoped_usage u JOIN allocations a ON a.usage_log_id = u.id LEFT JOIN organizations o ON o.id = u.organization_id LEFT JOIN channels c ON c.id = a.channel_id LEFT JOIN public_models pm ON pm.id = u.public_model_id LEFT JOIN channel_models cm ON cm.id = a.channel_model_id WHERE ${allocationWhere(filter)} ${search} GROUP BY 1
    ) SELECT grouped.*, COUNT(*) OVER()::bigint AS total, (SELECT COALESCE(SUM(s.cost_usd), 0) FROM scoped_usage s WHERE s.id = ANY(grouped.request_ids))::numeric AS request_cost_cny, (SELECT COALESCE(SUM(s.input_tokens), 0) FROM scoped_usage s WHERE s.id = ANY(grouped.request_ids))::numeric AS request_input_tokens, (SELECT COALESCE(SUM(s.output_tokens), 0) FROM scoped_usage s WHERE s.id = ANY(grouped.request_ids))::numeric AS request_output_tokens, (SELECT COALESCE(SUM(s.cached_tokens), 0) FROM scoped_usage s WHERE s.id = ANY(grouped.request_ids))::numeric AS request_cached_tokens, (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms) FROM scoped_usage s WHERE s.id = ANY(grouped.request_ids)) AS request_p95_latency_ms FROM grouped ORDER BY ${Prisma.raw(SORTS[sort])} ${Prisma.raw(order.toUpperCase())}, id ASC NULLS LAST LIMIT ${limit} OFFSET ${offset}`)
    return { items: rows.map(row => { const inputTokens = useRequestTokens ? numeric(row.request_input_tokens) : numeric(row.input_tokens); const outputTokens = useRequestTokens ? numeric(row.request_output_tokens) : numeric(row.total_tokens - row.input_tokens); const cachedTokens = useRequestTokens ? numeric(row.request_cached_tokens) : numeric(row.cached_tokens); const knownInput = new Decimal(row.known_input_tokens?.toString() || 0); const knownCached = new Decimal(row.known_cached_tokens?.toString() || 0); const requests = integer(row.requests); return { id: row.id, name: row.name, requests, successRate: requests ? integer(row.successes) / requests : 0, requestSuccessRate: requests ? integer(row.successes) / requests : null, requestStates: { SUCCESS: integer(row.successes), FAILED: integer(row.failed_requests), CANCELLED: integer(row.cancelled_requests), INTERRUPTED: integer(row.interrupted_requests) }, totalTokens: useRequestTokens ? new Decimal(inputTokens).plus(outputTokens).toString() : numeric(row.total_tokens), inputTokens, cachedTokens, uncachedInputTokens: Decimal.max(new Decimal(inputTokens).minus(cachedTokens), 0).toString(), reasoningTokens: numeric(row.reasoning_tokens), cacheHitRate: knownInput.isZero() ? null : knownCached.div(knownInput).toNumber(), cacheCoverage: { knownInputTokens: knownInput.toString(), totalInputTokens: inputTokens, unknownCalls: integer(row.unknown_cache_calls) }, estimatedCostCny: money(row.estimated_cost_cny), unallocatedCostCny: money(row.unallocated_cost_cny), tokenUsageIncomplete: Boolean(row.token_usage_incomplete), errorCounts: [], costUsd: money(row.matched_cost_cny), costCny: money(row.matched_cost_cny), matchedCostCny: money(row.matched_cost_cny), requestCostCny: money(row.request_cost_cny), currency: 'CNY', p95LatencyMs: nullableInteger(useRequestTokens ? row.request_p95_latency_ms : row.p95_latency_ms), unsettledRequests: integer(row.unsettled_requests), allocationKind: row.allocation_kind, priceKey: row.price_key, price: integer(row.price_key_count) === 1 ? safePrice(row.price_snapshot) : null, drillQuery: this.drillQuery(dimension, row) } }), limit, offset, total: integer(countRows[0]?.total) }
  }

  async filterOptions(principal: AnalyticsPrincipal, query: AnalyticsQueryDto) {
    if (query.optionDimension) {
      const optionQuery: any = { ...query, dimension: query.optionDimension }
      if (query.optionDimension === 'organization') delete optionQuery.organizationId
      if (query.optionDimension === 'channel') { delete optionQuery.channelId; delete optionQuery.allocation }
      if (query.optionDimension === 'model') { delete optionQuery.publicModelId; delete optionQuery.model }
      if (query.optionDimension === 'channelModel') { delete optionQuery.channelModelId; delete optionQuery.channelModelScope }
      if (query.optionDimension === 'account') delete optionQuery.accountId
      if (query.optionDimension === 'costRule') { delete optionQuery.costRuleId; delete optionQuery.priceKey }
      if (query.optionDimension === 'group') { delete optionQuery.groupId; delete optionQuery.groupScope }
      if (query.optionDimension === 'apiKey') { delete optionQuery.apiKeyId; delete optionQuery.keyScope }
      const result = await this.breakdown(principal, optionQuery)
      const items = result.items.map(item => ({ id: item.id, name: item.name, drillQuery: item.drillQuery }))
      const empty: Array<{ id: string | null; name: string; drillQuery?: Record<string, string> }> = []
      const collection = { organizations: empty, channels: empty, models: empty, channelModels: empty, accounts: empty, costRules: empty, groups: empty, apiKeys: empty }
      const key = { organization: 'organizations', channel: 'channels', model: 'models', channelModel: 'channelModels', account: 'accounts', costRule: 'costRules', group: 'groups', apiKey: 'apiKeys' }[query.optionDimension]!
      collection[key as keyof typeof collection] = items
      return { ...collection, page: { dimension: query.optionDimension, items, total: result.total, limit: result.limit, offset: result.offset } }
    }
    const filter = this.resolveFilter(principal, query)
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
