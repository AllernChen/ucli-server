import { describe, expect, it, vi, afterEach } from 'vitest'
import { EmployeeKeysService } from '../../apps/api/src/employee-keys.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { AuthGuard } from '../../packages/security/src/auth.js'
import { GatewayAuthGuard } from '../../packages/security/src/gateway-auth.js'
import { Reflector } from '@nestjs/core'
import { hashOpaqueToken } from '../../packages/security/src/tokens.js'
import { createOrganization, withTestDatabase } from './database.js'

afterEach(() => vi.unstubAllEnvs())
describe.skipIf(!process.env.TEST_DATABASE_URL)('employee API keys (PostgreSQL)', () => {
  it('stores only the hash, restricts ownership and never resurrects revoked keys', async () => {
    await withTestDatabase(async db => {
      const a = await createOrganization(db); const b = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const service = new EmployeeKeysService(db as PrismaService)
      const group = await groups.create(a.actor, { name: 'Keys', type: 'PROJECT' })
      await groups.addMember(a.actor, group.id, a.account.id)
      await expect(service.create(a.actor, b.account.id, { name: 'Wrong org', groupId: group.id })).rejects.toMatchObject({ status: 403 })
      await expect(service.create(a.actor, a.account.id, { name: 'Expired', groupId: group.id, expiresAt: '2000-01-01T00:00:00Z' })).rejects.toMatchObject({ status: 400 })
      const key = await service.create(a.actor, a.account.id, { name: 'CLI', groupId: group.id })
      expect(key.secret).toMatch(/^ucli_sk_[A-Za-z0-9_-]{43}$/)
      const stored = await db.employeeApiKey.findUniqueOrThrow({ where: { id: key.id } })
      expect(stored.secretHash).toBe(hashOpaqueToken(key.secret))
      const list = await service.list(a.actor, a.account.id)
      expect(list.items).toHaveLength(1)
      expect(JSON.stringify(list)).not.toContain(key.secret)
      expect(JSON.stringify(list)).not.toContain(stored.secretHash)
      await expect(service.update(b.actor, key.id, { name: 'Hijack' })).rejects.toMatchObject({ status: 404 })
      await service.setEnabled(a.actor, key.id, false)
      await service.setEnabled(a.actor, key.id, true)
      await service.update(a.actor, key.id, { name: 'Renamed', expiresAt: null })
      await service.revoke(a.actor, key.id)
      await expect(service.setEnabled(a.actor, key.id, true)).rejects.toMatchObject({ status: 409 })
      await expect(service.update(a.actor, key.id, { expiresAt: null })).rejects.toMatchObject({ status: 409 })
      const audits = await db.auditLog.findMany({ where: { resourceId: key.id } })
      expect(audits.length).toBeGreaterThan(0)
      expect(JSON.stringify(audits)).not.toContain(key.secret)
      expect(JSON.stringify(audits)).not.toContain(stored.secretHash)
    })
  })

  it('authenticates live server identity and immediately rejects every disabled layer', async () => {
    vi.stubEnv('EMPLOYEE_API_KEYS_ENABLED', 'true')
    await withTestDatabase(async db => {
      const { actor, account, organization } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const group = await groups.create(actor, { name: 'Auth', type: 'PROJECT' })
      await groups.addMember(actor, group.id, account.id)
      const keys = new EmployeeKeysService(db as PrismaService)
      const key = await keys.create(actor, account.id, { name: 'CLI', groupId: group.id })
      const guard = new GatewayAuthGuard(new AuthGuard(new Reflector(), db as PrismaService), db as PrismaService)
      const request: any = { headers: { authorization: `Bearer ${key.secret}`, 'x-group-id': 'forged' } }
      const context: any = { switchToHttp: () => ({ getRequest: () => request }) }
      await guard.canActivate(context)
      expect(request.principal).toMatchObject({ credentialType: 'API_KEY', apiKeyId: key.id, groupId: group.id, sub: account.id, role: 'ORG_ADMIN' })
      expect(request.principal.deviceId).toBeUndefined()
      vi.stubEnv('EMPLOYEE_API_KEYS_ENABLED', 'false')
      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 })
      vi.stubEnv('EMPLOYEE_API_KEYS_ENABLED', 'true')
      for (const data of [{ disabledAt: new Date() }, { expiresAt: new Date(0) }, { revokedAt: new Date() }, { deletedAt: new Date() }]) {
        await db.employeeApiKey.update({ where: { id: key.id }, data })
        await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 })
        await db.employeeApiKey.update({ where: { id: key.id }, data: { disabledAt: null, expiresAt: null, revokedAt: null, deletedAt: null } })
      }
      for (const [delegate, where, off, on] of [
        [db.usageGroup, { id: group.id }, { enabled: false }, { enabled: true }],
        [db.usageGroup, { id: group.id }, { archivedAt: new Date() }, { archivedAt: null }],
        [db.organization, { id: organization.id }, { enabled: false }, { enabled: true }],
        [db.account, { id: account.id }, { status: 'DISABLED' }, { status: 'ACTIVE' }],
        [db.membership, { organizationId_accountId: { organizationId: organization.id, accountId: account.id } }, { status: 'DISABLED' }, { status: 'ACTIVE' }],
        [db.groupMember, { groupId_accountId: { groupId: group.id, accountId: account.id } }, { removedAt: new Date() }, { removedAt: null }]
      ] as const) {
        await (delegate.update as any)({ where, data: off })
        await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 })
        await (delegate.update as any)({ where, data: on })
      }
      await groups.removeMember(actor, group.id, account.id)
      await groups.addMember(actor, group.id, account.id)
      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 })
    })
  })

  it('serializes issuance with member removal so no live key survives', async () => {
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const group = await groups.create(actor, { name: 'Race', type: 'PROJECT' })
      await groups.addMember(actor, group.id, account.id)
      const [, removed] = await Promise.allSettled([keys.create(actor, account.id, { name: 'Race', groupId: group.id }), groups.removeMember(actor, group.id, account.id)])
      expect(removed.status).toBe('fulfilled')
      expect(await db.employeeApiKey.count({ where: { groupId: group.id, revokedAt: null } })).toBe(0)
    })
  })
})
