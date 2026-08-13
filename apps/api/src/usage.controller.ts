import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { estimateActiveMinutes } from '../../../packages/usage/src/analytics.js'

@ApiTags('usage') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/usage')
export class UsageController {
  constructor(private readonly prisma: PrismaService) {}
  private where(request: any, query: any) {
    const where: any = request.principal.role === 'PLATFORM_ADMIN'
      ? (query.organizationId ? { organizationId: query.organizationId } : {})
      : { organizationId: request.principal.organizationId }
    if (request.principal.role === 'MEMBER') where.accountId = request.principal.sub
    else if (query.accountId) where.accountId = query.accountId
    if (query.model) where.publicModelId = query.model
    if (query.channelId) where.channelId = query.channelId
    if (query.sessionId) where.sessionId = query.sessionId
    if (query.projectId) where.projectId = query.projectId
    if (query.start || query.end) where.startedAt = {
      ...(query.start ? { gte: new Date(query.start) } : {}), ...(query.end ? { lt: new Date(query.end) } : {})
    }
    return where
  }
  @Get('logs') logs(@Req() request: any, @Query() query: any) {
    return this.prisma.usageLog.findMany({ where: this.where(request, query), orderBy: { startedAt: 'desc' },
      take: Math.min(200, Math.max(1, Number(query.limit) || 50)), include: { routes: true } })
  }
  @Get('summary') async summary(@Req() request: any, @Query() query: any) {
    const logs = await this.prisma.usageLog.findMany({ where: this.where(request, query), select: {
      accountId: true, startedAt: true, inputTokens: true, outputTokens: true, costUsd: true,
      statusCode: true, publicModelId: true
    } })
    const requests = logs.length
    const modelCounts = new Map<string, number>()
    for (const log of logs) modelCounts.set(log.publicModelId, (modelCounts.get(log.publicModelId) || 0) + 1)
    return {
      requests, activeAccounts: new Set(logs.map(log => log.accountId)).size,
      totalTokens: logs.reduce((sum, log) => sum + Number(log.inputTokens + log.outputTokens), 0),
      costUsd: logs.reduce((sum, log) => sum.plus(log.costUsd.toString()), new Decimal(0)).toFixed(8),
      successRate: requests ? logs.filter(log => log.statusCode < 400).length / requests : 0,
      estimatedActiveMinutes: estimateActiveMinutes(logs.map(log => log.startedAt.getTime())),
      topModel: [...modelCounts].sort((a, b) => b[1] - a[1])[0]?.[0] || null
    }
  }
}
