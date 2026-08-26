import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { DeviceGrantsService } from '../../apps/api/src/device-grants.service.js'
import { DeviceGrantFilter } from '../../apps/api/src/device-grants.dto.js'
import { hashOpaqueToken } from '../../packages/security/src/tokens.js'

type Grant = {
  id: string
  organizationId: string
  accountId: string
  tokenHash: string
  tokenHint: string
  expiresAt: Date | null
  disabledAt: Date | null
  deletedAt: Date | null
  boundAt: Date | null
  deviceId: string | null
  createdById: string
  createdAt: Date
  updatedAt: Date
}

function makeGrantHarness(options: { bound?: boolean; membershipStatus?: string; accountStatus?: string; secondUser?: boolean; bindOnLock?: boolean } = {}) {
  const createdAt = new Date('2026-08-26T00:00:00.000Z')
  const state: { accounts: any[]; memberships: any[]; grants: Grant[]; devices: any[] } = {
    accounts: [{ id: 'account-1', email: 'member@example.com', displayName: 'Member', status: options.accountStatus || 'ACTIVE' }],
    memberships: [{ organizationId: 'org-1', accountId: 'account-1', role: 'MEMBER', status: options.membershipStatus || 'ACTIVE' }],
    grants: [{
      id: 'grant-1', organizationId: 'org-1', accountId: 'account-1', tokenHash: 'existing-secret-hash', tokenHint: '••••secret',
      expiresAt: null, disabledAt: null, deletedAt: null, boundAt: options.bound ? createdAt : null,
      deviceId: options.bound ? 'device-1' : null, createdById: 'admin-1', createdAt, updatedAt: createdAt
    }],
    devices: options.bound ? [{ id: 'device-1', organizationId: 'org-1', accountId: 'account-1', name: 'Member laptop', platform: 'windows', clientVersion: '1.0.0', revokedAt: null, lastSeenAt: null, createdAt }] : []
  }
  const calls = { rowLocks: [] as unknown[][], grantReadsAfterLock: [] as boolean[] }
  let lockHeld = false
  if (options.secondUser) {
    state.accounts.push({ id: 'account-2', email: 'other@example.com', displayName: 'Other', status: 'ACTIVE' })
    state.memberships.push({ organizationId: 'org-1', accountId: 'account-2', role: 'MEMBER', status: 'ACTIVE' })
    state.grants.push({
      id: 'grant-2', organizationId: 'org-1', accountId: 'account-1', tokenHash: 'another-secret-hash', tokenHint: '••••second',
      expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt
    }, {
      id: 'grant-3', organizationId: 'org-1', accountId: 'account-2', tokenHash: 'third-secret-hash', tokenHint: '••••third',
      expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt
    })
  }

  const accountFor = (accountId: string) => state.accounts.find(account => account.id === accountId)
  const deviceFor = (deviceId: string | null) => state.devices.find(device => device.id === deviceId) || null
  const matchesGrant = (grant: Grant, where: any): boolean => {
    if (!where) return true
    if (where.OR && !where.OR.some((part: any) => matchesGrant(grant, part))) return false
    if (where.organizationId && grant.organizationId !== where.organizationId) return false
    if (where.id && grant.id !== where.id) return false
    if (where.accountId?.in && !where.accountId.in.includes(grant.accountId)) return false
    if (typeof where.accountId === 'string' && grant.accountId !== where.accountId) return false
    for (const field of ['deletedAt', 'disabledAt', 'expiresAt', 'deviceId'] as const) {
      const expected = where[field]
      const actual = grant[field]
      if (expected === undefined) continue
      if (expected === null && actual !== null) return false
      if (expected?.not === null && actual === null) return false
      if (expected?.lte && (!(actual instanceof Date) || actual > expected.lte)) return false
      if (expected?.gt && (!(actual instanceof Date) || actual <= expected.gt)) return false
    }
    return true
  }
  const membershipFor = (organizationId: string, accountId: string) =>
    state.memberships.find(membership => membership.organizationId === organizationId && membership.accountId === accountId) || null
  const serializeGrant = (grant: Grant) => ({ ...grant, device: deviceFor(grant.deviceId) })
  const prisma: any = {
    membership: {
      findUnique: async ({ where }: any) => {
        const key = where.organizationId_accountId
        const membership = membershipFor(key.organizationId, key.accountId)
        return membership ? { ...membership, account: accountFor(membership.accountId) } : null
      },
      findMany: async ({ where, skip = 0, take }: any) => state.memberships
        .filter(membership => membership.organizationId === where.organizationId)
        .filter(membership => {
          const grantWhere = where.account?.deviceGrants?.some
          return !grantWhere || state.grants.some(grant => grant.accountId === membership.accountId && matchesGrant(grant, grantWhere))
        })
        .slice(skip, take === undefined ? undefined : skip + take)
        .map(membership => ({ ...membership, account: accountFor(membership.accountId) })),
      count: async ({ where }: any) => state.memberships
        .filter(membership => membership.organizationId === where.organizationId)
        .filter(membership => {
          const grantWhere = where.account?.deviceGrants?.some
          return !grantWhere || state.grants.some(grant => grant.accountId === membership.accountId && matchesGrant(grant, grantWhere))
        }).length
    },
    deviceGrant: {
      create: async ({ data }: any) => {
        const grant: Grant = { id: `grant-${state.grants.length + 1}`, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null, createdAt: new Date(), updatedAt: new Date(), ...data }
        state.grants.push(grant)
        return serializeGrant(grant)
      },
      findFirst: async ({ where }: any) => {
        calls.grantReadsAfterLock.push(lockHeld)
        const grant = state.grants.find(item => matchesGrant(item, where))
        return grant ? serializeGrant(grant) : null
      },
      findMany: async ({ where }: any) => state.grants.filter(grant => matchesGrant(grant, where)).map(serializeGrant),
      updateMany: async ({ where, data }: any) => {
        const grants = state.grants.filter(grant => matchesGrant(grant, where))
        grants.forEach(grant => Object.assign(grant, data, { updatedAt: new Date() }))
        return { count: grants.length }
      }
    },
    device: {
      updateMany: async ({ where, data }: any) => {
        const devices = state.devices.filter(device => device.id === where.id && device.organizationId === where.organizationId)
        devices.forEach(device => Object.assign(device, data))
        return { count: devices.length }
      }
    },
    $queryRaw: async (query: any) => {
      const sql = query.strings?.join('') || ''
      if (sql.includes('device_grants') && sql.includes('FOR UPDATE')) {
        lockHeld = true
        calls.rowLocks.push(query.values)
        if (options.bindOnLock && state.grants[0].deviceId === null) {
          const device = {
            id: 'device-bound-during-delete', organizationId: 'org-1', accountId: 'account-1', name: 'Bound during delete',
            platform: 'windows', clientVersion: '1.0.0', revokedAt: null, lastSeenAt: null, createdAt
          }
          state.devices.push(device)
          state.grants[0].deviceId = device.id
          state.grants[0].boundAt = new Date()
        }
      }
      return []
    },
    $transaction: async (operation: any) => operation(prisma)
  }
  return { service: new DeviceGrantsService(prisma), state, calls }
}

describe('device grants', () => {
  it('returns the one-time secret only in the connection URL fragment while storing only hash and hint', async () => {
    const { service, state } = makeGrantHarness()
    const previousPublicUrl = process.env.PUBLIC_URL
    process.env.PUBLIC_URL = 'http://10.0.0.8:3000'
    try {
      const result = await service.create('org-1', 'admin-1', 'account-1', { expiresAt: null })
      const token = new URL(result.connectionUrl).hash.slice('#token='.length)
      expect(result.connectionUrl).toBe(`http://10.0.0.8:3000/connect#token=${token}`)
      expect(token).not.toBe('')
      expect(result).not.toHaveProperty('token')
      expect(state.grants.at(-1)?.tokenHash).toBe(hashOpaqueToken(token))
      expect(state.grants.at(-1)?.tokenHint).toMatch(/^••••/)
      expect(JSON.stringify(result)).not.toContain('tokenHash')
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = previousPublicUrl
    }
  })

  it('requires an active MEMBER membership and globally active account in the current organization', async () => {
    for (const options of [{ membershipStatus: 'DISABLED' }, { accountStatus: 'DISABLED' }]) {
      const { service } = makeGrantHarness(options)
      await expect(service.create('org-1', 'admin-1', 'account-1', { expiresAt: null })).rejects.toMatchObject({ status: 403 })
    }
    const { service } = makeGrantHarness()
    await expect(service.create('org-2', 'admin-1', 'account-1', { expiresAt: null })).rejects.toMatchObject({ status: 404 })
  })

  it('rejects a non-future expiration', async () => {
    const { service } = makeGrantHarness()
    await expect(service.create('org-1', 'admin-1', 'account-1', { expiresAt: new Date().toISOString() })).rejects.toMatchObject({ status: 400 })
  })

  it('disables reversibly without revoking the device', async () => {
    const { service, state } = makeGrantHarness({ bound: true })
    await service.disable('org-1', 'grant-1')
    expect(state.grants[0].disabledAt).toBeInstanceOf(Date)
    expect(state.devices[0].revokedAt).toBeNull()
    await service.enable('org-1', 'grant-1')
    expect(state.grants[0].disabledAt).toBeNull()
  })

  it('soft deletes and permanently revokes the bound device', async () => {
    const { service, state } = makeGrantHarness({ bound: true })
    await service.delete('org-1', 'grant-1')
    expect(state.grants[0].deletedAt).toBeInstanceOf(Date)
    expect(state.devices[0].revokedAt).toBeInstanceOf(Date)
  })

  it('locks before reading the grant and revokes a device bound while delete waits for that lock', async () => {
    const { service, state, calls } = makeGrantHarness({ bindOnLock: true })
    await service.delete('org-1', 'grant-1')
    expect(calls.rowLocks).toEqual([['grant-1', 'org-1']])
    expect(calls.grantReadsAfterLock).toEqual([true])
    expect(state.devices[0].revokedAt).toBeInstanceOf(Date)
  })

  it('does not enable or extend a deleted grant', async () => {
    const { service } = makeGrantHarness()
    await service.delete('org-1', 'grant-1')
    await expect(service.enable('org-1', 'grant-1')).rejects.toMatchObject({ status: 404 })
    await expect(service.updateExpiration('org-1', 'grant-1', new Date(Date.now() + 3_600_000).toISOString())).rejects.toMatchObject({ status: 404 })
  })

  it('paginates grouped grant results by user and never serializes token hashes', async () => {
    const { service } = makeGrantHarness({ secondUser: true })
    const result = await service.listGrouped('org-1', { limit: 1, offset: 0, status: DeviceGrantFilter.ALL })
    expect(result).toMatchObject({ total: 2, limit: 1, offset: 0, items: [{ id: 'account-1', deviceGrants: [{ id: 'grant-1' }, { id: 'grant-2' }] }] })
    expect(JSON.stringify(result)).not.toContain('secret-hash')
    expect(JSON.stringify(result)).not.toContain('refreshTokenHash')
  })

  it('applies mutually exclusive status filters and excludes deleted grants from ALL', async () => {
    const { service, state } = makeGrantHarness({ bound: true })
    const createdAt = state.grants[0].createdAt
    state.grants.push(
      { id: 'grant-available', organizationId: 'org-1', accountId: 'account-1', tokenHash: 'available-hash', tokenHint: '••••available', expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt },
      { id: 'grant-disabled', organizationId: 'org-1', accountId: 'account-1', tokenHash: 'disabled-hash', tokenHint: '••••disabled', expiresAt: null, disabledAt: new Date(), deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt },
      { id: 'grant-expired', organizationId: 'org-1', accountId: 'account-1', tokenHash: 'expired-hash', tokenHint: '••••expired', expiresAt: new Date(Date.now() - 1_000), disabledAt: null, deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt },
      { id: 'grant-deleted', organizationId: 'org-1', accountId: 'account-1', tokenHash: 'deleted-hash', tokenHint: '••••deleted', expiresAt: null, disabledAt: null, deletedAt: new Date(), boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt }
    )
    const expected: Array<[DeviceGrantFilter, string[]]> = [
      [DeviceGrantFilter.AVAILABLE, ['grant-available']],
      [DeviceGrantFilter.BOUND, ['grant-1']],
      [DeviceGrantFilter.DISABLED, ['grant-disabled']],
      [DeviceGrantFilter.EXPIRED, ['grant-expired']],
      [DeviceGrantFilter.DELETED, ['grant-deleted']],
      [DeviceGrantFilter.ALL, ['grant-1', 'grant-available', 'grant-disabled', 'grant-expired']]
    ]
    for (const [status, grantIds] of expected) {
      const result = await service.listGrouped('org-1', { limit: 50, offset: 0, status })
      expect(result.items.flatMap(item => item.deviceGrants.map(grant => grant.id))).toEqual(grantIds)
    }
  })
})
