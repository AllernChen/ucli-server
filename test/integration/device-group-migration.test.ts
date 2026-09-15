import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Reflector } from '@nestjs/core'
import { createOrganization, withTestDatabase } from './database.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { DeviceGrantsService } from '../../apps/api/src/device-grants.service.js'
import { AuthService } from '../../apps/api/src/auth.service.js'
import { AuthGuard, signAccessToken } from '../../packages/security/src/auth.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('device group migration (real PostgreSQL)', () => {
  it('assigns old grants once without re-exchange, audits, and requires live membership at redemption/refresh', () => withTestDatabase(async db => {
    const a = await createOrganization(db)
    const service = new DeviceGrantsService(db as PrismaService), auth = new AuthService(db as PrismaService)
    process.env.JWT_SECRET = randomUUID(); process.env.MASTER_KEY = Buffer.alloc(32, 3).toString('base64'); process.env.PUBLIC_URL = 'http://127.0.0.1:3100'
    const group = await db.usageGroup.create({ data: { organizationId: a.organization.id, name: 'Migrate', type: 'PROJECT' } })
    await db.groupMember.create({ data: { organizationId: a.organization.id, accountId: a.account.id, groupId: group.id } })
    const old = await service.create(a.organization.id, a.account.id, a.account.id, {})
    const link = new URLSearchParams(new URL(old.connectionUrl).hash.slice(1)).get('link')!
    const credentials = await service.redeem({ link, device: { installationId: randomUUID(), name: 'Old UCLI', platform: 'windows', clientVersion: 'test' } })
    const device = await db.device.findFirstOrThrow({ where: { grant: { id: old.id } } })
    const guard = new AuthGuard(new Reflector(), db as PrismaService)
    expect((await guard.authenticateToken(credentials.accessToken)).groupId).toBeNull()
    expect(await service.ungrouped(a.organization.id, { offset: 0, limit: 20 })).toMatchObject({ total: 1, requireDeviceGroup: false })
    await expect(service.setGroupRequirement(a.organization.id, a.account.id, true)).rejects.toMatchObject({ status: 409 })
    const mapping = [{ grantId: old.id, accountId: a.account.id, groupId: group.id }]
    await service.assignGroups(a.organization.id, a.account.id, mapping, true)
    expect((await db.deviceGrant.findUniqueOrThrow({ where: { id: old.id } })).groupId).toBeNull()
    await service.assignGroups(a.organization.id, a.account.id, mapping)
    expect((await guard.authenticateToken(credentials.accessToken)).groupId).toBe(group.id)
    expect((await db.device.findUniqueOrThrow({ where: { id: device.id } })).refreshTokenHash).toBe(device.refreshTokenHash)
    await expect(service.assignGroups(a.organization.id, a.account.id, mapping)).rejects.toMatchObject({ status: 409 })
    await service.setGroupRequirement(a.organization.id, a.account.id, true)
    await expect(service.create(a.organization.id, a.account.id, a.account.id, {})).rejects.toMatchObject({ status: 403 })
    const rotated = await auth.refresh(credentials.refreshToken)
    expect(rotated).toHaveProperty('accessToken')
    const fresh = await service.create(a.organization.id, a.account.id, a.account.id, { groupId: group.id })
    await db.usageGroup.update({ where: { id: group.id }, data: { enabled: false } })
    await expect(service.redeem({ link: new URLSearchParams(new URL(fresh.connectionUrl).hash.slice(1)).get('link'), device: { installationId: randomUUID(), name: 'New', platform: 'linux', clientVersion: 'test' } })).rejects.toMatchObject({ status: 403 })
    await expect(auth.refresh(rotated.refreshToken)).rejects.toMatchObject({ status: 403 })
    expect(await db.auditLog.count({ where: { organizationId: a.organization.id, action: 'device_grant.assign_group' } })).toBe(1)
  }))

  it('rolls back a mixed invalid batch and serializes ungrouped issuance against requirement activation', () => withTestDatabase(async db => {
    const a = await createOrganization(db), b = await createOrganization(db)
    process.env.MASTER_KEY = Buffer.alloc(32, 3).toString('base64'); process.env.PUBLIC_URL = 'http://127.0.0.1:3100'
    const service = new DeviceGrantsService(db as PrismaService)
    const group = await db.usageGroup.create({ data: { organizationId: a.organization.id, name: 'Atomic', type: 'PROJECT' } })
    await db.groupMember.create({ data: { organizationId: a.organization.id, accountId: a.account.id, groupId: group.id } })
    const old = await service.create(a.organization.id, a.account.id, a.account.id, {})
    await expect(service.assignGroups(a.organization.id, a.account.id, [
      { grantId: old.id, accountId: a.account.id, groupId: group.id }, { grantId: randomUUID(), accountId: b.account.id, groupId: group.id }
    ])).rejects.toBeDefined()
    expect((await db.deviceGrant.findUniqueOrThrow({ where: { id: old.id } })).groupId).toBeNull()
    await service.delete(a.organization.id, a.account.id, old.id)
    const outcomes = await Promise.allSettled([service.setGroupRequirement(a.organization.id, a.account.id, true), service.create(a.organization.id, a.account.id, a.account.id, {})])
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1)
    const organization = await db.organization.findUniqueOrThrow({ where: { id: a.organization.id } })
    const status = await service.ungrouped(a.organization.id, { offset: 0, limit: 20 })
    expect(organization.requireDeviceGroup ? status.total === 0 : status.total === 1).toBe(true)
  }))
})
