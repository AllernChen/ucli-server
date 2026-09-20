import { describe, expect, it, vi } from 'vitest'
import { EmployeeKeysService } from '../../apps/api/src/employee-keys.service.js'
import { OrgUnitsService } from '../../apps/api/src/org-units.service.js'
import { ProjectsService } from '../../apps/api/src/projects.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOpaqueToken, hashOpaqueToken, opaqueTokenHint } from '../../packages/security/src/tokens.js'
import { createOrganization, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('organization unit members (PostgreSQL)', () => {
  it('moves one primary member and synchronizes department project membership', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const organizations = new OrgUnitsService(db as PrismaService)
      const research = await organizations.create(actor, { name: '研发部', kind: 'FUNCTIONAL' })
      const engineering = await organizations.create(actor, { name: '工程部', kind: 'FUNCTIONAL' })

      await organizations.addMember(actor, research.id, account.id)
      let researchProject = await db.project.findFirstOrThrow({ where: { regionId: research.id, category: 'DEPARTMENT' } })
      await expect(db.projectMember.findUniqueOrThrow({ where: { projectId_accountId: {
        projectId: researchProject.id, accountId: account.id
      } } })).resolves.toBeTruthy()

      await organizations.addMember(actor, engineering.id, account.id)
      await expect(db.groupMember.findFirst({ where: { groupId: research.id, accountId: account.id, removedAt: null } }))
        .resolves.toBeNull()
      await expect(db.groupMember.findFirst({ where: { groupId: engineering.id, accountId: account.id, removedAt: null, isPrimary: true } }))
        .resolves.toBeTruthy()
      researchProject = await db.project.findFirstOrThrow({ where: { regionId: research.id, category: 'DEPARTMENT' } })
      await expect(db.projectMember.findUnique({ where: { projectId_accountId: {
        projectId: researchProject.id, accountId: account.id
      } } })).resolves.toBeNull()
      const engineeringProject = await db.project.findFirstOrThrow({ where: { regionId: engineering.id, category: 'DEPARTMENT' } })
      await expect(db.projectMember.findUniqueOrThrow({ where: { projectId_accountId: {
        projectId: engineeringProject.id, accountId: account.id
      } } })).resolves.toBeTruthy()
    })
  })

  it('removing a department member removes department access and revokes department keys', async () => {
    vi.stubEnv('MASTER_KEY', Buffer.alloc(32, 21).toString('base64'))
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const organizations = new OrgUnitsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const research = await organizations.create(actor, { name: '研发部', kind: 'FUNCTIONAL' })
      await organizations.addMember(actor, research.id, account.id)
      const project = await db.project.findFirstOrThrow({ where: { regionId: research.id, category: 'DEPARTMENT' } })
      const secret = `ucli_sk_${createOpaqueToken()}`
      const key = await db.employeeApiKey.create({ data: {
        organizationId: actor.organizationId, groupId: research.id, projectId: project.id,
        accountId: account.id, createdById: actor.sub, name: '研发部日常',
        secretHash: hashOpaqueToken(secret), secretHint: opaqueTokenHint(secret)
      } })

      const result = await organizations.removeMember(actor, research.id, account.id)
      expect(result).toMatchObject({ accountId: account.id, revokedDepartmentKeyCount: 1 })
      await expect(db.employeeApiKey.findUniqueOrThrow({ where: { id: key.id } })).resolves.toMatchObject({ revokedAt: expect.any(Date) })
      await expect(db.projectMember.findUnique({ where: { projectId_accountId: {
        projectId: project.id, accountId: account.id
      } } })).resolves.toBeNull()
    })
  })

  it('keeps business project membership when primary organization changes and rejects legacy mutations', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const organizations = new OrgUnitsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const region = await organizations.create(actor, { name: '广东-市局', kind: 'REGION' })
      const business = await projects.create(actor, { regionId: region.id, code: 'GD-SJ', name: '市局业务' })
      await organizations.addMember(actor, region.id, account.id)
      await projects.addMember(actor, business.id, { accountId: account.id, role: 'CONTRIBUTOR' })
      const engineering = await organizations.create(actor, { name: '工程部', kind: 'FUNCTIONAL' })
      await organizations.addMember(actor, engineering.id, account.id)

      await expect(db.projectMember.findUniqueOrThrow({ where: { projectId_accountId: {
        projectId: business.id, accountId: account.id
      } } })).resolves.toBeTruthy()

      const legacy = await db.usageGroup.create({ data: {
        organizationId: actor.organizationId, name: '历史项目组', type: 'PROJECT', orgType: 'LEGACY_PROJECT'
      } })
      await expect(organizations.addMember(actor, legacy.id, account.id)).rejects.toMatchObject({ status: 409 })
      await expect(organizations.removeMember(actor, legacy.id, account.id)).rejects.toMatchObject({ status: 409 })
    })
  })
})
