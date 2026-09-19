import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AnalyticsService } from '../../apps/api/src/analytics.service.js'
import { AnalyticsQueryDto } from '../../apps/api/src/analytics.dto.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from '../integration/database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('project analytics dimensions (PostgreSQL)', () => {
  it('aggregates new project logs and maps legacy source-group logs without trusting client projectId', async () => {
    await withTestDatabase(async db => {
      const { actor, organization, account } = await createOrganization(db)
      const region = await db.usageGroup.create({ data: {
        organizationId: organization.id, name: '广东-市局区域', type: 'REGION'
      } })
      const sourceGroupId = randomUUID()
      await db.usageGroup.create({ data: { id: sourceGroupId, organizationId: organization.id, name: '历史项目组', type: 'PROJECT' } })
      const project = await db.project.create({ data: {
        organizationId: organization.id, regionId: region.id, code: 'GD-YX', name: '越秀', sourceGroupId
      } })
      const channel = await db.channel.create({ data: {
        name: '成本渠道', provider: 'test', protocol: 'OPENAI', baseUrl: 'https://upstream.example'
      } })
      const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'GPT Test' } })
      const device = await db.device.create({ data: {
        organizationId: organization.id, accountId: account.id, name: 'Test CLI',
        refreshTokenHash: randomUUID()
      } })
      const base = {
        organizationId: organization.id, accountId: account.id, channelId: channel.id,
        credentialType: 'DEVICE' as const, deviceId: device.id,
        publicModelId: model.id, upstreamModel: 'upstream-model', protocol: 'OPENAI_CHAT' as const,
        startedAt: new Date('2026-09-01T00:00:00Z'), finishedAt: new Date('2026-09-01T00:00:01Z'),
        durationMs: 100, statusCode: 200, usageSource: 'UPSTREAM' as const, streaming: false,
        inputTokens: 10n, outputTokens: 5n, cachedTokens: 0n, reasoningTokens: 0n,
        costUsd: '1.00000000', routeAttempts: 1
      }
      await db.usageLog.create({ data: {
        ...base, requestId: randomUUID(), groupId: region.id, budgetProjectId: project.id,
        projectId: randomUUID()
      } })
      await db.usageLog.create({ data: {
        ...base, requestId: randomUUID(), groupId: sourceGroupId,
        projectId: randomUUID(), costUsd: '2.00000000'
      } })
      const service = new AnalyticsService(db as PrismaService)
      const result = await service.breakdown(actor, Object.assign(new AnalyticsQueryDto(), {
        start: '2026-08-31T16:00:00.000Z', end: '2026-09-30T16:00:00.000Z',
        timezone: 'Asia/Shanghai', dimension: 'project'
      }))
      expect(result.total).toBe(1)
      expect(result.items[0]).toMatchObject({ id: project.id, name: '越秀', requests: 2 })
      expect(result.items[0].costCny).toBe('3.00000000')
    })
  })
})
