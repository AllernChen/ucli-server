import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { UsersService } from '../../apps/api/src/users.service.js'
import { CreateManagedUserDto } from '../../apps/api/src/device-grants.dto.js'

const schema = readFileSync('prisma/schema.prisma', 'utf8')
const migration = readFileSync('prisma/migrations/202608260001_device_grants/migration.sql', 'utf8')

function makeUsersHarness(options: { role?: string; secondOrganization?: boolean; sharedAccount?: boolean; otherRole?: string; promoteBeforeLifecycleUpdate?: boolean } = {}) {
  const state: any = {
    accounts: [{
      id: 'account-1', email: 'existing@example.com', displayName: 'Existing user', passwordHash: null,
      status: 'ACTIVE', tokenVersion: 1, createdAt: new Date('2026-08-26T00:00:00Z')
    }],
    memberships: [{ organizationId: 'org-1', accountId: 'account-1', role: options.role || 'MEMBER', status: 'ACTIVE' }],
    devices: [{ id: 'device-1', organizationId: 'org-1', accountId: 'account-1' }],
    grants: [{ id: 'grant-1', organizationId: 'org-1', accountId: 'account-1', tokenHash: 'secret-hash' }]
  }
  state.lifecycleUpdateWheres = []
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
    (!where.role || membership.role === where.role) && matchesAccount(accountFor(membership.accountId), where.account)
  const membershipWithAccount = (membership: any) => ({
    ...membership,
    account: {
      ...accountFor(membership.accountId),
      _count: {
        select: undefined,
        devices: state.devices.filter((device: any) => device.accountId === membership.accountId && device.organizationId === membership.organizationId).length,
        deviceGrants: state.grants.filter((grant: any) => grant.accountId === membership.accountId && grant.organizationId === membership.organizationId).length
      }
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
      findMany: async ({ where, skip, take }: any) => {
        const items = state.memberships.filter((membership: any) => matchesMembership(membership, where))
        return items.slice(skip || 0, take === undefined ? undefined : (skip || 0) + take).map(membershipWithAccount)
      },
      findUnique: async ({ where }: any) => {
        const key = where.organizationId_accountId
        const membership = state.memberships.find((item: any) => item.organizationId === key.organizationId && item.accountId === key.accountId)
        if (!membership) return null
        const account = accountFor(membership.accountId)
        return {
          ...membership,
          account: {
            id: account.id, email: account.email, displayName: account.displayName, status: account.status, createdAt: account.createdAt,
            devices: state.devices.filter((device: any) => device.accountId === account.id && device.organizationId === membership.organizationId)
              .map((device: any) => ({
                id: device.id, name: 'Existing device', installationId: null, platform: null, clientVersion: null,
                revokedAt: null, lastSeenAt: null, createdAt: account.createdAt
              })),
            deviceGrants: state.grants.filter((grant: any) => grant.accountId === account.id && grant.organizationId === membership.organizationId)
              .map((grant: any) => ({
                id: grant.id, tokenHint: '••••secret', expiresAt: null, disabledAt: null, deletedAt: null,
                boundAt: null, deviceId: null, createdAt: account.createdAt, updatedAt: account.createdAt
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
        const memberships = state.memberships.filter((membership: any) => matchesMembership(membership, where))
        memberships.forEach((membership: any) => Object.assign(membership, data))
        return { count: memberships.length }
      }
    },
    $transaction: async (operation: any) => operation(prisma)
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

  it('returns user detail without password or grant token fields', async () => {
    const { service } = makeUsersHarness()
    const result = await service.detail('org-1', 'account-1')
    expect(result).toMatchObject({ id: 'account-1', organizationId: 'org-1', role: 'MEMBER' })
    expect(JSON.stringify(result)).not.toContain('passwordHash')
    expect(JSON.stringify(result)).not.toContain('secret-hash')
  })

  it('normalizes valid creation input and rejects a blank display name', async () => {
    const valid = plainToInstance(CreateManagedUserDto, { email: ' USER@EXAMPLE.COM ', displayName: ' 张三 ' })
    expect(valid).toMatchObject({ email: 'user@example.com', displayName: '张三' })
    expect(await validate(valid)).toEqual([])

    const invalid = plainToInstance(CreateManagedUserDto, { email: 'member@example.com', displayName: ' ' })
    expect(await validate(invalid)).not.toEqual([])
  })
})
