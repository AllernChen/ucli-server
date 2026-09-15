import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import Decimal from 'decimal.js'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { estimateActiveMinutes } from '../../../packages/usage/src/analytics.js'
import { UsageQueryDto } from './analytics.dto.js'
import { Prisma } from '@prisma/client'

@ApiTags('usage') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/usage')
export class UsageController {
  constructor(private readonly prisma: PrismaService) {}
  private where(request: any, query: UsageQueryDto) {
    const where: any = request.principal.role === 'PLATFORM_ADMIN'
      ? (query.organizationId ? { organizationId: query.organizationId } : {})
      : { organizationId: request.principal.organizationId }
    if (request.principal.role === 'MEMBER') where.accountId = request.principal.sub
    else if (query.accountId) where.accountId = query.accountId
    if (query.groupId) where.groupId = query.groupId
    if (query.apiKeyId) where.apiKeyId = query.apiKeyId
    if (query.credentialType) where.credentialType = query.credentialType
    if (query.requestId) where.requestId = query.requestId
    if (query.model) where.publicModelId = query.model
    if (query.channelId) where.OR = [{ channelId: query.channelId }, { routes: { some: { channelId: query.channelId } } }]
    if (query.sessionId) where.sessionId = query.sessionId
    if (query.projectId) where.projectId = query.projectId
    if (query.start || query.end) where.startedAt = {
      ...(query.start ? { gte: new Date(query.start) } : {}), ...(query.end ? { lt: new Date(query.end) } : {})
    }
    return where
  }
  @Get('logs') async logs(@Req() request: any, @Query() query: UsageQueryDto) {
    const rows = await this.prisma.usageLog.findMany({ where: this.where(request, query), orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(200, Math.max(1, Number(query.limit) || 50)), skip: Math.max(0, Number(query.offset) || 0), include: {
        account: { select: { displayName: true, email: true } }, routes: { orderBy: { attempt: 'asc' }, include: { channel: { select: { name: true } } } },
        group: { select: { name: true } }, apiKey: { select: { name: true, secretHint: true } }, channel: { select: { name: true } }
      } })
    return rows.map(row => {
      const actor = row.actorSnapshot as Prisma.JsonObject | null, cost = row.costSnapshot as Prisma.JsonObject | null
      return { ...row, currency: 'CNY', costCny: new Decimal(String(row.costUsd ?? 0)).toFixed(8),
        employeeName: actor?.employeeName ?? row.account?.displayName ?? row.accountId,
        groupName: actor?.groupName ?? row.group?.name ?? '历史未归组', keyName: actor?.keyName ?? row.apiKey?.name ?? null,
        keyHint: actor?.keyHint ?? row.apiKey?.secretHint ?? null,
        billingState: cost?.billingState ?? (row.usageSource === 'ESTIMATED' ? 'ESTIMATED' : 'CONFIRMED') }
    })
  }
  @Get('summary') async summary(@Req() request: any, @Query() query: UsageQueryDto) {
    const logs = await this.prisma.usageLog.findMany({ where: this.where(request, query), select: {
      accountId: true, startedAt: true, inputTokens: true, outputTokens: true, costUsd: true,
      statusCode: true, publicModelId: true, costSnapshot: true,
      routes: { select: { channelId: true, costCny: true, billingState: true } }
    } })
    const requests = logs.length
    const modelCounts = new Map<string, number>()
    for (const log of logs) modelCounts.set(log.publicModelId, (modelCounts.get(log.publicModelId) || 0) + 1)
    const costCny = logs.reduce((sum, log) => {
      const billed = log.routes?.filter(r => r.billingState !== null || r.costCny !== null) ?? []
      return sum.plus(query.channelId && billed.length ? billed.filter(r => r.channelId === query.channelId).reduce((cost, r) => cost.plus(r.costCny?.toString() ?? 0), new Decimal(0)) : log.costUsd.toString())
    }, new Decimal(0)).toFixed(8)
    const unsettledRequests = logs.filter(log => (log.costSnapshot as Prisma.JsonObject | null)?.billingState === 'UNKNOWN').length
    return {
      requests, activeAccounts: new Set(logs.map(log => log.accountId)).size,
      totalTokens: logs.reduce((sum, log) => sum + Number(log.inputTokens + log.outputTokens), 0),
      costUsd: costCny, costCny, currency: 'CNY', unsettledRequests,
      successRate: requests ? logs.filter(log => log.statusCode < 400 && (log.costSnapshot as Prisma.JsonObject | null)?.billingState !== 'UNKNOWN').length / requests : 0,
      estimatedActiveMinutes: estimateActiveMinutes(logs.map(log => log.startedAt.getTime())),
      topModel: [...modelCounts].sort((a, b) => b[1] - a[1])[0]?.[0] || null
    }
  }
}
