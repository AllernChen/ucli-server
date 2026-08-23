import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { decryptSecret } from '../../../packages/security/src/envelope-crypto.js'
import { loadMasterKey } from '../../../packages/security/src/master-key.js'
import { renderOperationsReport } from '../../../packages/reports/src/operations-report.js'
import Decimal from 'decimal.js'
import { estimateActiveMinutes } from '../../../packages/usage/src/analytics.js'
import { ModelTestingService } from '../../api/src/model-testing.service.js'
import { validateModelDiscoveryUrl } from '../../../packages/gateway-core/src/model-discovery-url.js'

@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name)
  constructor(private readonly prisma: PrismaService, private readonly modelTesting: ModelTestingService) {}

  @Cron('0 * * * * *')
  async probeChannelModels() {
    const results = await this.modelTesting.testDueChannelModels()
    if (results.length) this.logger.log({ event: 'channel-model-probes', tested: results.length, failed: results.filter(item => !item.ok).length })
  }

  @Cron('0 10 3 * * *')
  async purgeChannelModelProbes() {
    const cutoff = new Date(Date.now() - 30 * 86_400_000)
    const deleted = await this.prisma.channelModelProbe.deleteMany({ where: { testedAt: { lt: cutoff } } })
    this.logger.log({ event: 'channel-model-probe-retention', cutoff, deleted: deleted.count })
  }

  @Cron('0 */5 * * * *')
  async probeChannels() {
    const channels = await this.prisma.channel.findMany({
      where: { enabled: true, deletedAt: null },
      include: {
        keys: { where: { deletedAt: null } },
        channelModels: { where: { deletedAt: null, publicModel: { deletedAt: null } } }
      }
    })
    for (const channel of channels) {
      const key = channel.keys.find(item => item.enabled && item.health !== 'DISABLED')
      const ability = channel.channelModels.find(item => item.enabled)
      if (!key || !ability) continue
      try {
        const base = channel.baseUrl.endsWith('/') ? channel.baseUrl : `${channel.baseUrl}/`
        const configuredDiscoveryUrl = channel.modelDiscoveryUrl
          ? validateModelDiscoveryUrl(channel.modelDiscoveryUrl, channel.baseUrl)
          : null
        const plaintext = decryptSecret({ algorithm: 'aes-256-gcm', ciphertext: key.ciphertext, iv: key.iv, tag: key.tag }, loadMasterKey())
        const headers: Record<string, string> = channel.protocol === 'ANTHROPIC'
          ? { 'x-api-key': plaintext, 'anthropic-version': '2023-06-01' }
          : channel.protocol === 'GEMINI' ? { 'x-goog-api-key': plaintext } : { authorization: `Bearer ${plaintext}` }
        const discoveryUrl = configuredDiscoveryUrl || (channel.protocol === 'GEMINI'
          ? new URL('v1beta/models', base)
          : new URL('v1/models', base))
        const response = await fetch(discoveryUrl, {
          headers, ...(configuredDiscoveryUrl ? { redirect: 'error' as const } : {})
        })
        const health = response.ok ? 'HEALTHY'
          : response.status === 401 || response.status === 403 ? 'UNHEALTHY' : 'DEGRADED'
        await this.prisma.channel.updateMany({ where: { id: channel.id, deletedAt: null }, data: {
          health, lastTestedAt: new Date(), circuitOpenUntil: null,
          ...(health === 'HEALTHY' ? { lastSuccessAt: new Date() } : {})
        } })
        if (health === 'UNHEALTHY' && channel.autoDisable) {
          await this.prisma.channelKey.update({ where: { id: key.id }, data: { health: 'DISABLED' } })
        }
      } catch {
        await this.prisma.channel.updateMany({ where: { id: channel.id, deletedAt: null }, data: {
          health: 'DEGRADED', lastTestedAt: new Date(), circuitOpenUntil: null
        } })
      }
    }
  }

  @Cron('0 10 * * * *')
  async aggregateHourly() {
    const end = new Date()
    end.setUTCMinutes(0, 0, 0)
    const start = new Date(end.getTime() - 60 * 60_000)
    const groups = await this.prisma.usageLog.groupBy({
      by: ['organizationId', 'accountId', 'publicModelId', 'channelId'],
      where: { startedAt: { gte: start, lt: end } },
      _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true }, _avg: { durationMs: true }
    })
    for (const group of groups) {
      const successes = await this.prisma.usageLog.count({ where: {
        organizationId: group.organizationId, accountId: group.accountId,
        publicModelId: group.publicModelId, channelId: group.channelId,
        startedAt: { gte: start, lt: end }, statusCode: { lt: 400 }
      } })
      await this.prisma.usageAggregate.upsert({ where: { bucket_bucketStart_organizationId_accountId_publicModelId_channelId: {
        bucket: 'hour', bucketStart: start, organizationId: group.organizationId, accountId: group.accountId,
        publicModelId: group.publicModelId, channelId: group.channelId
      } }, create: {
        bucket: 'hour', bucketStart: start, organizationId: group.organizationId, accountId: group.accountId,
        publicModelId: group.publicModelId, channelId: group.channelId, requests: group._count._all,
        successes, inputTokens: group._sum.inputTokens || 0, outputTokens: group._sum.outputTokens || 0,
        costUsd: group._sum.costUsd || 0, avgDurationMs: Math.round(group._avg.durationMs || 0)
      }, update: {
        requests: group._count._all, successes, inputTokens: group._sum.inputTokens || 0,
        outputTokens: group._sum.outputTokens || 0, costUsd: group._sum.costUsd || 0,
        avgDurationMs: Math.round(group._avg.durationMs || 0)
      } })
    }
  }

  @Cron('0 30 2 * * *')
  async enforceRetention() {
    const cutoff = new Date(Date.now() - Number(process.env.USAGE_RETENTION_DAYS || 90) * 86_400_000)
    const deleted = await this.prisma.usageLog.deleteMany({ where: { startedAt: { lt: cutoff } } })
    this.logger.log({ event: 'usage-retention', cutoff, deleted: deleted.count })
  }

  @Cron('0 15 1 * * *')
  async generateDailyReports() {
    const rangeEnd = new Date()
    rangeEnd.setUTCHours(0, 0, 0, 0)
    const rangeStart = new Date(rangeEnd.getTime() - 86_400_000)
    const organizations = await this.prisma.organization.findMany({ where: { enabled: true } })
    for (const organization of organizations) {
      const logs = await this.prisma.usageLog.findMany({ where: { organizationId: organization.id, startedAt: { gte: rangeStart, lt: rangeEnd } } })
      const requests = logs.length
      const models = new Map<string, number>()
      const hours = new Map<number, number>()
      for (const log of logs) {
        models.set(log.publicModelId, (models.get(log.publicModelId) || 0) + 1)
        hours.set(log.startedAt.getUTCHours(), (hours.get(log.startedAt.getUTCHours()) || 0) + 1)
      }
      const metrics = {
        title: '模型服务运营日报', rangeLabel: `${rangeStart.toISOString()} 至 ${rangeEnd.toISOString()}`,
        requests, activeAccounts: new Set(logs.map(log => log.accountId)).size,
        totalTokens: logs.reduce((sum, log) => sum + Number(log.inputTokens + log.outputTokens), 0),
        costUsd: logs.reduce((sum, log) => sum.plus(log.costUsd.toString()), new Decimal(0)).toFixed(8),
        successRate: requests ? logs.filter(log => log.statusCode < 400).length / requests : 0,
        estimatedActiveMinutes: estimateActiveMinutes(logs.map(log => log.startedAt.getTime())),
        peakHour: `${String([...hours].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0).padStart(2, '0')}:00 UTC`,
        topModel: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] || '无'
      }
      await this.prisma.report.create({ data: {
        period: 'DAY', scope: 'ORGANIZATION', scopeId: organization.id, organizationId: organization.id,
        rangeStart, rangeEnd, metrics, markdown: renderOperationsReport(metrics)
      } })
    }
  }
}
