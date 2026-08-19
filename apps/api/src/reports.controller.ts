import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { renderOperationsReport } from '../../../packages/reports/src/operations-report.js'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { estimateActiveMinutes } from '../../../packages/usage/src/analytics.js'

@ApiTags('reports') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/reports')
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list(@Req() request: any, @Query() query: any) {
    const where = request.principal.role === 'PLATFORM_ADMIN' ? {} : request.principal.role === 'ORG_ADMIN'
      ? { organizationId: request.principal.organizationId }
      : { organizationId: request.principal.organizationId, accountId: request.principal.sub, scope: 'ACCOUNT' as const }
    return this.prisma.report.findMany({ where, orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, Number(query.limit) || 50)), skip: Math.max(0, Number(query.offset) || 0) })
  }
  @Post('generate') async generate(@Req() request: any, @Body() body: any) {
    if (request.principal.role === 'MEMBER' && (body.scope !== 'ACCOUNT' || (body.scopeId && body.scopeId !== request.principal.sub))) {
      throw new ForbiddenException('Members can only generate their own account reports')
    }
    const rangeStart = new Date(body.rangeStart)
    const rangeEnd = new Date(body.rangeEnd)
    const where: any = { startedAt: { gte: rangeStart, lt: rangeEnd } }
    if (body.scope === 'ORGANIZATION') {
      where.organizationId = request.principal.role === 'PLATFORM_ADMIN'
        ? (body.scopeId || request.principal.organizationId)
        : request.principal.organizationId
    } else if (body.scope !== 'PLATFORM' || request.principal.role !== 'PLATFORM_ADMIN') {
      where.organizationId = request.principal.organizationId
    }
    if (body.scope === 'ACCOUNT') {
      const targetAccountId = body.scopeId || request.principal.sub
      if (request.principal.role !== 'PLATFORM_ADMIN') {
        const membership = await this.prisma.membership.findUnique({ where: { organizationId_accountId: {
          organizationId: request.principal.organizationId, accountId: targetAccountId
        } } })
        if (!membership) throw new ForbiddenException('Account is outside your organization')
      }
      where.accountId = targetAccountId
    }
    if (body.scope === 'MODEL') where.publicModelId = body.scopeId
    if (body.scope === 'CHANNEL') where.channelId = body.scopeId
    const logs = await this.prisma.usageLog.findMany({ where })
    const requests = logs.length
    const models = new Map<string, number>()
    const hours = new Map<number, number>()
    for (const log of logs) {
      models.set(log.publicModelId, (models.get(log.publicModelId) || 0) + 1)
      hours.set(log.startedAt.getUTCHours(), (hours.get(log.startedAt.getUTCHours()) || 0) + 1)
    }
    const metrics = {
      title: `${body.period || 'DAY'} 运营报告`, rangeLabel: `${rangeStart.toISOString()} 至 ${rangeEnd.toISOString()}`,
      requests, activeAccounts: new Set(logs.map(log => log.accountId)).size,
      totalTokens: logs.reduce((sum, log) => sum + Number(log.inputTokens + log.outputTokens), 0),
      costUsd: logs.reduce((sum, log) => sum.plus(log.costUsd.toString()), new Decimal(0)).toFixed(8),
      successRate: requests ? logs.filter(log => log.statusCode < 400).length / requests : 0,
      estimatedActiveMinutes: estimateActiveMinutes(logs.map(log => log.startedAt.getTime())),
      peakHour: `${String([...hours].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0).padStart(2, '0')}:00 UTC`,
      topModel: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] || '无'
    }
    return this.prisma.report.create({ data: {
      period: body.period, scope: body.scope, scopeId: body.scopeId || null,
      organizationId: where.organizationId || null, accountId: where.accountId || null,
      publicModelId: where.publicModelId || null, channelId: where.channelId || null,
      rangeStart, rangeEnd, metrics, markdown: renderOperationsReport(metrics)
    } })
  }
}
