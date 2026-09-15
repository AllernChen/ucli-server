import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AnalyticsFilter, AnalyticsOverview, AnalyticsPrincipal, UsageReadFilter } from '../../../packages/usage/src/analytics-types.js'
import type { AnalyticsQueryDto } from './analytics.dto.js'
import { resolveUsageFilter, usageWhere } from './usage-query.js'

const DAY = 86_400_000
const DIMENSIONS = {
  organization: { id: 'u.organization_id::text', name: "COALESCE(o.name, u.organization_id::text)" },
  channel: { id: 'COALESCE(b.channel_id, u.channel_id)::text', name: "COALESCE(c.name, COALESCE(b.channel_id, u.channel_id)::text)" },
  model: { id: 'u.public_model_id', name: "COALESCE(pm.display_name, u.public_model_id)" },
  channelModel: { id: 'u.channel_model_id::text', name: "COALESCE(cm.upstream_model, '未关联渠道模型')" },
  account: { id: 'u.account_id::text', name: "COALESCE(u.actor_snapshot->>'employeeName', a.display_name, a.email, u.account_id::text)" },
  group: { id: 'u.group_id::text', name: "COALESCE(u.actor_snapshot->>'groupName', g.name, '历史未归组')" },
  apiKey: { id: 'u.api_key_id::text', name: "COALESCE(u.actor_snapshot->>'keyName', k.name, '设备凭据')" },
  costRule: { id: "COALESCE(u.channel_cost_rule_id::text, u.cost_snapshot->>'id', u.cost_snapshot->>'source', 'UNPRICED')",
    name: "COALESCE(cr.name, u.cost_snapshot->>'ruleName', CASE WHEN u.cost_snapshot->>'source' = 'CHANNEL_COST_RULE' THEN '历史成本规则' WHEN u.cost_snapshot->>'source' = 'PUBLIC_MODEL_FALLBACK' THEN '公共模型兜底成本' ELSE '未配置成本' END)" }
} as const
const SORTS = { requests: 'requests', costCny: 'cost_usd', costUsd: 'cost_usd', tokens: 'total_tokens', successRate: 'success_rate', p95LatencyMs: 'p95_latency_ms' } as const

function integer(value: unknown): number { return Number(value || 0) }
function nullableInteger(value: unknown): number | null { return value === null || value === undefined ? null : Math.round(Number(value)) }
function money(value: unknown): string { return new Decimal(value?.toString() || 0).toFixed(8) }

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  resolveFilter(principal: AnalyticsPrincipal, query: AnalyticsQueryDto, now = new Date()): UsageReadFilter {
    return resolveUsageFilter(principal, query, now)
  }

  // Only expand into one row per request/channel when a channel dimension or filter needs it.
  // Legacy logs without route billing retain their original final-channel allocation.
  private routes(filter: AnalyticsFilter, byChannel = false): Prisma.Sql {
    return byChannel || filter.channelId ? Prisma.sql`LEFT JOIN LATERAL (
      SELECT r.channel_id, COALESCE(SUM(r.cost_cny), 0) AS cost_cny,
        BOOL_OR(r.billing_state = 'UNKNOWN') AS unsettled
      FROM route_attempts r WHERE r.usage_log_id = u.id AND (r.billing_state IS NOT NULL OR r.cost_cny IS NOT NULL)
      GROUP BY r.channel_id
    ) b ON true` : Prisma.empty
  }
  private cost(filter: AnalyticsFilter, byChannel = false) { return Prisma.raw(byChannel || filter.channelId ? 'COALESCE(b.cost_cny, u.cost_usd)' : 'u.cost_usd') }
  private unsettled(filter: AnalyticsFilter, byChannel = false) { return Prisma.raw(byChannel || filter.channelId ? "COALESCE(b.unsettled, u.cost_snapshot->>'billingState' = 'UNKNOWN', false)" : "COALESCE(u.cost_snapshot->>'billingState' = 'UNKNOWN', false)") }

  private where(filter: UsageReadFilter): Prisma.Sql {
    const conditions = [usageWhere(filter)]
    if (filter.channelId) conditions.push(Prisma.sql`COALESCE(b.channel_id, u.channel_id) = ${filter.channelId}::uuid`)
    return Prisma.join(conditions, ' AND ')
  }

  async overview(principal: AnalyticsPrincipal, query: AnalyticsQueryDto): Promise<AnalyticsOverview> {
    const filter = this.resolveFilter(principal, query)
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS requests,
        COUNT(*) FILTER (WHERE u.status_code < 400 AND NOT ${this.unsettled(filter)})::bigint AS successes,
        COUNT(*) FILTER (WHERE ${this.unsettled(filter)})::bigint AS unsettled_requests,
        COUNT(DISTINCT u.account_id)::bigint AS active_accounts,
        COALESCE(SUM(u.input_tokens), 0)::numeric AS input_tokens,
        COALESCE(SUM(u.output_tokens), 0)::numeric AS output_tokens,
        COALESCE(SUM(${this.cost(filter)}), 0)::numeric AS cost_usd,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY u.duration_ms) AS p50_latency_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY u.duration_ms) AS p95_latency_ms,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY u.first_token_ms) FILTER (WHERE u.first_token_ms IS NOT NULL) AS p50_first_token_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY u.first_token_ms) FILTER (WHERE u.first_token_ms IS NOT NULL) AS p95_first_token_ms,
        COUNT(*) FILTER (WHERE u.switched)::bigint AS failovers
      FROM usage_logs u ${this.routes(filter)} WHERE ${this.where(filter)}`)
    const row = rows[0] || {}
    const requests = integer(row.requests)
    const costUsd = money(row.cost_usd)
    return {
      requests, successRate: requests ? integer(row.successes) / requests : 0,
      activeAccounts: integer(row.active_accounts), inputTokens: String(row.input_tokens || 0), outputTokens: String(row.output_tokens || 0),
      costUsd, avgCostPerRequestUsd: requests ? new Decimal(costUsd).div(requests).toFixed(8) : '0.00000000',
      currency: 'CNY', costCny: costUsd, avgCostPerRequestCny: requests ? new Decimal(costUsd).div(requests).toFixed(8) : '0.00000000', unsettledRequests: integer(row.unsettled_requests),
      p50LatencyMs: nullableInteger(row.p50_latency_ms), p95LatencyMs: nullableInteger(row.p95_latency_ms),
      p50FirstTokenMs: nullableInteger(row.p50_first_token_ms), p95FirstTokenMs: nullableInteger(row.p95_first_token_ms),
      failoverRate: requests ? integer(row.failovers) / requests : 0
    }
  }

  async timeseries(principal: AnalyticsPrincipal, query: AnalyticsQueryDto) {
    const filter = this.resolveFilter(principal, query)
    const interval = query.interval || 'day'
    if (interval !== 'hour' && interval !== 'day') throw new BadRequestException('Interval must be hour or day')
    if (interval === 'hour' && filter.end.getTime() - filter.start.getTime() > 31 * DAY) throw new BadRequestException('Hourly analytics range cannot exceed 31 days')
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT date_trunc(${Prisma.raw(`'${interval}'`)}, u.started_at) AS bucket,
        COUNT(*)::bigint AS requests, COUNT(*) FILTER (WHERE u.status_code < 400 AND NOT ${this.unsettled(filter)})::bigint AS successes,
        COUNT(*) FILTER (WHERE ${this.unsettled(filter)})::bigint AS unsettled_requests,
        COALESCE(SUM(u.input_tokens), 0)::numeric AS input_tokens, COALESCE(SUM(u.output_tokens), 0)::numeric AS output_tokens,
        COALESCE(SUM(${this.cost(filter)}), 0)::numeric AS cost_usd
      FROM usage_logs u ${this.routes(filter)} WHERE ${this.where(filter)} GROUP BY 1 ORDER BY 1 ASC`)
    return rows.map(row => ({ bucket: new Date(row.bucket).toISOString(), requests: integer(row.requests),
      successRate: integer(row.requests) ? integer(row.successes) / integer(row.requests) : 0,
      inputTokens: String(row.input_tokens || 0), outputTokens: String(row.output_tokens || 0), costUsd: money(row.cost_usd),
      currency: 'CNY', costCny: money(row.cost_usd), unsettledRequests: integer(row.unsettled_requests) }))
  }

  async breakdown(principal: AnalyticsPrincipal, query: AnalyticsQueryDto) {
    const dimension = query.dimension as keyof typeof DIMENSIONS
    const sort = (query.sort || 'costUsd') as keyof typeof SORTS
    const order = String(query.order || 'desc').toLowerCase()
    if (!DIMENSIONS[dimension]) throw new BadRequestException('Unsupported analytics dimension')
    if (dimension === 'organization' && principal.role !== 'PLATFORM_ADMIN') throw new BadRequestException('Organization breakdown requires platform administrator')
    if (!SORTS[sort] || !['asc', 'desc'].includes(order)) throw new BadRequestException('Unsupported analytics sort')
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50)); const offset = Math.max(0, Number(query.offset) || 0)
    const filter = this.resolveFilter(principal, query); const selected = DIMENSIONS[dimension]
    const byChannel = dimension === 'channel'
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT ${Prisma.raw(selected.id)} AS id, MAX(${Prisma.raw(selected.name)}) AS name,
        COUNT(DISTINCT u.request_id)::bigint AS requests, COUNT(DISTINCT u.request_id) FILTER (WHERE u.status_code < 400 AND NOT ${this.unsettled(filter, byChannel)})::bigint AS successes,
        AVG((u.status_code < 400 AND NOT ${this.unsettled(filter, byChannel)})::int) AS success_rate,
        COUNT(DISTINCT u.request_id) FILTER (WHERE ${this.unsettled(filter, byChannel)})::bigint AS unsettled_requests,
        COALESCE(SUM(u.input_tokens + u.output_tokens), 0)::numeric AS total_tokens,
        COALESCE(SUM(${this.cost(filter, byChannel)}), 0)::numeric AS cost_usd,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY u.duration_ms) AS p95_latency_ms,
        SUM((u.cost_snapshot->>'inputPerMillion')::numeric * u.input_tokens) / NULLIF(SUM(u.input_tokens), 0) AS avg_input_per_million,
        SUM((u.cost_snapshot->>'outputPerMillion')::numeric * u.output_tokens) / NULLIF(SUM(u.output_tokens), 0) AS avg_output_per_million,
        COALESCE(MAX(u.cost_snapshot->>'daysOfWeek'), MAX(cr.days_of_week::text)) AS schedule_days,
        COALESCE(MAX((u.cost_snapshot->>'startMinute')::integer), MAX(cr.start_minute)) AS schedule_start_minute,
        COALESCE(MAX((u.cost_snapshot->>'endMinute')::integer), MAX(cr.end_minute)) AS schedule_end_minute
      FROM usage_logs u ${this.routes(filter, byChannel)}
      LEFT JOIN organizations o ON o.id = u.organization_id LEFT JOIN channels c ON c.id = ${Prisma.raw(byChannel || filter.channelId ? 'COALESCE(b.channel_id, u.channel_id)' : 'u.channel_id')}
      LEFT JOIN public_models pm ON pm.id = u.public_model_id LEFT JOIN channel_models cm ON cm.id = u.channel_model_id
      LEFT JOIN accounts a ON a.id = u.account_id LEFT JOIN channel_model_cost_rules cr ON cr.id = u.channel_cost_rule_id
      LEFT JOIN usage_groups g ON g.id = u.group_id LEFT JOIN employee_api_keys k ON k.id = u.api_key_id
      WHERE ${this.where(filter)} GROUP BY 1 ORDER BY ${Prisma.raw(SORTS[sort])} ${Prisma.raw(order.toUpperCase())}, id ASC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}`)
    return { items: rows.map(row => ({ id: row.id, name: row.name, requests: integer(row.requests),
      successRate: integer(row.requests) ? integer(row.successes) / integer(row.requests) : 0,
      totalTokens: String(row.total_tokens || 0), costUsd: money(row.cost_usd), p95LatencyMs: nullableInteger(row.p95_latency_ms),
      currency: 'CNY', costCny: money(row.cost_usd), unsettledRequests: integer(row.unsettled_requests),
      avgInputPerMillion: row.avg_input_per_million === null ? null : money(row.avg_input_per_million),
      avgOutputPerMillion: row.avg_output_per_million === null ? null : money(row.avg_output_per_million),
      schedule: row.schedule_days ? { daysOfWeek: String(row.schedule_days).replace(/[\[\]{}\s]/g, '').split(',').filter(Boolean).map(Number),
        startMinute: integer(row.schedule_start_minute), endMinute: integer(row.schedule_end_minute) } : null })), limit, offset }
  }

  async filterOptions(principal: AnalyticsPrincipal, query: AnalyticsQueryDto) {
    const filter = this.resolveFilter(principal, query); const where = this.where(filter)
    const source = Prisma.sql`usage_logs u ${this.routes(filter)}`
    const [organizations, channels, models, channelModels, accounts, costRules, groups, apiKeys] = await Promise.all([
      principal.role === 'PLATFORM_ADMIN' ? this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT DISTINCT o.id::text AS id, o.name FROM ${source} JOIN organizations o ON o.id=u.organization_id WHERE ${where} ORDER BY o.name`) : [],
      this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT DISTINCT c.id::text AS id, c.name FROM usage_logs u ${this.routes(filter, true)} JOIN channels c ON c.id=COALESCE(b.channel_id,u.channel_id) WHERE ${where} ORDER BY c.name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT DISTINCT pm.id, pm.display_name AS name FROM ${source} JOIN public_models pm ON pm.id=u.public_model_id WHERE ${where} ORDER BY name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT DISTINCT cm.id::text AS id, cm.upstream_model AS name FROM ${source} JOIN channel_models cm ON cm.id=u.channel_model_id WHERE ${where} ORDER BY name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT a.id::text AS id, MAX(COALESCE(u.actor_snapshot->>'employeeName',a.display_name,a.email)) AS name FROM ${source} JOIN accounts a ON a.id=u.account_id WHERE ${where} GROUP BY a.id ORDER BY name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT DISTINCT
        COALESCE(cr.id::text,u.cost_snapshot->>'id',u.cost_snapshot->>'source') AS id,
        COALESCE(cr.name,u.cost_snapshot->>'ruleName',u.cost_snapshot->>'source') AS name
        FROM ${source} LEFT JOIN channel_model_cost_rules cr ON cr.id=u.channel_cost_rule_id WHERE ${where} ORDER BY name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT g.id::text AS id, MAX(COALESCE(u.actor_snapshot->>'groupName',g.name)) AS name FROM ${source} JOIN usage_groups g ON g.id=u.group_id WHERE ${where} GROUP BY g.id ORDER BY name`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT k.id::text AS id, MAX(COALESCE(u.actor_snapshot->>'keyName',k.name)) AS name FROM ${source} JOIN employee_api_keys k ON k.id=u.api_key_id WHERE ${where} GROUP BY k.id ORDER BY name`)
    ])
    return { organizations, channels, models, channelModels, accounts, costRules, groups, apiKeys }
  }
}
