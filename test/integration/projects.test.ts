import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectsService } from '../../apps/api/src/projects.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { OrgUnitsService } from '../../apps/api/src/org-units.service.js'
import { UsageGroupPageQueryDto } from '../../apps/api/src/usage-groups.dto.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('project management (PostgreSQL)', () => {
  it('exposes administrator routes with UUID validation', () => {
    const controller = readFileSync(join(process.cwd(), 'apps/api/src/projects.controller.ts'), 'utf8')
    expect(controller).toContain("@Roles('PLATFORM_ADMIN', 'ORG_ADMIN')")
    expect(controller).toContain("@Controller('api/v1/admin/projects')")
    for (const route of [
      "@Get()", "@Post()", "@Get(':id')", "@Patch(':id')",
      "@Post(':id/disable')", "@Post(':id/enable')", "@Post(':id/archive')",
      "@Get(':id/members')", "@Post(':id/members')",
      "@Patch(':id/members/:accountId')", "@Delete(':id/members/:accountId')"
    ]) expect(controller).toContain(route)
    expect((controller.match(/Param\('id', UuidPipe\)/g) ?? []).length).toBeGreaterThanOrEqual(8)
    expect((controller.match(/Param\('accountId', UuidPipe\)/g) ?? []).length).toBe(2)
  })

  it('creates projects under an active region and lists them with the region', async () => {
    await withTestDatabase(async db => {
      const { actor } = await createOrganization(db)
      const region = await db.usageGroup.create({ data: {
        organizationId: actor.organizationId, name: '广东-省厅区域', type: 'REGION'
      } })
      const service = new ProjectsService(db as PrismaService)

      const project = await service.create(actor, {
        regionId: region.id, code: 'GD-PROV-SLT', name: '省厅', description: '省厅区域主项目'
      })

      expect(project).toMatchObject({
        regionId: region.id, code: 'GD-PROV-SLT', name: '省厅', status: 'ACTIVE'
      })
      expect((await service.list(actor, {})).items.map(item => item.id)).toEqual([project.id])

      const groups = new UsageGroupsService(db as PrismaService)
      const regions = await groups.list(actor.organizationId, Object.assign(new UsageGroupPageQueryDto(), { type: 'REGION' }))
      expect(regions.items[0].projects).toEqual([expect.objectContaining({
        id: project.id, regionId: region.id, code: 'GD-PROV-SLT', name: '省厅', status: 'ACTIVE'
      })])
    })
  })

  it('uses an organization owner, filters categories, and allows explicit cross-department collaborators', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const organizations = new OrgUnitsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const region = await organizations.create(actor, { name: '广东-市局', kind: 'REGION' })
      const engineering = await organizations.create(actor, { name: '工程部', kind: 'FUNCTIONAL' })

      const project = await projects.create(actor, {
        ownerOrgUnitId: region.id, category: 'BUSINESS', code: 'ORG-OWNER', name: '组织归属项目'
      })
      expect(project).toMatchObject({ regionId: region.id, category: 'BUSINESS' })
      expect((await projects.list(actor, { ownerOrgUnitId: region.id, category: 'BUSINESS' })).items.map(item => item.id))
        .toEqual([project.id])

      await expect(projects.create(actor, {
        ownerOrgUnitId: engineering.id, category: 'DEPARTMENT', code: 'MANUAL-DEPT', name: '手工部门项目'
      })).rejects.toMatchObject({ status: 409 })

      await organizations.addMember(actor, engineering.id, account.id)
      await projects.addMember(actor, project.id, { accountId: account.id, role: 'CONTRIBUTOR' })
      const detail = await projects.detail(actor, project.id)
      expect(detail.members).toHaveLength(1)
      await expect(projects.addMember(actor, (await db.project.findFirstOrThrow({
        where: { regionId: engineering.id, category: 'DEPARTMENT' }
      })).id, { accountId: account.id, role: 'CONTRIBUTOR' })).rejects.toMatchObject({ status: 409 })
    })
  })

  it('rejects unavailable regions and duplicate project identities inside an organization', async () => {
    await withTestDatabase(async db => {
      const { actor } = await createOrganization(db)
      const other = await createOrganization(db)
      const service = new ProjectsService(db as PrismaService)
      const region = await db.usageGroup.create({ data: {
        organizationId: actor.organizationId, name: '有效区域', type: 'REGION'
      } })

      const unavailable = async (data: { enabled?: boolean; archivedAt?: Date; type?: 'PROJECT' }) => {
        const group = await db.usageGroup.create({ data: {
          organizationId: actor.organizationId, name: `区域-${randomUUID()}`, type: data.type ?? 'REGION',
          enabled: data.enabled ?? true, archivedAt: data.archivedAt ?? null
        } })
        await expect(service.create(actor, { regionId: group.id, code: `X-${randomUUID().slice(0, 8)}`, name: `项目-${randomUUID()}` }))
          .rejects.toMatchObject({ status: 404 })
      }
      await unavailable({ type: 'PROJECT' })
      await unavailable({ enabled: false })
      await unavailable({ archivedAt: new Date() })
      const foreign = await db.usageGroup.create({ data: { organizationId: other.actor.organizationId, name: '外组织区域', type: 'REGION' } })
      await expect(service.create(actor, { regionId: foreign.id, code: 'FOREIGN', name: '外组织项目' }))
        .rejects.toMatchObject({ status: 404 })

      await service.create(actor, { regionId: region.id, code: 'SAME-CODE', name: '第一个' })
      await expect(service.create(actor, { regionId: region.id, code: 'SAME-CODE', name: '第二个' }))
        .rejects.toMatchObject({ status: 409 })
      await expect(service.create(actor, { regionId: region.id, code: 'OTHER-CODE', name: '第一个' }))
        .rejects.toMatchObject({ status: 409 })
    })
  })

  it('reads region availability from the project creation transaction', async () => {
    await withTestDatabase(async db => {
      const { actor } = await createOrganization(db)
      const region = await db.usageGroup.create({ data: {
        organizationId: actor.organizationId, name: '并发区域', type: 'REGION'
      } })
      const transactionScopedClient = {
        usageGroup: db.usageGroup,
        $transaction: async <T>(run: (db: unknown) => Promise<T>) =>
          db.$transaction(async tx => run({
            usageGroup: { findFirst: () => Promise.resolve(null) },
            $queryRaw: () => Promise.resolve([]),
            project: tx.project,
            auditLog: tx.auditLog
          }))
      } as unknown as PrismaService
      const service = new ProjectsService(transactionScopedClient)

      await expect(service.create(actor, { regionId: region.id, code: 'TX-REGION', name: '事务区域项目' }))
        .rejects.toMatchObject({ status: 404 })
      expect(await db.project.count({ where: { organizationId: actor.organizationId } })).toBe(0)
    })
  })

  it('scopes project reads and updates to the actor organization and administrator role', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const other = await createOrganization(db)
      const service = new ProjectsService(db as PrismaService)
      const region = await db.usageGroup.create({ data: { organizationId: actor.organizationId, name: '区域', type: 'REGION' } })
      const project = await service.create(actor, { regionId: region.id, code: 'GD-PROV-SLT', name: '省厅' })

      const detail = await service.detail(actor, project.id)
      expect(detail.region).toMatchObject({ id: region.id, name: '区域' })
      expect(detail.members).toEqual([])

      await expect(service.detail(other.actor, project.id)).rejects.toMatchObject({ status: 404 })
      await expect(service.update(other.actor, project.id, { name: '外组织' })).rejects.toMatchObject({ status: 404 })

      const updated = await service.update(actor, project.id, { name: '省厅主项目', description: '更新后的描述' })
      expect(updated).toMatchObject({ id: project.id, name: '省厅主项目', description: '更新后的描述' })

      const memberPrincipal = { organizationId: actor.organizationId, sub: account.id, role: 'MEMBER' as const, tokenVersion: 1 }
      await db.groupMember.create({ data: { organizationId: actor.organizationId, groupId: region.id, accountId: account.id } })
      await expect(service.list(memberPrincipal, {})).resolves.toMatchObject({ items: [{ id: project.id }] })
      await expect(service.create(memberPrincipal, { regionId: region.id, code: 'NO-AUTH', name: '无权限' }))
        .rejects.toMatchObject({ status: 403 })
      await expect(service.update(memberPrincipal, project.id, { name: '无权限' })).rejects.toMatchObject({ status: 403 })
      await expect(service.setStatus(memberPrincipal, project.id, 'SUSPENDED')).rejects.toMatchObject({ status: 403 })
    })
  })

  it('makes active region projects visible to every region member without project membership', async () => {
    await withTestDatabase(async db => {
      const { actor, organization } = await createOrganization(db)
      const service = new ProjectsService(db as PrismaService)
      const region = await db.usageGroup.create({ data: { organizationId: organization.id, name: '广东区域', type: 'REGION' } })
      const otherRegion = await db.usageGroup.create({ data: { organizationId: organization.id, name: '上海区域', type: 'REGION' } })
      const gd = await service.create(actor, { regionId: region.id, code: 'GD-001', name: '广东项目' })
      const sh = await service.create(actor, { regionId: otherRegion.id, code: 'SH-001', name: '上海项目' })

      const employee = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: '区域成员' } })
      const outsider = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: '组织成员' } })
      for (const user of [employee, outsider]) {
        await db.membership.create({ data: { organizationId: organization.id, accountId: user.id, role: 'MEMBER' } })
      }
      await db.groupMember.create({ data: { organizationId: organization.id, groupId: region.id, accountId: employee.id } })

      const employeePrincipal = { organizationId: organization.id, sub: employee.id, role: 'MEMBER' as const, tokenVersion: 1 }
      const outsiderPrincipal = { organizationId: organization.id, sub: outsider.id, role: 'MEMBER' as const, tokenVersion: 1 }
      expect((await service.list(employeePrincipal, {})).items.map(item => item.id)).toEqual([gd.id])
      expect((await service.list(employeePrincipal, { regionId: otherRegion.id })).items).toEqual([])
      expect((await service.list(outsiderPrincipal, {})).items).toEqual([])
      await expect(service.detail(employeePrincipal, gd.id)).resolves.toMatchObject({ id: gd.id })
      await expect(service.detail(employeePrincipal, sh.id)).rejects.toMatchObject({ status: 404 })
      expect((await service.list(actor, { q: '上海' })).items.map(item => item.id)).toEqual([sh.id])
    })
  })

  it('requires project members to be active members of the project region', async () => {
    await withTestDatabase(async db => {
      const { actor, organization, account } = await createOrganization(db)
      const service = new ProjectsService(db as PrismaService)
      const region = await db.usageGroup.create({ data: { organizationId: organization.id, name: '区域', type: 'REGION' } })
      const project = await service.create(actor, { regionId: region.id, code: 'GD-PROV-SLT', name: '省厅' })
      await db.groupMember.create({ data: { organizationId: organization.id, groupId: region.id, accountId: account.id } })

      const employee = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: '区域成员' } })
      const organizationOnly = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: '非区域成员' } })
      await db.membership.create({ data: { organizationId: organization.id, accountId: employee.id, role: 'MEMBER' } })
      await db.membership.create({ data: { organizationId: organization.id, accountId: organizationOnly.id, role: 'MEMBER' } })
      await db.groupMember.create({ data: { organizationId: organization.id, groupId: region.id, accountId: employee.id } })

      await expect(service.addMember(actor, project.id, { accountId: organizationOnly.id, role: 'CONTRIBUTOR' }))
        .rejects.toMatchObject({ status: 403 })
      await expect(service.addMember(actor, project.id, { accountId: randomUUID(), role: 'VIEWER' }))
        .rejects.toMatchObject({ status: 403 })

      await expect(service.addMember(actor, project.id, { accountId: employee.id, role: 'OWNER' }))
        .resolves.toMatchObject({ accountId: employee.id, role: 'OWNER' })
      await expect((await service.members(actor, project.id)).items).toHaveLength(1)
      await expect(service.setMemberRole(actor, project.id, employee.id, 'VIEWER'))
        .resolves.toMatchObject({ accountId: employee.id, role: 'VIEWER' })
      await expect(service.removeMember(actor, project.id, employee.id))
        .resolves.toMatchObject({ accountId: employee.id })
      await expect(service.members(actor, project.id)).resolves.toMatchObject({ total: 0 })

      await db.groupMember.update({ where: { groupId_accountId: { groupId: region.id, accountId: account.id } }, data: { removedAt: new Date() } })
      await expect(service.addMember(actor, project.id, { accountId: account.id, role: 'VIEWER' }))
        .rejects.toMatchObject({ status: 403 })
    })
  })

  it('rejects adding and updating members of archived projects', async () => {
    await withTestDatabase(async db => {
      const { actor, organization, account } = await createOrganization(db)
      const service = new ProjectsService(db as PrismaService)
      const region = await db.usageGroup.create({ data: { organizationId: organization.id, name: '区域', type: 'REGION' } })
      const project = await service.create(actor, { regionId: region.id, code: 'GD-ARCHIVED', name: '归档项目' })
      const employee = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: '新成员' } })
      await db.membership.create({ data: { organizationId: organization.id, accountId: employee.id, role: 'MEMBER' } })
      await db.groupMember.create({ data: { organizationId: organization.id, groupId: region.id, accountId: account.id } })
      await db.groupMember.create({ data: { organizationId: organization.id, groupId: region.id, accountId: employee.id } })
      await service.addMember(actor, project.id, { accountId: account.id, role: 'OWNER' })

      await service.setStatus(actor, project.id, 'ARCHIVED')
      await expect(service.addMember(actor, project.id, { accountId: account.id, role: 'VIEWER' }))
        .rejects.toMatchObject({ status: 409 })
      await expect(service.addMember(actor, project.id, { accountId: employee.id, role: 'CONTRIBUTOR' }))
        .rejects.toMatchObject({ status: 409 })
      expect((await service.members(actor, project.id)).items).toMatchObject([
        { accountId: account.id, role: 'OWNER' }
      ])
    })
  })

  it('changes project status and rejects archiving unsettled or reserved budget entries', async () => {
    await withTestDatabase(async db => {
      const { actor, organization } = await createOrganization(db)
      const service = new ProjectsService(db as PrismaService)
      const region = await db.usageGroup.create({ data: { organizationId: organization.id, name: '区域', type: 'REGION' } })
      const project = await service.create(actor, { regionId: region.id, code: 'GD-PROV-SLT', name: '省厅' })

      await expect(service.setStatus(actor, project.id, 'SUSPENDED')).resolves.toMatchObject({ id: project.id, status: 'SUSPENDED' })
      const groups = new UsageGroupsService(db as PrismaService)
      const regionList = await groups.list(organization.id, Object.assign(new UsageGroupPageQueryDto(), { type: 'REGION' }))
      expect(regionList.items[0].projects).toEqual([])
      await expect(service.setStatus(actor, project.id, 'ACTIVE')).resolves.toMatchObject({ id: project.id, status: 'ACTIVE' })
      const enabledRegions = await groups.list(organization.id, Object.assign(new UsageGroupPageQueryDto(), { type: 'REGION' }))
      expect(enabledRegions.items[0].projects).toEqual([expect.objectContaining({
        id: project.id, regionId: region.id, code: 'GD-PROV-SLT', name: '省厅', status: 'ACTIVE'
      })])

      const period = await db.projectBudgetPeriod.create({ data: { organizationId: organization.id, projectId: project.id,
        periodKey: 'TOTAL', timezone: 'Asia/Shanghai' } })
      const entry = await db.projectBudgetEntry.create({ data: { organizationId: organization.id, projectId: project.id,
        periodId: period.id, operationId: randomUUID(), kind: 'REQUEST', status: 'RESERVED',
        requestId: randomUUID(), accountId: actor.sub, credentialType: 'API_KEY', credentialId: randomUUID(),
        snapshot: {}, actorAccountId: actor.sub } })
      await expect(service.setStatus(actor, project.id, 'ARCHIVED')).rejects.toMatchObject({ status: 409 })
      await db.projectBudgetEntry.update({ where: { id: entry.id }, data: { status: 'RECONCILIATION_REQUIRED' } })
      await expect(service.setStatus(actor, project.id, 'ARCHIVED')).rejects.toMatchObject({ status: 409 })
      await db.projectBudgetEntry.update({ where: { id: entry.id }, data: { status: 'SETTLED' } })
      await expect(service.setStatus(actor, project.id, 'ARCHIVED')).resolves.toMatchObject({ id: project.id, status: 'ARCHIVED' })
      await expect(service.update(actor, project.id, { name: '归档后' })).rejects.toMatchObject({ status: 409 })
      await expect(service.list(actor, {})).resolves.toMatchObject({ total: 0 })
    })
  })
})
