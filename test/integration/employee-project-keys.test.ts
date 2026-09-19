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

      const options = await keys.projectOptions(actor, account.id, region.id)
      expect(options.map(item => item.code).sort()).toEqual(['GD-AIRPORT', 'GD-PROV'])

      const key = await keys.create(actor, account.id, {
        name: '广东-省厅区域-省厅-员工', groupId: region.id, projectId: province.id
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

      await expect(keys.create(actor, account.id, { name: 'No project', groupId: region.id }))
        .rejects.toMatchObject({ status: 400 })
      await expect(keys.create(actor, account.id, {
        name: 'Wrong region', groupId: region.id, projectId: project.id
      })).rejects.toMatchObject({ status: 404 })

      await db.project.update({ where: { id: project.id }, data: { status: 'SUSPENDED' } })
      await expect(keys.create(actor, account.id, {
        name: 'Suspended', groupId: otherRegion.id, projectId: project.id
      })).rejects.toMatchObject({ status: 404 })
    })
  })

  it('keeps legacy non-region keys compatible and rejects project binding on them', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const group = await groups.create(actor, { name: '历史项目组', type: 'PROJECT' })
      await groups.addMember(actor, group.id, account.id)

      await expect(keys.create(actor, account.id, {
        name: 'Invalid binding', groupId: group.id, projectId: randomUUID()
      })).rejects.toMatchObject({ status: 400 })

      const legacy = await keys.create(actor, account.id, { name: 'Legacy CLI', groupId: group.id })
      expect(legacy.projectId).toBeNull()
      expect(legacy.project).toBeNull()
    })
  })

  it('does not require ProjectMember because region membership grants project key eligibility', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const region = await groups.create(actor, { name: '北京-GAB区域', type: 'REGION' })
      await groups.addMember(actor, region.id, account.id)
      const project = await projects.create(actor, { regionId: region.id, code: 'BJ-GAB', name: 'GAB' })

      expect(await db.projectMember.count({ where: { projectId: project.id } })).toBe(0)
      await expect(keys.create(actor, account.id, {
        name: '北京-GAB区域-GAB-员工', groupId: region.id, projectId: project.id
      })).resolves.toMatchObject({ accountId: account.id, projectId: project.id })
    })
  })
})
