import { describe, expect, it, vi } from 'vitest'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { OrgUnitsService } from '../../apps/api/src/org-units.service.js'
import { createOrganization, withTestDatabase } from '../integration/database.js'
import { applyCoverage, plannedCoverage } from '../../scripts/org-project-access-coverage.mjs'

describe.skipIf(!process.env.TEST_DATABASE_URL)('organization project access coverage database apply', () => {
  it('applies missing members and encrypted keys idempotently', async () => {
    vi.stubEnv('MASTER_KEY', Buffer.alloc(32, 33).toString('base64'))
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const organizations = new OrgUnitsService(db as PrismaService)
      const research = await organizations.create(actor, { name: '研发部', kind: 'FUNCTIONAL' })
      const contributorEmail = `coverage-${Date.now()}@example.invalid`
      const contributor = await db.account.create({ data: { email: contributorEmail, displayName: 'Coverage member' } })
      await db.membership.create({ data: { organizationId: actor.organizationId, accountId: contributor.id, role: 'MEMBER' } })
      await organizations.addMember(actor, research.id, contributor.id)
      const project = await db.project.findFirstOrThrow({ where: { regionId: research.id, category: 'DEPARTMENT' } })
      await db.projectMember.deleteMany({ where: { projectId: project.id, accountId: contributor.id } })
      const plan = plannedCoverage({
        organizations: [{ id: research.id, organizationId: actor.organizationId, name: research.name, members: [{ accountId: contributor.id }], projects: [{ id: project.id, name: project.name }] }],
        existingProjectMembers: [],
        existingActiveKeys: []
      })
      const first = await applyCoverage(db as PrismaService, plan, actor.sub, Buffer.alloc(32, 34))
      expect(first).toEqual({ projectMembersAdded: 1, keysCreated: 1 })
      expect(await db.projectMember.count({ where: { projectId: project.id, accountId: contributor.id } })).toBe(1)
      expect(await db.employeeApiKey.count({ where: { projectId: project.id, accountId: contributor.id, revokedAt: null } })).toBe(1)
      const second = await applyCoverage(db as PrismaService, plan, actor.sub, Buffer.alloc(32, 34))
      expect(second).toEqual({ projectMembersAdded: 0, keysCreated: 0 })
    })
  })
})
