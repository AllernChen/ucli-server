import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { UsersService } from '../../apps/api/src/users.service.js'
import { CreateManagedUserDto, UpdateManagedUserRoleDto } from '../../apps/api/src/device-grants.dto.js'

const schema = readFileSync('prisma/schema.prisma', 'utf8')
const migration = readFileSync('prisma/migrations/202608260001_device_grants/migration.sql', 'utf8')

function makeUsersHarness(options: { role?: string; secondOrganization?: boolean; sharedAccount?: boolean; otherRole?: string; promoteBeforeLifecycleUpdate?: boolean; demoteActorBeforeRoleUpdate?: boolean; roleUpdateConflicts?: number } = {}) {
  const state: any = {
    accounts: [{
      id: 'account-1', email: 'existing@example.com', displayName: 'Existing user', passwordHash: null,
      status: 'ACTIVE', tokenVersion: 1, createdAt: new Date('2026-08-26T00:00:00Z')
    }],
    memberships: [{ organizationId: 'org-1', accountId: 'account-1', role: options.role || 'MEMBER', status: 'ACTIVE' }],
    devices: [{ id: 'device-1', organizationId: 'org-1', accountId: 'account-1' }],
    grants: [{ id: 'grant-1', organizationId: 'org-1', accountId: 'account-1', deletedAt: null }],
    links: [{ id: 'link-1', deviceGrantId: 'grant-1', issuanceOrder: 1n, secretHash: 'secret-hash', secretEncrypted: { ciphertext: 'encrypted-secret' }, secretHint: '••••secret', expiresAt: null, revokedAt: null, consumedAt: null, createdAt: new Date('2026-08-26T00:00:00Z') }]
  }
  state.actorMemberships = [
    { organizationId: 'org-1', accountId: 'platform-1', role: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    { organizationId: 'org-1', accountId: 'admin-1', role: 'ORG_ADMIN', status: 'ACTIVE' },
    { organizationId: 'org-1', accountId: 'member-2', role: 'MEMBER', status: 'ACTIVE' }
  ]
  state.lifecycleUpdateWheres = []
  state.transactionAttempts = 0
  if (options.secondOrganization) {
    state.accounts.push({
      id: 'account-2', email: 'other@example.com', displayName: 'Other user', passwordHash: null,
      status: 'ACTIVE', tokenVersion: 1, createdAt: new Date('2026-08-26T00:00:00Z')
    })
    state.memberships.push({ organizationId: 'org-2', accountId: 'account-2', role: 'MEMBER', status: 'ACTIVE' })
  }
  if (options.sharedAccount) state.memberships.push({
    organizationId: 'org-2', accountId: 'account-1', role: options.otherRole || 'MEMBER', status: 'ACTIVE'
  })

  const accountFor = (accountId: string) => state.accounts.find((account: any) => account.id === accountId)
  const matchesAccount = (account: any, filter: any) => {
    if (!filter) return true
    if (filter.OR) return filter.OR.some((item: any) => matchesAccount(account, item))
    return ['email', 'displayName'].every(field => !filter[field] || account[field].toLowerCase().includes(filter[field].contains.toLowerCase()))
  }
  const matchesMembership = (membership: any, where: any) =>
    (!where.organizationId || membership.organizationId === where.organizationId) &&
    (!where.accountId || membership.accountId === where.accountId) &&
    (!where.role || (typeof where.role === 'string' ? membership.role === where.role : where.role.in.includes(membership.role))) &&
    matchesAccount(accountFor(membership.accountId), where.account)
  const matchesGrant = (grant: any, where: any) => !where ||
    (where.deletedAt === undefined || grant.deletedAt === where.deletedAt)
  const membershipWithAccount = (membership: any, select: any) => ({
    ...membership,
    account: {
      ...accountFor(membership.accountId),
      _count: {
        select: undefined,
        devices: state.devices.filter((device: any) => device.accountId === membership.accountId && device.organizationId === membership.organizationId).length,
        deviceGrants: state.grants.filter((grant: any) => grant.accountId === membership.accountId && grant.organizationId === membership.organizationId &&
          matchesGrant(grant, select.account.select._count.select.deviceGrants.where)).length
      },
      devices: state.devices.filter((device: any) => device.accountId === membership.accountId && device.organizationId === membership.organizationId)
        .map((device: any) => ({ lastSeenAt: device.lastSeenAt || null }))
    }
  })
  const prisma: any = {
    account: {
      create: async ({ data }: any) => {
        if (state.accounts.some((account: any) => account.email === data.email)) {
          const error: any = new Error('Unique constraint')
          error.code = 'P2002'
          throw error
        }
        const account = { id: `account-${state.accounts.length + 1}`, status: 'ACTIVE', tokenVersion: 1, createdAt: new Date(), ...data }
        state.accounts.push(account)
        return account
      },
      update: async ({ where, data }: any) => {
        const account = accountFor(where.id)
        const { tokenVersion, ...fields } = data
        Object.assign(account, fields)
        if (data.tokenVersion?.increment) account.tokenVersion += data.tokenVersion.increment
        return account
      }
    },
    membership: {
      create: async ({ data }: any) => {
        const membership = { ...data }
        state.memberships.push(membership)
        return membership
      },
      count: async ({ where }: any) => state.memberships.filter((membership: any) => matchesMembership(membership, where)).length,
      findMany: async ({ where, skip, take, select }: any) => {
        const items = state.memberships.filter((membership: any) => matchesMembership(membership, where))
        return items.slice(skip || 0, take === undefined ? undefined : (skip || 0) + take).map((membership: any) => membershipWithAccount(membership, select))
      },
      findUnique: async ({ where, select }: any) => {
        const key = where.organizationId_accountId
        const membership = [...state.memberships, ...state.actorMemberships]
          .find((item: any) => item.organizationId === key.organizationId && item.accountId === key.accountId)
        if (!membership) return null
        if (!select?.account) return { ...membership }
        const account = accountFor(membership.accountId)
        const linkOrderBy = select?.account?.select?.deviceGrants?.select?.links?.orderBy || { createdAt: 'desc' }
        const linkOrderField = Object.keys(linkOrderBy)[0]
        const latestLink = (grantId: string) => state.links.filter((link: any) => link.deviceGrantId === grantId)
          .sort((a: any, b: any) => a[linkOrderField] === b[linkOrderField] ? 0 : a[linkOrderField] > b[linkOrderField] ? -1 : 1).slice(0, 1)
        return {
          ...membership,
          account: {
            id: account.id, email: account.email, displayName: account.displayName, status: account.status, createdAt: account.createdAt,
            devices: state.devices.filter((device: any) => device.accountId === account.id && device.organizationId === membership.organizationId)
              .map((device: any) => {
                const grant = state.grants.find((item: any) => item.deviceId === device.id)
                return {
                  id: device.id, name: 'Existing device', installationId: null, platform: null, clientVersion: null,
                  revokedAt: device.revokedAt || null, lastSeenAt: null, createdAt: account.createdAt,
                  grant: grant ? {
                    id: grant.id, expiresAt: grant.expiresAt || null, disabledAt: grant.disabledAt || null,
                    deletedAt: grant.deletedAt || null, boundAt: grant.boundAt || null, deviceId: grant.deviceId || null,
                    links: latestLink(grant.id)
                  } : null
                }
              }),
            deviceGrants: state.grants.filter((grant: any) => grant.accountId === account.id && grant.organizationId === membership.organizationId &&
              matchesGrant(grant, select?.account?.select?.deviceGrants?.where))
              .map((grant: any) => ({
                id: grant.id, expiresAt: grant.expiresAt || null, disabledAt: grant.disabledAt || null, deletedAt: grant.deletedAt || null,
                boundAt: grant.boundAt || null, deviceId: grant.deviceId || null, createdAt: account.createdAt, updatedAt: account.createdAt,
                links: latestLink(grant.id)
              }))
          }
        }
      },
      update: async ({ where, data }: any) => {
        const key = where.organizationId_accountId
        const membership = state.memberships.find((item: any) => item.organizationId === key.organizationId && item.accountId === key.accountId)
        Object.assign(membership, data)
        return membership
      },
      updateMany: async ({ where, data }: any) => {
        state.lifecycleUpdateWheres.push(structuredClone(where))
        if (options.promoteBeforeLifecycleUpdate) state.memberships[0].role = 'PLATFORM_ADMIN'
        if (options.demoteActorBeforeRoleUpdate && where.accountId === 'admin-1') state.actorMemberships[1].role = 'MEMBER'
        const memberships = [...state.memberships, ...state.actorMemberships]
          .filter((membership: any) => matchesMembership(membership, where))
        memberships.forEach((membership: any) => Object.assign(membership, data))
        return { count: memberships.length }
      }
    },
    $transaction: async (operation: any) => {
      state.transactionAttempts++
      if (state.transactionAttempts <= (options.roleUpdateConflicts || 0)) {
        const error: any = new Error('Transaction write conflict')
        error.code = 'P2034'
        throw error
      }
      return operation(prisma)
    }
  }
  return { service: new UsersService(prisma), state }
}

describe('managed users', () => {
  it('creates a passwordless MEMBER and membership atomically', async () => {
    const { service, state } = makeUsersHarness()
    const result = await service.create('org-1', { email: ' User@Example.com ', displayName: ' 张三 ' })
    expect(result).toMatchObject({ email: 'user@example.com', displayName: '张三', role: 'MEMBER' })
    expect(state.accounts[1].passwordHash).toBeNull()
    expect(state.memberships[1]).toMatchObject({ organizationId: 'org-1', role: 'MEMBER', status: 'ACTIVE' })
  })

  it('reports duplicate emails without exposing database details', async () => {
    const { service } = makeUsersHarness()
    await expect(service.create('org-1', { email: 'existing@example.com', displayName: 'Duplicate' }))
      .rejects.toMatchObject({ status: 409, message: 'Account email already exists' })
  })

  it('refuses lifecycle updates for every non-MEMBER target membership', async () => {
    for (const role of ['ORG_ADMIN', 'PLATFORM_ADMIN']) {
      const { service } = makeUsersHarness({ role })
      await expect(service.disable('org-1', 'account-1')).rejects.toMatchObject({ status: 403 })
      await expect(service.enable('org-1', 'account-1')).rejects.toMatchObject({ status: 403 })
    }
  })

  it('changes only the current organization membership for a shared account', async () => {
    const { service, state } = makeUsersHarness({ sharedAccount: true })
    await expect(service.disable('org-1', 'account-1')).resolves.toEqual({ status: 'DISABLED' })
    expect(state.memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ organizationId: 'org-1', status: 'DISABLED' }),
      expect.objectContaining({ organizationId: 'org-2', status: 'ACTIVE' })
    ]))
    expect(state.accounts[0].status).toBe('ACTIVE')
  })

  it('does not affect an administrator membership in another organization', async () => {
    const { service, state } = makeUsersHarness({ sharedAccount: true, otherRole: 'PLATFORM_ADMIN' })
    await expect(service.disable('org-1', 'account-1')).resolves.toEqual({ status: 'DISABLED' })
    expect(state.memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ organizationId: 'org-1', role: 'MEMBER', status: 'DISABLED' }),
      expect.objectContaining({ organizationId: 'org-2', role: 'PLATFORM_ADMIN', status: 'ACTIVE' })
    ]))
  })

  it('disables and enables an account with exactly one MEMBER membership', async () => {
    const { service, state } = makeUsersHarness()
    await expect(service.disable('org-1', 'account-1')).resolves.toEqual({ status: 'DISABLED' })
    expect(state.memberships[0].status).toBe('DISABLED')
    expect(state.accounts[0]).toMatchObject({ status: 'ACTIVE', tokenVersion: 1 })
    await expect(service.enable('org-1', 'account-1')).resolves.toEqual({ status: 'ACTIVE' })
    expect(state.memberships[0].status).toBe('ACTIVE')
  })

  it('does not write status when the target is promoted before the atomic lifecycle update', async () => {
    const { service, state } = makeUsersHarness({ promoteBeforeLifecycleUpdate: true })
    await expect(service.disable('org-1', 'account-1')).rejects.toMatchObject({ status: 403 })
    expect(state.memberships[0]).toMatchObject({ role: 'PLATFORM_ADMIN', status: 'ACTIVE' })
    expect(state.lifecycleUpdateWheres).toContainEqual({ organizationId: 'org-1', accountId: 'account-1', role: 'MEMBER' })
  })

  it('persists membership lifecycle status with an ACTIVE default', () => {
    expect(schema).toMatch(/model Membership[\s\S]*status\s+AccountStatus\s+@default\(ACTIVE\)/)
    expect(migration).toContain('ALTER TABLE "memberships" ADD COLUMN "status" "AccountStatus" NOT NULL DEFAULT \'ACTIVE\';')
  })

  it('does not return users from another organization', async () => {
    const { service } = makeUsersHarness({ secondOrganization: true })
    const result = await service.list('org-1', { limit: 50, offset: 0, q: undefined })
    expect(result.items.every(item => item.organizationId === 'org-1')).toBe(true)
    expect(result).toMatchObject({ total: 1, limit: 50, offset: 0 })
  })

  it('returns status from the current organization membership', async () => {
    const { service, state } = makeUsersHarness()
    state.memberships[0].status = 'DISABLED'
    await expect(service.list('org-1', { limit: 50, offset: 0, q: undefined }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ status: 'DISABLED' })] })
    await expect(service.detail('org-1', 'account-1'))
      .resolves.toMatchObject({ status: 'DISABLED' })
  })

  it('excludes soft-deleted grants from current authorization counts and user detail', async () => {
    const { service, state } = makeUsersHarness()
    state.grants[0].deletedAt = new Date('2026-08-27T00:00:00Z')
    state.grants[0].deviceId = 'device-1'
    state.devices[0].revokedAt = new Date('2026-08-27T00:00:00Z')

    await expect(service.list('org-1', { limit: 50, offset: 0, q: undefined }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ deviceGrantCount: 0 })] })
    await expect(service.detail('org-1', 'account-1')).resolves.toMatchObject({
      deviceCount: 1,
      deviceGrantCount: 0,
      deviceGrants: [],
      devices: [expect.objectContaining({ id: 'device-1', revokedAt: state.devices[0].revokedAt, grant: null })]
    })
  })

  it('lets platform administrators change a role only in their current organization', async () => {
    const { service, state } = makeUsersHarness({ sharedAccount: true })

    await expect(service.updateRole(
      { sub: 'platform-1', organizationId: 'org-1', role: 'PLATFORM_ADMIN' },
      'account-1', 'ORG_ADMIN'
    )).resolves.toEqual({ role: 'ORG_ADMIN' })

    expect(state.memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ organizationId: 'org-1', accountId: 'account-1', role: 'ORG_ADMIN' }),
      expect.objectContaining({ organizationId: 'org-2', accountId: 'account-1', role: 'MEMBER' })
    ]))
  })

  it('prevents organization administrators from granting or editing platform administrator access', async () => {
    const orgAdmin = { sub: 'admin-1', organizationId: 'org-1', role: 'ORG_ADMIN' as const }
    const member = makeUsersHarness()
    await expect(member.service.updateRole(orgAdmin, 'account-1', 'PLATFORM_ADMIN'))
      .rejects.toMatchObject({ status: 403 })
    expect(member.state.memberships[0].role).toBe('MEMBER')

    const platformAdmin = makeUsersHarness({ role: 'PLATFORM_ADMIN' })
    await expect(platformAdmin.service.updateRole(orgAdmin, 'account-1', 'MEMBER'))
      .rejects.toMatchObject({ status: 403 })
    expect(platformAdmin.state.memberships[0].role).toBe('PLATFORM_ADMIN')
  })

  it('rejects role edits when the caller is not an administrator', async () => {
    const { service, state } = makeUsersHarness()
    await expect(service.updateRole(
      { sub: 'member-2', organizationId: 'org-1', role: 'MEMBER' },
      'account-1', 'ORG_ADMIN'
    )).rejects.toMatchObject({ status: 403 })
    expect(state.memberships[0].role).toBe('MEMBER')
  })

  it('prevents administrators from editing their own role', async () => {
    const { service, state } = makeUsersHarness({ role: 'PLATFORM_ADMIN' })
    await expect(service.updateRole(
      { sub: 'account-1', organizationId: 'org-1', role: 'PLATFORM_ADMIN' },
      'account-1', 'MEMBER'
    )).rejects.toMatchObject({ status: 403 })
    expect(state.memberships[0].role).toBe('PLATFORM_ADMIN')
  })

  it('rechecks the caller role inside the role update transaction', async () => {
    const { service, state } = makeUsersHarness({ demoteActorBeforeRoleUpdate: true })
    await expect(service.updateRole(
      { sub: 'admin-1', organizationId: 'org-1', role: 'ORG_ADMIN' },
      'account-1', 'ORG_ADMIN'
    )).rejects.toMatchObject({ status: 403 })
    expect(state.memberships[0].role).toBe('MEMBER')
  })

  it('retries a transient role-update deadlock without applying a partial change', async () => {
    const { service, state } = makeUsersHarness({ roleUpdateConflicts: 1 })
    await expect(service.updateRole(
      { sub: 'platform-1', organizationId: 'org-1', role: 'PLATFORM_ADMIN' },
      'account-1', 'ORG_ADMIN'
    )).resolves.toEqual({ role: 'ORG_ADMIN' })
    expect(state.memberships[0].role).toBe('ORG_ADMIN')
    expect(state.transactionAttempts).toBe(2)
  })

  it('allows organization administrators to promote members to organization administrators', async () => {
    const { service, state } = makeUsersHarness()
    await expect(service.updateRole(
      { sub: 'admin-1', organizationId: 'org-1', role: 'ORG_ADMIN' },
      'account-1', 'ORG_ADMIN'
    )).resolves.toEqual({ role: 'ORG_ADMIN' })
    expect(state.memberships[0].role).toBe('ORG_ADMIN')
  })

  it('returns user detail with a latest link summary and no password or grant credential fields', async () => {
    const { service, state } = makeUsersHarness()
    const linkExpiry = new Date('2026-08-25T00:00:00.000Z')
    state.links.push({ id: 'link-2', deviceGrantId: 'grant-1', issuanceOrder: 2n, secretHash: 'latest-secret-hash', secretEncrypted: { ciphertext: 'latest-encrypted-secret' }, secretHint: '••••abcd', expiresAt: linkExpiry, revokedAt: null, consumedAt: null, createdAt: new Date('2026-08-25T00:00:00Z') })
    const result = await service.detail('org-1', 'account-1')
    expect(result).toMatchObject({ id: 'account-1', organizationId: 'org-1', role: 'MEMBER' })
    expect(result.deviceGrants[0]).toMatchObject({ id: 'grant-1', currentLink: { id: 'link-2', secretHint: '••••abcd', status: 'EXPIRED', expiresAt: linkExpiry } })
    expect(result.deviceGrants[0]).not.toHaveProperty('tokenHash')
    expect(result.deviceGrants[0]).not.toHaveProperty('tokenHint')
    expect(JSON.stringify(result)).not.toContain('passwordHash')
    expect(JSON.stringify(result)).not.toContain('secret-hash')
    expect(JSON.stringify(result)).not.toContain('latest-encrypted-secret')
  })

  it('derives user-detail grant statuses from one captured lifecycle time', async () => {
    const { service, state } = makeUsersHarness()
    state.grants[0].disabledAt = new Date()
    const result = await service.detail('org-1', 'account-1')
    expect(result.deviceGrants).toEqual([expect.objectContaining({ id: 'grant-1', status: 'DISABLED' })])
    expect(JSON.stringify(result)).not.toContain('secret-hash')
  })

  it.each(['MEMBER', 'ORG_ADMIN', 'PLATFORM_ADMIN'])('returns user detail for the %s role', async role => {
    const { service } = makeUsersHarness({ role })
    await expect(service.detail('org-1', 'account-1')).resolves.toMatchObject({ role })
  })

  it('normalizes valid creation input and rejects a blank display name', async () => {
    const valid = plainToInstance(CreateManagedUserDto, { email: ' USER@EXAMPLE.COM ', displayName: ' 张三 ' })
    expect(valid).toMatchObject({ email: 'user@example.com', displayName: '张三' })
    expect(await validate(valid)).toEqual([])

    const invalid = plainToInstance(CreateManagedUserDto, { email: 'member@example.com', displayName: ' ' })
    expect(await validate(invalid)).not.toEqual([])
  })

  it('accepts only persisted membership roles when editing authorization', async () => {
    const valid = plainToInstance(UpdateManagedUserRoleDto, { role: 'ORG_ADMIN' })
    expect(await validate(valid)).toEqual([])

    const invalid = plainToInstance(UpdateManagedUserRoleDto, { role: 'OWNER' })
    expect(await validate(invalid)).not.toEqual([])
  })
})
