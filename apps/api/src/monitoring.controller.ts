import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'

@ApiTags('monitoring') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/monitoring')
export class MonitoringController {
  constructor(private readonly prisma: PrismaService) {}
  @Get('health') async health() {
    const since = new Date(Date.now() - 60 * 60_000)
    const [channels, total, errors, latency] = await Promise.all([
      this.prisma.channel.findMany({ include: { keys: { select: { id: true, suffix: true, health: true, remainingUsd: true } } } }),
      this.prisma.usageLog.count({ where: { startedAt: { gte: since } } }),
      this.prisma.usageLog.count({ where: { startedAt: { gte: since }, statusCode: { gte: 400 } } }),
      this.prisma.usageLog.aggregate({ where: { startedAt: { gte: since } }, _avg: { durationMs: true, firstTokenMs: true } })
    ])
    return { timestamp: new Date(), windowMinutes: 60, totalRequests: total,
      successRate: total ? (total - errors) / total : 1, averageDurationMs: latency._avg.durationMs || 0,
      averageFirstTokenMs: latency._avg.firstTokenMs || 0, channels }
  }
}
