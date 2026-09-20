import { describe, expect, it } from 'vitest'
import { plannedCoverage } from '../../scripts/org-project-access-coverage.mjs'

const organizations = [{
  id: 'org-unit-1',
  name: '研发部',
  members: [{ accountId: 'member-1' }, { accountId: 'member-2' }],
  projects: [{ id: 'project-1', name: '研发日常' }],
  existingProjectMembers: [{ projectId: 'project-1', accountId: 'member-1' }],
  existingActiveKeys: [{ projectId: 'project-1', accountId: 'member-1' }]
}]

describe('organization project access coverage', () => {
  it('plans only missing project members and keys', () => {
    expect(plannedCoverage({
      organizations: organizations.map(organization => ({ ...organization, organizationId: 'org-a' })),
      existingProjectMembers: organizations[0].existingProjectMembers,
      existingActiveKeys: organizations[0].existingActiveKeys
    })).toMatchObject({
      targetRelations: 2,
      missingProjectMembers: 1,
      missingActiveKeys: 1,
      alreadyCoveredRelations: 1,
      projectMemberOperations: [{ projectId: 'project-1', accountId: 'member-2' }],
      keyOperations: [{ projectId: 'project-1', accountId: 'member-2' }]
    })
  })

  it('is idempotent when all relations and keys exist', () => {
    const covered = [{
      ...organizations[0],
      existingProjectMembers: [
        { projectId: 'project-1', accountId: 'member-1' },
        { projectId: 'project-1', accountId: 'member-2' }
      ],
      existingActiveKeys: [
        { projectId: 'project-1', accountId: 'member-1' },
        { projectId: 'project-1', accountId: 'member-2' }
      ]
    }]
    expect(plannedCoverage({
      organizations: covered.map(organization => ({ ...organization, organizationId: 'org-a' })),
      existingProjectMembers: covered[0].existingProjectMembers,
      existingActiveKeys: covered[0].existingActiveKeys
    })).toMatchObject({
      targetRelations: 2,
      missingProjectMembers: 0,
      missingActiveKeys: 0,
      alreadyCoveredRelations: 2
    })
  })
})
