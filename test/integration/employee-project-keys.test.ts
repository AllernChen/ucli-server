import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { EmployeeKeysService } from '../../apps/api/src/employee-keys.service.js'
import { ProjectsService } from '../../apps/api/src/projects.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('project-scoped employee API keys (PostgreSQL)', () => {
  it('issues a region key only for an active project in that region and exposes project options', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const region = await groups.create(actor, { name: '广东-省厅区域', type: 'REGION' })
      await groups.addMember(actor, region.id, account.id)
      const province = await projects.create(actor, { regionId: region.id, code: 'GD-PROV', name: '省厅' })
      await projects.create(actor, { regionId: region.id, code: 'GD-AIRPORT', name: '机场' })
      await projects.addMember(actor, province.id, { accountId: account.id, role: 'CONTRIBUTOR' })

      const options = await keys.projectOptions(actor, account.id, region.id)
      expect(options.map(item => item.code).sort()).toEqual(['GD-AIRPORT', 'GD-PROV'])

      const key = await keys.create(actor, account.id, {
        name: '广东-省厅区域-省厅-员工', projectId: province.id
      })
      expect(key).toMatchObject({ groupId: region.id, projectId: province.id })
      expect(key.project).toMatchObject({ id: province.id, code: 'GD-PROV', name: '省厅' })

      const stored = await db.employeeApiKey.findUniqueOrThrow({ where: { id: key.id } })
      expect(stored).toMatchObject({ groupId: region.id, projectId: province.id, revokedAt: null })
      const audits = await db.auditLog.findMany({ where: { resourceId: key.id } })
      expect(audits.length).toBeGreaterThan(0)
      expect(JSON.stringify(audits)).not.toContain(key.secret)

      const filtered = await keys.list(actor, account.id,
        Object.assign(new (await import('../../apps/api/src/employee-keys.dto.js')).EmployeeKeyQueryDto(), { projectId: province.id }))
      expect(filtered.items.map(item => item.id)).toEqual([key.id])
    })
  })

  it('requires an active same-region project for region keys', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const region = await groups.create(actor, { name: '广东-市局区域', type: 'REGION' })
      const otherRegion = await groups.create(actor, { name: '广东-东莞区域', type: 'REGION' })
      await groups.addMember(actor, region.id, account.id)
      await groups.addMember(actor, otherRegion.id, account.id)
      const project = await projects.create(actor, { regionId: otherRegion.id, code: 'GD-DG', name: '东莞' })
      await projects.addMember(actor, project.id, { accountId: account.id, role: 'CONTRIBUTOR' })

      await expect(keys.create(actor, account.id, { name: 'No project' } as never))
        .rejects.toMatchObject({ status: 400 })
      await expect(keys.create(actor, account.id, { name: 'Unknown project', projectId: randomUUID() }))
        .rejects.toMatchObject({ status: 404 })

      await db.project.update({ where: { id: project.id }, data: { status: 'SUSPENDED' } })
      await expect(keys.create(actor, account.id, { name: 'Suspended', projectId: project.id }))
        .rejects.toMatchObject({ status: 404 })
    })
  })

  it('rejects groupId-only issuance and requires an active project member', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const region = await groups.create(actor, { name: '广东-市局区域', type: 'REGION' })
      await groups.addMember(actor, region.id, account.id)
      const project = await projects.create(actor, { regionId: region.id, code: 'GD-SJ', name: '市局' })

      await expect(keys.create(actor, account.id, {
        name: '旧接口入参', groupId: region.id
      } as never)).rejects.toMatchObject({ status: 400 })
      await expect(keys.create(actor, account.id, {
        name: '未关联项目', projectId: project.id
      })).rejects.toMatchObject({ status: 403 })

      await projects.addMember(actor, project.id, { accountId: account.id, role: 'VIEWER' })
      await expect(keys.create(actor, account.id, {
        name: '观察者', projectId: project.id
      })).rejects.toMatchObject({ status: 403 })
    })
  })

  it('issues a department budget project key from organization membership', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const organizations = new (await import('../../apps/api/src/org-units.service.js')).OrgUnitsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const research = await organizations.create(actor, { name: '研发部', kind: 'FUNCTIONAL' })
      await organizations.addMember(actor, research.id, account.id)
      const project = await db.project.findFirstOrThrow({ where: { regionId: research.id, category: 'DEPARTMENT' } })

      await expect(keys.create(actor, account.id, {
        name: '研发部日常', projectId: project.id
      })).resolves.toMatchObject({ accountId: account.id, groupId: research.id, projectId: project.id })
    })
  })
})
