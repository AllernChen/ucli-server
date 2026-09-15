import { Controller, Get, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard, Roles, type AuthPrincipal } from '../../../packages/security/src/auth.js'
import { UsageGroupsService } from './usage-groups.service.js'
import { UsageGroupPageQueryDto } from './usage-groups.dto.js'
import { Prisma } from '@prisma/client'

@ApiTags('monitoring') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/monitoring')
export class MonitoringController {
  constructor(private readonly prisma: PrismaService, private readonly groups: UsageGroupsService) {}
  @Get('overview') async overview(@Req() request: { principal: AuthPrincipal }) {
    const now = new Date()
    const channelWhere: Prisma.ChannelWhereInput = { deletedAt: null, enabled: true, health: { in: ['DEGRADED', 'UNHEALTHY'] } }
    // Match the request-level UNKNOWN filter used by analytics and usage logs.
    const unsettledWhere: Prisma.UsageLogWhereInput = { costSnapshot: { path: ['billingState'], equals: 'UNKNOWN' }, startedAt: { lt: now } }
    const [channels, channelTotal, budgets, logs, unsettledTotal, earliest] = await Promise.all([
      this.prisma.channel.findMany({ where: channelWhere, take: 5, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, health: true } }),
      this.prisma.channel.count({ where: channelWhere }),
      this.groups.list(request.principal.organizationId, Object.assign(new UsageGroupPageQueryDto(), { budgetRisk: 'ATTENTION', status: 'active', limit: 5, offset: 0 })),
      this.prisma.usageLog.findMany({ where: unsettledWhere, take: 5, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, requestId: true, startedAt: true, costUsd: true,
          organization: { select: { name: true } }, account: { select: { displayName: true } }, group: { select: { name: true } } } }),
      this.prisma.usageLog.count({ where: unsettledWhere }),
      this.prisma.usageLog.aggregate({ where: unsettledWhere, _min: { startedAt: true } })
    ])
    return { timestamp: now.toISOString(), budgetOrganizationId: request.principal.organizationId,
      channels: { items: channels, total: channelTotal }, budgets: { items: budgets.items, total: budgets.total },
      unsettled: { items: logs.map(log => ({ id: log.id, requestId: log.requestId,
        label: `${log.organization.name} · ${log.group?.name || '历史未归组'} · ${log.account.displayName}`,
        costCny: log.costUsd.toFixed(8), startedAt: log.startedAt })), total: unsettledTotal,
        start: earliest._min.startedAt?.toISOString() ?? null, end: now.toISOString() } }
  }
  @Get('health') async health() {
    const since = new Date(Date.now() - 60 * 60_000)
    const [channels, total, errors, latency] = await Promise.all([
      this.prisma.channel.findMany({
        where: { deletedAt: null },
        include: { keys: { where: { deletedAt: null }, select: { id: true, suffix: true, health: true, remainingUsd: true } } }
      }),
      this.prisma.usageLog.count({ where: { startedAt: { gte: since } } }),
      this.prisma.usageLog.count({ where: { startedAt: { gte: since }, statusCode: { gte: 400 } } }),
      this.prisma.usageLog.aggregate({ where: { startedAt: { gte: since } }, _avg: { durationMs: true, firstTokenMs: true } })
    ])
    return { timestamp: new Date(), windowMinutes: 60, totalRequests: total,
      successRate: total ? (total - errors) / total : 1, averageDurationMs: latency._avg.durationMs || 0,
      averageFirstTokenMs: latency._avg.firstTokenMs || 0, channels }
  }
}
