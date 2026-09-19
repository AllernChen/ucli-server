import { describe, expect, it } from 'vitest'
import { MeProjectsService } from '../../apps/api/src/me-projects.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { ProjectsService } from '../../apps/api/src/projects.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('my projects (PostgreSQL)', () => {
  it('returns only active projects in the caller’s active regions', async () => {
    await withTestDatabase(async db => {
      const { actor, account, organization } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const service = new MeProjectsService(db as PrismaService)
      const region = await groups.create(actor, { name: '江苏-苏州区域', type: 'REGION' })
      await groups.addMember(actor, region.id, account.id)
      const visible = await projects.create(actor, { regionId: region.id, code: 'JS-SZ', name: '苏州' })
      const hidden = await projects.create(actor, { regionId: region.id, code: 'JS-HIDDEN', name: '停用项目' })
      await db.project.update({ where: { id: hidden.id }, data: { status: 'SUSPENDED' } })
      const other = await groups.create(actor, { name: '不可见区域', type: 'REGION' })
      await projects.create(actor, { regionId: other.id, code: 'OTHER', name: '其它区域项目' })

      const items = await service.list({
        sub: account.id, organizationId: organization.id, role: 'MEMBER', tokenVersion: 1
      })
      expect(items.map(item => item.id)).toEqual([visible.id])
    })
  })
})
