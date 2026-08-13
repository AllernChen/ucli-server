import { Controller, Get, Header, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import { PrismaService } from '../../database/src/prisma.service.js'
import { registry } from './registry.js'

@Controller()
export class MetricsController implements OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 1, lazyConnect: true })
  constructor(private readonly prisma: PrismaService) {}
  @Get('healthz') async health() {
    await this.prisma.$queryRaw`SELECT 1`
    if (this.redis.status === 'wait') await this.redis.connect()
    await this.redis.ping()
    return { status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' }, timestamp: new Date().toISOString() }
  }
  @Get('metrics') @Header('content-type', registry.contentType) metrics() { return registry.metrics() }
  async onModuleDestroy() { if (this.redis.status !== 'end') await this.redis.quit() }
}
