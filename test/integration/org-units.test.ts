import { describe, expect, it } from 'vitest'
import { OrgUnitsService } from '../../apps/api/src/org-units.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'
import { OrgUnitPageQueryDto } from '../../apps/api/src/org-units.dto.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('organization units (PostgreSQL)', () => {
  it('lists organization kinds and creates department budget projects automatically', async () => {
    await withTestDatabase(async db => {
      const { actor } = await createOrganization(db)
      const service = new OrgUnitsService(db as PrismaService)
      const executive = await service.create(actor, { name: '公司经营层', kind: 'EXECUTIVE' })
      const research = await service.create(actor, { name: '研发部', kind: 'FUNCTIONAL' })
      const region = await service.create(actor, { name: '广东-市局', kind: 'REGION' })

      expect(executive.orgType).toBe('EXECUTIVE')
      expect(research.orgType).toBe('FUNCTIONAL')
      expect(region.orgType).toBe('REGION')
      expect(await db.project.count({ where: { regionId: executive.id, category: 'DEPARTMENT' } })).toBe(1)
      expect(await db.project.count({ where: { regionId: research.id, category: 'DEPARTMENT' } })).toBe(1)
      expect(await db.project.count({ where: { regionId: region.id, category: 'DEPARTMENT' } })).toBe(0)

      const functional = await service.list(actor.organizationId, Object.assign(new OrgUnitPageQueryDto(), { kind: 'FUNCTIONAL' }))
      expect(functional.items.map(item => item.name)).toEqual(['研发部'])
      const detail = await service.detail(actor.organizationId, executive.id)
      expect(detail.departmentProject?.category).toBe('DEPARTMENT')
    })
  })

  it('keeps legacy project organizations read-only and requires administrators for mutations', async () => {
    await withTestDatabase(async db => {
      const { actor } = await createOrganization(db)
      const service = new OrgUnitsService(db as PrismaService)
      const legacy = await db.usageGroup.create({ data: {
        organizationId: actor.organizationId, name: '历史项目组', type: 'PROJECT', orgType: 'LEGACY_PROJECT'
      } })

      await expect(service.update(actor, legacy.id, { name: '新名称' })).rejects.toMatchObject({ status: 409 })
      await expect(service.create({ ...actor, role: 'MEMBER' }, { name: '新组织', kind: 'REGION' }))
        .rejects.toMatchObject({ status: 403 })
      await expect(service.update(actor, legacy.id, { description: '历史说明' })).rejects.toMatchObject({ status: 409 })

      const legacyService = new UsageGroupsService(db as PrismaService)
      expect((await legacyService.create(actor, { name: '旧接口历史项目组', type: 'PROJECT' })).orgType)
        .toBe('LEGACY_PROJECT')
    })
  })
})
