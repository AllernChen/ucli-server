import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { localRehearsalUrl, rehearseGroupAccess } from '../../scripts/rehearse-group-access-migration.js'
import { createOrganization, withTestDatabase } from '../integration/database.js'

it('refuses production, non-test names and connection-option overrides before connecting', () => {
  for (const url of [undefined, 'postgresql://test@10.44.100.100/ucli_test', 'postgresql://test@localhost/ucli', 'postgresql://test@127.0.0.1/ucli_test?host=10.44.100.100']) expect(() => localRehearsalUrl(url)).toThrow()
  expect(localRehearsalUrl('postgresql://test@127.0.0.1/ucli_test_local')).toContain('127.0.0.1')
})
describe.skipIf(!process.env.TEST_DATABASE_URL)('group rehearsal dry run and atomic apply', () => {
  it('previews without mutation and applies only explicit ownership-validated mappings', () => withTestDatabase(async db => {
    const a = await createOrganization(db)
    const group = await db.usageGroup.create({ data: { organizationId: a.organization.id, name: 'Rehearsal', type: 'PROJECT' } })
    await db.groupMember.create({ data: { organizationId: a.organization.id, groupId: group.id, accountId: a.account.id } })
    const grant = await db.deviceGrant.create({ data: { organizationId: a.organization.id, accountId: a.account.id, createdById: a.account.id } })
    const input = { url: process.env.TEST_DATABASE_URL, organizationId: a.organization.id, actorId: a.account.id, mappings: [{ organizationId: a.organization.id, accountId: a.account.id, grantId: grant.id, groupId: group.id }] }
    expect(await rehearseGroupAccess(input)).toMatchObject({ dryRun: true, count: 1 })
    expect((await db.deviceGrant.findUniqueOrThrow({ where: { id: grant.id } })).groupId).toBeNull()
    await expect(rehearseGroupAccess({ ...input, mappings: [{ ...input.mappings[0], accountId: randomUUID() }], apply: true })).rejects.toBeDefined()
    expect((await db.deviceGrant.findUniqueOrThrow({ where: { id: grant.id } })).groupId).toBeNull()
    await rehearseGroupAccess({ ...input, apply: true })
    expect((await db.deviceGrant.findUniqueOrThrow({ where: { id: grant.id } })).groupId).toBe(group.id)
  }))
})
