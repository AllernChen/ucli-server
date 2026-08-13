import { Module } from '@nestjs/common'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { RedisQuotaService } from '../../../packages/quota/src/redis-quota.js'
import { MetricsController } from '../../../packages/monitoring/src/metrics.controller.js'
import { GatewayController } from './gateway.controller.js'
import { GatewayService } from './gateway.service.js'

@Module({ controllers: [GatewayController, MetricsController], providers: [PrismaService, AuthGuard, GatewayService, RedisQuotaService] })
export class GatewayModule {}
