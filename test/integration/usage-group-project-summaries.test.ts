import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { EmployeeKeysService } from '../../apps/api/src/employee-keys.service.js'
import { ProjectsService } from '../../apps/api/src/projects.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'
import { UsageGroupPageQueryDto } from '../../apps/api/src/usage-groups.dto.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('usage group project summaries (PostgreSQL)', () => {
  it('returns project counts, budgets, owners and active keys for each region', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const region = await groups.create(actor, { name: '广东-市局区域', type: 'REGION' })
      await groups.addMember(actor, region.id, account.id)
      const yuexiu = await projects.create(actor, { regionId: region.id, code: 'GD-YX', name: '越秀' })
      const huangpu = await projects.create(actor, { regionId: region.id, code: 'GD-HP', name: '黄埔' })
      await projects.addMember(actor, yuexiu.id, { accountId: account.id, role: 'OWNER' })
      await db.projectBudgetPeriod.create({ data: {
        organizationId: actor.organizationId, projectId: yuexiu.id, periodKey: 'TOTAL',
        timezone: 'Asia/Shanghai', limitCny: '1800', spentCny: '200', reservedCny: '100'
      } })
      await keys.create(actor, account.id, {
        name: '广东-市局区域-越秀-负责人', groupId: region.id, projectId: yuexiu.id
      })

      const result = await groups.list(actor.organizationId, Object.assign(new UsageGroupPageQueryDto(), { type: 'REGION' }))
      const summary = result.items.find(item => item.id === region.id)
      const projectSummaries = summary?.projects ?? []
      expect(projectSummaries).toHaveLength(2)
      const yuexiuSummary = projectSummaries.find(project => project.id === yuexiu.id)
      expect(yuexiuSummary).toMatchObject({
        code: 'GD-YX', name: '越秀', memberCount: 1, activeKeyCount: 1,
        owners: [{ accountId: account.id, displayName: 'Test employee' }]
      })
      expect(yuexiuSummary?.budget).toMatchObject({
        limitCny: '1800.00000000', spentCny: '200.00000000',
        reservedCny: '100.00000000', availableCny: '1500.00000000'
      })
      expect(projectSummaries.find(project => project.id === huangpu.id)).toMatchObject({
        memberCount: 0, activeKeyCount: 0, owners: []
      })
    })
  })

  it('returns region projects and enriches members with project ownership and recent usage', async () => {
    vi.stubEnv('MASTER_KEY', Buffer.alloc(32, 8).toString('base64'))
    await withTestDatabase(async db => {
      const { actor, account, organization } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const region = await groups.create(actor, { name: '贵州区域', type: 'REGION' })
      await groups.addMember(actor, region.id, account.id)
      const yuexiu = await projects.create(actor, { regionId: region.id, code: 'GZ-YX', name: '云岩' })
      const huangpu = await projects.create(actor, { regionId: region.id, code: 'GZ-HB', name: '花溪' })
      await projects.addMember(actor, yuexiu.id, { accountId: account.id, role: 'OWNER' })
      const key = await keys.create(actor, account.id, { name: '花溪 Key', groupId: region.id, projectId: huangpu.id })

      const channel = await db.channel.create({ data: { name: 'Usage channel', provider: 'test', protocol: 'OPENAI', baseUrl: 'https://upstream.example' } })
      const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Usage model' } })
      const now = new Date()
      await db.usageLog.create({ data: {
        requestId: randomUUID(), organizationId: organization.id, accountId: account.id, groupId: region.id,
        apiKeyId: key.id, budgetProjectId: huangpu.id, projectId: randomUUID(), credentialType: 'API_KEY',
        publicModelId: model.id, upstreamModel: 'upstream-model', channelId: channel.id, protocol: 'OPENAI_CHAT',
        startedAt: now, finishedAt: new Date(now.getTime() + 100), durationMs: 100, statusCode: 200,
        usageSource: 'UPSTREAM', streaming: false, inputTokens: 10n, outputTokens: 5n, costUsd: '1.50000000'
      } })

      await expect(groups.projects(actor.organizationId, region.id)).resolves.toMatchObject({
        items: [
          expect.objectContaining({ id: yuexiu.id, code: 'GZ-YX', name: '云岩', memberCount: 1 }),
          expect.objectContaining({ id: huangpu.id, code: 'GZ-HB', name: '花溪', activeKeyCount: 1 })
        ]
      })
      const memberResult = await groups.members(actor.organizationId, region.id)
      expect(memberResult.items).toHaveLength(1)
      expect(memberResult.items[0].accountId).toBe(account.id)
      expect(memberResult.items[0].projects).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: yuexiu.id, sources: ['MEMBER'] }),
        expect.objectContaining({ id: huangpu.id, sources: ['KEY'] })
      ]))
      expect(memberResult.items[0].usage).toMatchObject({ requests: 1, totalTokens: '15', costCny: '1.50000000' })
    })
  })
})
