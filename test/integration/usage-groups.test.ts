import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'
import { DeviceGrantsService } from '../../apps/api/src/device-grants.service.js'
import { DeviceGrantLinksService } from '../../apps/api/src/device-grant-links.service.js'
import { createDeviceGrantLinkCredential } from '../../packages/security/src/device-grant-links.js'

afterEach(() => vi.unstubAllEnvs())

describe.skipIf(!process.env.TEST_DATABASE_URL)('group management (PostgreSQL)', () => {
  it('scopes all operations and prevents archived groups from being reactivated', async () => {
    await withTestDatabase(async db => {
      const a = await createOrganization(db); const b = await createOrganization(db)
      const service = new UsageGroupsService(db as PrismaService)
      const group = await service.create(a.actor, { name: 'Project A', type: 'PROJECT' })
      expect(group.defaultLimitCny.toString()).toBe('0')
      await expect(service.detail(b.actor.organizationId, group.id)).rejects.toMatchObject({ status: 404 })
      await expect(service.addMember(a.actor, group.id, b.account.id)).rejects.toMatchObject({ status: 403 })
      await service.addMember(a.actor, group.id, a.account.id)
      expect((await service.members(a.actor.organizationId, group.id)).items).toHaveLength(1)
      const models = [randomUUID(), randomUUID()]
      await db.publicModel.createMany({ data: models.map(id => ({ id, displayName: id })) })
      await service.replaceModels(a.actor, group.id, models)
      await expect(service.replaceModels(a.actor, group.id, ['missing-model'])).rejects.toMatchObject({ status: 400 })
      expect((await service.models(a.actor.organizationId, group.id)).map(item => item.publicModelId).sort()).toEqual(models.sort())
      await service.archive(a.actor, group.id)
      await expect(service.setEnabled(a.actor, group.id, true)).rejects.toMatchObject({ status: 409 })
      expect((await service.detail(a.actor.organizationId, group.id)).archivedAt).not.toBeNull()
    })
  })

  it('permanently revokes keys and device grants on removal, even after rejoining', async () => {
    await withTestDatabase(async db => {
      const { organization, account, actor } = await createOrganization(db)
      const service = new UsageGroupsService(db as PrismaService)
      const group = await service.create(actor, { name: 'Dept', type: 'DEPARTMENT' })
      await service.addMember(actor, group.id, account.id)
      const key = await db.employeeApiKey.create({ data: { organizationId: organization.id, groupId: group.id,
        accountId: account.id, createdById: account.id, name: 'Key', secretHash: randomUUID(), secretHint: 'test' } })
      const device = await db.device.create({ data: { organizationId: organization.id, accountId: account.id,
        name: 'device', refreshTokenHash: randomUUID() } })
      const grant = await db.deviceGrant.create({ data: { organizationId: organization.id, accountId: account.id,
        groupId: group.id, createdById: account.id, deviceId: device.id } })
      const link = await db.deviceGrantLink.create({ data: { deviceGrantId: grant.id, createdById: account.id,
        secretHash: randomUUID(), secretHint: 'link', secretEncrypted: { ciphertext: 'test' } } })
      await service.removeMember(actor, group.id, account.id)
      await service.addMember(actor, group.id, account.id)
      expect((await db.employeeApiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt).not.toBeNull()
      expect((await db.deviceGrant.findUniqueOrThrow({ where: { id: grant.id } })).deletedAt).not.toBeNull()
      expect((await db.device.findUniqueOrThrow({ where: { id: device.id } })).revokedAt).not.toBeNull()
      const revokedLink = await db.deviceGrantLink.findUniqueOrThrow({ where: { id: link.id } })
      expect(revokedLink.revokedAt).not.toBeNull()
      expect(revokedLink.secretEncrypted).toBeNull()
      expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'usage_group.remove_member' } })).toBe(1)
    })
  })

  it('does not leave live credentials when removal races redemption and regeneration', async () => {
    vi.stubEnv('JWT_SECRET', 'local-integration-only')
    vi.stubEnv('MASTER_KEY', Buffer.alloc(32, 9).toString('base64'))
    vi.stubEnv('PUBLIC_URL', 'http://localhost:3000')
    await withTestDatabase(async db => {
      const { organization, account, actor } = await createOrganization(db)
      const service = new UsageGroupsService(db as PrismaService)
      const links = new DeviceGrantLinksService(db as PrismaService)
      const grants = new DeviceGrantsService(db as PrismaService, links)
      for (let attempt = 0; attempt < 3; attempt++) {
        const group = await service.create(actor, { name: 'Concurrent', type: 'PROJECT' })
        await service.addMember(actor, group.id, account.id)
        const grant = await db.deviceGrant.create({ data: { organizationId: organization.id, accountId: account.id,
          groupId: group.id, createdById: account.id } })
        const credential = createDeviceGrantLinkCredential(Buffer.alloc(32, 9))
        await links.createInTransaction(db, { organizationId: organization.id, actorId: account.id, grantId: grant.id,
          expiresAt: null, action: 'create', credential })
        const [removed] = await Promise.allSettled([
          service.removeMember(actor, group.id, account.id),
          grants.redeem({ link: credential.secret, device: { installationId: randomUUID(), name: 'Race', platform: 'windows', clientVersion: 'test' } }),
          links.regenerate(organization.id, account.id, grant.id, {})
        ])
        expect(removed.status).toBe('fulfilled')
        const stored = await db.deviceGrant.findUniqueOrThrow({ where: { id: grant.id }, include: { device: true, links: true } })
        expect(stored.deletedAt).not.toBeNull()
        if (stored.device) expect(stored.device.revokedAt).not.toBeNull()
        expect(stored.links.every(link => link.revokedAt && !link.secretEncrypted)).toBe(true)
        await service.addMember(actor, group.id, account.id)
        await expect(grants.redeem({ link: credential.secret, device: { installationId: randomUUID(), name: 'Retry', platform: 'windows', clientVersion: 'test' } })).rejects.toThrow()
      }
    })
  }, 30_000)
})
