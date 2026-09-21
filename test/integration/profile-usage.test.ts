import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { ProfileUsageService } from '../../apps/api/src/profile-usage.service.js'
import { AnalyticsService } from '../../apps/api/src/analytics.service.js'
import { AnalyticsQueryDto } from '../../apps/api/src/analytics.dto.js'
import { createOrganization, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('profile usage (PostgreSQL)', () => {
  it('summarizes accessible project budgets, own project usage, and every own key with shares', async () => {
    await withTestDatabase(async db => {
      const { actor, organization, account } = await createOrganization(db)
      const channel = await db.channel.create({ data: { name: 'Profile channel', provider: 'test', protocol: 'OPENAI', baseUrl: 'https://upstream.example' } })
      const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Profile model' } })
      const region = await db.usageGroup.create({ data: { organizationId: organization.id, name: '广东-省厅区域', type: 'REGION', orgType: 'REGION' } })
      await db.groupMember.create({ data: { organizationId: organization.id, groupId: region.id, accountId: account.id, isPrimary: true } })
      const project = await db.project.create({ data: { organizationId: organization.id, regionId: region.id, code: 'PROFILE-P1', name: '省厅项目', category: 'BUSINESS' } })
      await db.projectMember.create({ data: { organizationId: organization.id, projectId: project.id, accountId: account.id, role: 'CONTRIBUTOR' } })
      await db.projectBudgetPeriod.create({ data: {
        organizationId: organization.id, projectId: project.id, periodKey: 'TOTAL', timezone: 'Asia/Shanghai',
        unlimited: false, limitCny: '100', spentCny: '5', reservedCny: '3'
      } })
      const keyOne = await db.employeeApiKey.create({ data: {
        organizationId: organization.id, groupId: region.id, accountId: account.id, projectId: project.id,
        name: 'CLI A', secretHash: randomUUID(), secretHint: '…aaaa', createdById: account.id
      } })
      const keyTwo = await db.employeeApiKey.create({ data: {
        organizationId: organization.id, groupId: region.id, accountId: account.id, projectId: project.id,
        name: 'CLI B', secretHash: randomUUID(), secretHint: '…bbbb', createdById: account.id
      } })
      const at = new Date('2026-09-20T02:00:00Z')
      const base = {
        organizationId: organization.id, accountId: account.id, groupId: region.id, credentialType: 'API_KEY' as const,
        publicModelId: model.id, upstreamModel: 'upstream-model', channelId: channel.id, protocol: 'OPENAI_CHAT' as const,
        startedAt: at, finishedAt: at, durationMs: 20, statusCode: 200, usageSource: 'UPSTREAM' as const, streaming: false,
        cachedTokens: 0n, reasoningTokens: 0n, routeAttempts: 1, budgetProjectId: project.id
      }
      await db.usageLog.create({ data: { ...base, apiKeyId: keyOne.id, requestId: randomUUID(), inputTokens: 10n, outputTokens: 2n, costUsd: '1' } })
      await db.usageLog.create({ data: { ...base, apiKeyId: keyTwo.id, requestId: randomUUID(), inputTokens: 20n, outputTokens: 4n, costUsd: '3' } })

      const service = new ProfileUsageService(db as PrismaService, new AnalyticsService(db as PrismaService))
      const result = await service.summary(actor, Object.assign(new AnalyticsQueryDto(), {
        start: '2026-09-20T00:00:00.000Z', end: '2026-09-21T00:00:00.000Z', timezone: 'Asia/Shanghai'
      }))

      expect(result.summary).toMatchObject({
        projectCount: 1, keyCount: 2, activeKeyCount: 2, unlimitedProjectCount: 0,
        totalLimitCny: '100.00000000', totalSpentCny: '5.00000000', totalReservedCny: '3.00000000',
        totalOccupiedCny: '8.00000000', totalAvailableCny: '92.00000000', totalUsagePercent: 8,
        ownUsagePercentOfTotalBudget: 4, ownUsage: { requests: 2, totalTokens: '36', costCny: '4.00000000' }
      })
      expect(result.projects).toHaveLength(1)
      expect(result.projects[0]).toMatchObject({
        id: project.id, name: '省厅项目', budget: { limitCny: '100.00000000', usagePercent: 8 },
        usage: { requests: 2, totalTokens: '36', costCny: '4.00000000' },
        shares: { budgetPercent: 4, projectUsagePercent: 50 }
      })
      expect(result.keys.map(key => key.name)).toEqual(['CLI A', 'CLI B'])
      expect(result.keys[0]).toMatchObject({ usage: { requests: 1, totalTokens: '12', costCny: '1.00000000' }, shares: { ownUsagePercent: 25, projectBudgetPercent: 1 } })
      expect(result.keys[1]).toMatchObject({ usage: { requests: 1, totalTokens: '24', costCny: '3.00000000' }, shares: { ownUsagePercent: 75, projectBudgetPercent: 3 } })
    })
  })
})
