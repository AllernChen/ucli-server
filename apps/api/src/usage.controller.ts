import { BadRequestException, Controller, Get, Header, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { Prisma } from '@prisma/client'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { estimateActiveMinutes } from '../../../packages/usage/src/analytics.js'
import { csvDocument } from '../../../packages/usage/src/csv.js'
import type { UsageReadFilter } from '../../../packages/usage/src/analytics-types.js'
import { UsageQueryDto } from './analytics.dto.js'
import { AnalyticsService } from './analytics.service.js'
import { allocationWhere, requestStateSql, resolveUsageFilter, usageReadCte } from './usage-query.js'
import { projectBudgetEntry, projectUsage, type UsageDetail } from './usage-detail.js'

const include = { channel: { select: { name: true } }, routes: { orderBy: { attempt: 'asc' as const }, include: { channel: { select: { name: true } } } } }
const legacyRange = (query: UsageQueryDto) => ({ ...query, start: query.start ?? '0001-01-01T00:00:00Z', end: query.end ?? '9999-12-31T23:59:59Z' })
const paging = (query: UsageQueryDto) => ({ limit: Math.min(200, Math.max(1, Number(query.limit) || 50)), offset: Math.max(0, Number(query.offset) || 0) })

@ApiTags('usage') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/usage')
export class UsageController {
  constructor(private readonly prisma: PrismaService, private readonly analytics: AnalyticsService = new AnalyticsService(prisma)) {}

  private async readRows(filter: UsageReadFilter, limit: number, offset: number) {
    const matches = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)}
      SELECT u.id, ${requestStateSql} AS request_state, m.matched_cost_cny,
        ARRAY(SELECT DISTINCT a.price_key FROM allocations a WHERE a.usage_log_id = u.id AND ${allocationWhere(filter)} AND a.price_key IS NOT NULL ORDER BY a.price_key) AS price_keys
      FROM scoped_usage u JOIN matched_requests m ON m.usage_log_id = u.id
      ORDER BY u.started_at DESC, u.id DESC LIMIT ${limit} OFFSET ${offset}`)
    if (matches.length > 5000) throw new BadRequestException('CSV export exceeds 5000 rows; narrow the filter range')
    if (!matches.length) return []
    const rows = await this.prisma.usageLog.findMany({ where: { id: { in: matches.map(row => row.id) } }, include })
    const byId = new Map(rows.map(row => [row.id, row]))
    return matches.flatMap(match => {
      const row = byId.get(match.id)
      return row ? [projectUsage(row, match.request_state, match.matched_cost_cny, match.price_keys)] : []
    })
  }

  @Get('logs') async logs(@Req() request: any, @Query() query: UsageQueryDto) {
    const { limit, offset } = paging(query)
    return this.readRows(resolveUsageFilter(request.principal, legacyRange(query), new Date(), 'logs'), limit, offset)
  }

  @Get('logs-page') async logsPage(@Req() request: any, @Query() query: UsageQueryDto) {
    const { limit, offset } = paging(query)
    const filter = resolveUsageFilter(request.principal, query, new Date(), 'logs')
    const totals = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter)} SELECT COUNT(*)::bigint AS total FROM matched_requests`)
    return { items: await this.readRows(filter, limit, offset), total: Number(totals[0]?.total ?? 0), limit, offset }
  }

  @Get('filter-options') options(@Req() request: any, @Query() query: UsageQueryDto) {
    return this.analytics.filterOptions(request.principal, query, 'logs')
  }

  @Get('export') @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="usage-logs.csv"') @Header('Cache-Control', 'no-store')
  async exportCsv(@Req() request: any, @Query() query: UsageQueryDto) {
    const rows = await this.readRows(resolveUsageFilter(request.principal, query, new Date(), 'logs'), 5001, 0)
    const columns = ['id', 'requestId', 'startedAt', 'finishedAt', 'accountId', 'employeeName', 'groupId', 'groupName', 'apiKeyId', 'keyName', 'keyHint',
      'credentialType', 'publicModelId', 'channelId', 'channelName', 'upstreamModel', 'inputTokens', 'cachedTokens', 'outputTokens', 'reasoningTokens',
      'matchedCostCny', 'costCny', 'usageSource', 'requestState', 'billingState', 'statusCode', 'errorCode', 'durationMs', 'firstTokenMs', 'routeAttempts', 'priceKeys'] as const
    return csvDocument([columns.map(key => key === 'costCny' ? 'requestCostCny' : key), ...rows.map(row => columns.map(key => {
      const value = row[key]
      return value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join('|') : String(value ?? '')
    }))])
  }

  @Get('logs/:id') async detail(@Req() request: any, @Param('id') id: string, @Query() query: UsageQueryDto): Promise<UsageDetail> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException('Usage log not found')
    const principal = request.principal
    const row = await this.prisma.usageLog.findFirst({ where: { id,
      ...(principal.role !== 'PLATFORM_ADMIN' ? { organizationId: principal.organizationId } : {}),
      ...(principal.role === 'MEMBER' ? { accountId: principal.sub } : {}) }, include })
    if (!row) throw new NotFoundException('Usage log not found')
    const filter = resolveUsageFilter(principal, legacyRange(query), new Date(), 'logs')
    const matches = await this.prisma.$queryRaw<any[]>(Prisma.sql`${usageReadCte(filter, undefined, row.id)}
      SELECT ${requestStateSql} AS request_state, m.matched_cost_cny,
        ARRAY(SELECT DISTINCT a.price_key FROM allocations a WHERE a.usage_log_id = u.id AND ${allocationWhere(filter)} AND a.price_key IS NOT NULL ORDER BY a.price_key) AS price_keys
      FROM usage_logs u LEFT JOIN matched_requests m ON m.usage_log_id = u.id WHERE u.id = ${row.id}::uuid`)
    const credentialId = row.credentialType === 'API_KEY' ? row.apiKeyId : row.deviceId
    const entry = row.groupId && credentialId ? await this.prisma.groupBudgetEntry.findFirst({ where: {
      organizationId: row.organizationId, groupId: row.groupId, accountId: row.accountId, requestId: row.requestId, kind: 'REQUEST',
      credentialType: row.credentialType, credentialId }, select: { status: true, reservedCny: true, settledCny: true, snapshot: true, reason: true } }) : null
    const billed = row.routes.filter(route => route.billingState !== null || route.costCny !== null)
    return { ...projectUsage(row, matches[0].request_state, matches[0].matched_cost_cny, matches[0].price_keys),
      unallocatedCostCny: billed.length ? new Decimal(row.costUsd.toString()).minus(billed.reduce((sum, route) => sum.plus(route.costCny?.toString() ?? 0), new Decimal(0))).toFixed(8) : '0.00000000',
      budget: entry ? projectBudgetEntry(entry) : null, budgetAvailability: entry ? 'AVAILABLE' : row.groupId ? 'NOT_FOUND' : 'NOT_APPLICABLE' }
  }

  @Get('summary') async summary(@Req() request: any, @Query() query: UsageQueryDto) {
    const historical = legacyRange(query), filter = resolveUsageFilter(request.principal, historical, new Date(), 'logs')
    const overview = await this.analytics.overview(request.principal, historical, 'logs')
    const logs = await this.prisma.$queryRaw<Array<{ public_model_id: string; started_at: Date }>>(Prisma.sql`${usageReadCte(filter)}
      SELECT u.public_model_id, u.started_at FROM scoped_usage u JOIN matched_requests m ON m.usage_log_id = u.id`)
    const models = new Map<string, number>()
    for (const log of logs) models.set(log.public_model_id, (models.get(log.public_model_id) ?? 0) + 1)
    return { ...overview, totalTokens: Number(overview.inputTokens) + Number(overview.outputTokens), matchedCostCny: overview.costCny,
      estimatedActiveMinutes: estimateActiveMinutes(logs.map(log => log.started_at.getTime())), topModel: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null }
  }
}
