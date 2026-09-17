import { describe, expect, it, vi, afterEach } from 'vitest'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { EmployeeKeysService } from '../../apps/api/src/employee-keys.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { AuthGuard } from '../../packages/security/src/auth.js'
import { GatewayAuthGuard } from '../../packages/security/src/gateway-auth.js'
import { Reflector } from '@nestjs/core'
import { hashOpaqueToken } from '../../packages/security/src/tokens.js'
import { randomUUID } from 'node:crypto'
import { createOrganization, withTestDatabase } from './database.js'
import { EmployeeKeyQueryDto } from '../../apps/api/src/employee-keys.dto.js'

describe('employee API key query', () => {
  it('trims a valid search and rejects invalid filter values', async () => {
    const valid = plainToInstance(EmployeeKeyQueryDto, { q: '  CLI  ', status: 'active' })
    expect(valid.q).toBe('CLI')
    expect(await validate(valid)).toEqual([])
    const invalid = plainToInstance(EmployeeKeyQueryDto, { status: 'anything', groupId: 'not-a-uuid' })
    expect((await validate(invalid)).length).toBeGreaterThan(0)
  })

  it('limits a managed search to the actor organization and returns safe relation summaries', async () => {
    const state: any = {}
    const prisma: any = { employeeApiKey: {
      findMany: async (args: any) => {
        state.findMany = args
        return [{ id: 'key-1', organizationId: 'org-a', accountId: 'account-a', groupId: 'group-a', name: 'CLI', secretHint: '…abcd',
          createdAt: new Date(), createdById: 'creator-a', expiresAt: null, disabledAt: null, revokedAt: null, deletedAt: null, lastUsedAt: null,
          membership: { account: { id: 'account-a', displayName: 'Alice', email: 'alice@example.invalid' } },
          group: { id: 'group-a', name: 'Historical group' }, createdBy: { id: 'creator-a', displayName: 'Creator' } }]
      },
      count: async (args: any) => { state.count = args; return 1 }
    } }
    const service = new EmployeeKeysService(prisma)
    const query = Object.assign(new EmployeeKeyQueryDto(), { q: ' Alice ', status: 'active', limit: 20, offset: 0 })
    await expect(service.listManaged({ organizationId: 'org-a', sub: 'admin-a', role: 'ORG_ADMIN', tokenVersion: 1 }, query)).resolves.toEqual({
      items: [expect.objectContaining({ account: { id: 'account-a', displayName: 'Alice', email: 'alice@example.invalid' },
        group: { id: 'group-a', name: 'Historical group' }, createdBy: { id: 'creator-a', displayName: 'Creator' } })], total: 1, offset: 0, limit: 20
    })
    expect(JSON.stringify(state.findMany.select)).not.toContain('secretHash')
    expect(state.findMany.where).toEqual(expect.objectContaining({ AND: expect.arrayContaining([
      expect.objectContaining({ organizationId: 'org-a', deletedAt: null }),
      expect.objectContaining({ OR: expect.arrayContaining([expect.objectContaining({ name: expect.any(Object) }),
        expect.objectContaining({ membership: expect.objectContaining({ account: expect.objectContaining({ OR: expect.any(Array) }) }) })]) })
    ]) }))
    expect(state.count.where).toEqual(state.findMany.where)
  })

  it('does not let a personal list select another account', async () => {
    const service = new EmployeeKeysService({} as any)
    await expect(service.listMine({ organizationId: 'org-a', sub: 'account-a', role: 'MEMBER', tokenVersion: 1 },
      Object.assign(new EmployeeKeyQueryDto(), { accountId: 'account-b' }))).rejects.toMatchObject({ status: 403 })
  })

  it('returns historical filter groups scoped to the personal account independently of the page', async () => {
    const state: any = {}
    const prisma: any = { employeeApiKey: {
      findMany: async () => [], count: async () => 0
    }, usageGroup: { findMany: async (args: any) => {
      state.groups = args
      return [{ id: 'historic-group', name: 'Archived project' }]
    } } }
    const service = new EmployeeKeysService(prisma)
    const result = await service.listMine({ organizationId: 'org-a', sub: 'account-a', role: 'MEMBER', tokenVersion: 1 },
      Object.assign(new EmployeeKeyQueryDto(), { q: 'no matching page', status: 'active', offset: 20, limit: 20 }))
    expect(result).toMatchObject({ items: [], total: 0, filterGroups: [{ id: 'historic-group', name: 'Archived project' }] })
    expect(state.groups.where).toEqual({ organizationId: 'org-a', keys: { some: { organizationId: 'org-a', accountId: 'account-a', deletedAt: null } } })
    expect(state.groups.orderBy).toEqual({ name: 'asc' })
  })
})

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

  it('filters managed keys in the current organization with stable status precedence and pagination', async () => {
    await withTestDatabase(async db => {
      const a = await createOrganization(db); const b = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const service = new EmployeeKeysService(db as PrismaService)
      const group = await groups.create(a.actor, { name: 'Managed keys', type: 'PROJECT' })
      await groups.addMember(a.actor, group.id, a.account.id)
      const email = `${randomUUID()}@example.invalid`
      const member = await db.account.create({ data: { email, displayName: 'Search target' } })
      await db.membership.create({ data: { organizationId: a.organization.id, accountId: member.id, role: 'MEMBER' } })
      await groups.addMember(a.actor, group.id, member.id)
      const active = await service.create(a.actor, a.account.id, { name: 'Active CLI', groupId: group.id })
      const expired = await service.create(a.actor, a.account.id, { name: 'Expired CLI', groupId: group.id })
      await db.employeeApiKey.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1_000) } })
      const disabled = await service.create(a.actor, a.account.id, { name: 'Disabled CLI', groupId: group.id })
      await service.setEnabled(a.actor, disabled.id, false)
      const revoked = await service.create(a.actor, a.account.id, { name: 'Revoked CLI', groupId: group.id })
      await service.setEnabled(a.actor, revoked.id, false); await service.revoke(a.actor, revoked.id)
      const deleted = await service.create(a.actor, a.account.id, { name: 'Deleted CLI', groupId: group.id })
      await service.delete(a.actor, deleted.id)
      await service.create(a.actor, member.id, { name: 'Searchable CLI', groupId: group.id })
      const otherGroup = await groups.create(b.actor, { name: 'Other organization', type: 'PROJECT' })
      await groups.addMember(b.actor, otherGroup.id, b.account.id)
      await service.create(b.actor, b.account.id, { name: 'Other organization key', groupId: otherGroup.id })

      for (const [status, expected] of [['active', active.id], ['expired', expired.id], ['disabled', disabled.id], ['revoked', revoked.id]] as const) {
        const result = await service.listManaged(a.actor, Object.assign(new EmployeeKeyQueryDto(), { accountId: a.account.id, status, limit: 50, offset: 0 }))
        expect(result.items.map(item => item.id)).toEqual([expected])
        expect(result.total).toBe(1)
      }
      const searched = await service.listManaged(a.actor, Object.assign(new EmployeeKeyQueryDto(), { q: email, limit: 1, offset: 0 }))
      expect(searched.total).toBe(1)
      expect(searched.items[0]).toMatchObject({ account: { id: member.id, email }, group: { id: group.id, name: 'Managed keys' } })
      const secondPage = await service.listManaged(a.actor, Object.assign(new EmployeeKeyQueryDto(), { q: email, limit: 1, offset: 1 }))
      expect(secondPage).toMatchObject({ total: 1, items: [] })
      await expect(service.listMine(a.actor, Object.assign(new EmployeeKeyQueryDto(), { accountId: member.id }))).rejects.toMatchObject({ status: 403 })
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
