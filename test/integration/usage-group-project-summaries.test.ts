import { describe, expect, it } from 'vitest'
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
})
