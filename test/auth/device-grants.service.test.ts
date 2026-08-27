import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { DeviceGrantsService } from '../../apps/api/src/device-grants.service.js'
import { DeviceGrantLinksService } from '../../apps/api/src/device-grant-links.service.js'
import { DeviceGrantFilter } from '../../apps/api/src/device-grants.dto.js'

type Grant = {
  id: string
  organizationId: string
  accountId: string
  expiresAt: Date | null
  disabledAt: Date | null
  deletedAt: Date | null
  boundAt: Date | null
  deviceId: string | null
  createdById: string
  createdAt: Date
  updatedAt: Date
}

function makeGrantHarness(options: { bound?: boolean; membershipStatus?: string; membershipRole?: string; accountStatus?: string; organizationEnabled?: boolean; deactivateBeforeTransaction?: 'account' | 'membership' | 'organization'; secondUser?: boolean; bindOnLock?: boolean; eligibilityLockTime?: Date } = {}) {
  process.env.MASTER_KEY ||= Buffer.alloc(32, 7).toString('base64')
  const createdAt = new Date('2026-08-26T00:00:00.000Z')
  const state: { organization: any; accounts: any[]; memberships: any[]; grants: Grant[]; links: any[]; devices: any[]; audits: any[] } = {
    organization: { id: 'org-1', enabled: options.organizationEnabled ?? true },
    accounts: [{ id: 'account-1', email: 'member@example.com', displayName: 'Member', status: options.accountStatus || 'ACTIVE' }],
    memberships: [{ organizationId: 'org-1', accountId: 'account-1', role: options.membershipRole || 'MEMBER', status: options.membershipStatus || 'ACTIVE' }],
    grants: [{
      id: 'grant-1', organizationId: 'org-1', accountId: 'account-1',
      expiresAt: null, disabledAt: null, deletedAt: null, boundAt: options.bound ? createdAt : null,
      deviceId: options.bound ? 'device-1' : null, createdById: 'admin-1', createdAt, updatedAt: createdAt
    }],
    links: [{ id: 'link-1', deviceGrantId: 'grant-1', issuanceOrder: 1n, secretHash: 'existing-secret-hash', secretHint: '••••secret', secretEncrypted: { ciphertext: 'encrypted-secret' }, expiresAt: null, revokedAt: null, consumedAt: null, createdAt }], devices: options.bound ? [{ id: 'device-1', organizationId: 'org-1', accountId: 'account-1', name: 'Member laptop', platform: 'windows', clientVersion: '1.0.0', revokedAt: null, lastSeenAt: null, createdAt }] : [], audits: []
  }
  const calls = { rowLocks: [] as unknown[][], rowLockTables: [] as string[], eligibilityLocks: [] as unknown[][], grantReadsAfterLock: [] as boolean[], linkCreate: [] as any[] }
  let lockHeld = false
  if (options.secondUser) {
    state.accounts.push({ id: 'account-2', email: 'other@example.com', displayName: 'Other', status: 'ACTIVE' })
    state.memberships.push({ organizationId: 'org-1', accountId: 'account-2', role: 'MEMBER', status: 'ACTIVE' })
    state.grants.push({
      id: 'grant-2', organizationId: 'org-1', accountId: 'account-1',
      expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt
    }, {
      id: 'grant-3', organizationId: 'org-1', accountId: 'account-2',
      expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt
    })
    state.links.push(
      { id: 'link-2', deviceGrantId: 'grant-2', issuanceOrder: 2n, secretHash: 'another-secret-hash', secretHint: '••••second', secretEncrypted: { ciphertext: 'second-encrypted-secret' }, expiresAt: null, revokedAt: null, consumedAt: null, createdAt },
      { id: 'link-3', deviceGrantId: 'grant-3', issuanceOrder: 3n, secretHash: 'third-secret-hash', secretHint: '••••third', secretEncrypted: { ciphertext: 'third-encrypted-secret' }, expiresAt: null, revokedAt: null, consumedAt: null, createdAt }
    )
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
  const serializeGrant = (grant: Grant, select?: any) => {
    const orderBy = select?.links?.orderBy || { createdAt: 'desc' }
    const field = Object.keys(orderBy)[0]
    const links = state.links.filter(link => link.deviceGrantId === grant.id).sort((a, b) => a[field] === b[field] ? 0 : a[field] > b[field] ? -1 : 1).slice(0, 1)
    return { ...grant, device: deviceFor(grant.deviceId), links }
  }
  const prisma: any = {
    auditLog: { create: async ({ data }: any) => { state.audits.push(data); return data } },
    membership: {
      findUnique: async ({ where }: any) => {
        const key = where.organizationId_accountId
        const membership = membershipFor(key.organizationId, key.accountId)
        return membership ? { ...membership, account: accountFor(membership.accountId), organization: state.organization } : null
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
      findMany: async ({ where, select }: any) => state.grants.filter(grant => matchesGrant(grant, where)).map(grant => serializeGrant(grant, select)),
      updateMany: async ({ where, data }: any) => {
        const grants = state.grants.filter(grant => matchesGrant(grant, where))
        grants.forEach(grant => Object.assign(grant, data, { updatedAt: new Date() }))
        return { count: grants.length }
      }
    },
    deviceGrantLink: {
      findFirst: async ({ where }: any) => state.links
        .filter(link => link.deviceGrantId === where.deviceGrantId)
        .filter(link => where.revokedAt === undefined || link.revokedAt === where.revokedAt)
        .filter(link => where.consumedAt === undefined || link.consumedAt === where.consumedAt)
        .sort((left, right) => left.issuanceOrder > right.issuanceOrder ? -1 : 1)[0] ?? null,
      updateMany: async ({ where, data }: any) => {
        const links = state.links
          .filter(link => link.deviceGrantId === where.deviceGrantId)
          .filter(link => where.revokedAt === undefined || link.revokedAt === where.revokedAt)
          .filter(link => where.consumedAt === undefined || link.consumedAt === where.consumedAt)
        links.forEach(link => Object.assign(link, data, { secretEncrypted: data.secretEncrypted ? null : link.secretEncrypted }))
        return { count: links.length }
      },
      create: async ({ data }: any) => {
        calls.linkCreate.push(data)
        const link = { id: `link-${state.links.length + 1}`, createdAt: new Date(), revokedAt: null, consumedAt: null, ...data }
        state.links.push(link)
        return link
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
      if (sql.includes('memberships') && sql.includes('FOR UPDATE OF m, a, o')) {
        calls.eligibilityLocks.push(query.values)
        if (options.eligibilityLockTime) vi.setSystemTime(options.eligibilityLockTime)
        const [organizationId, accountId] = query.values
        const membership = membershipFor(organizationId, accountId)
        const account = accountFor(accountId)
        return membership && account ? [{ role: membership.role, membershipStatus: membership.status, accountStatus: account.status, organizationEnabled: state.organization.enabled }] : []
      }
      if (sql.includes('device_grant_links') && sql.includes('FOR UPDATE')) {
        calls.rowLocks.push(query.values)
        calls.rowLockTables.push('device_grant_links')
        const current = state.links.find(link => link.deviceGrantId === query.values[0] && !link.revokedAt && !link.consumedAt)
        return current ? [{ id: current.id }] : []
      }
      if (sql.includes('device_grants') && sql.includes('FOR UPDATE')) {
        lockHeld = true
        calls.rowLocks.push(query.values)
        calls.rowLockTables.push('device_grants')
        if (options.bindOnLock && state.grants[0].deviceId === null) {
          const device = {
            id: 'device-bound-during-delete', organizationId: 'org-1', accountId: 'account-1', name: 'Bound during delete',
            platform: 'windows', clientVersion: '1.0.0', revokedAt: null, lastSeenAt: null, createdAt
          }
          state.devices.push(device)
          state.grants[0].deviceId = device.id
          state.grants[0].boundAt = new Date()
        }
        const [grantId, organizationId] = query.values
        return state.grants.some(grant => grant.id === grantId && grant.organizationId === organizationId) ? [{ id: grantId }] : []
      }
      return []
    },
    $transaction: async (operation: any) => {
      if (options.deactivateBeforeTransaction === 'membership') state.memberships[0].status = 'DISABLED'
      if (options.deactivateBeforeTransaction === 'account') state.accounts[0].status = 'DISABLED'
      if (options.deactivateBeforeTransaction === 'organization') state.organization.enabled = false
      return operation(prisma)
    }
  }
  return { service: new DeviceGrantsService(prisma, new DeviceGrantLinksService()), state, calls }
}

describe('device grants', () => {
  it('returns the initial secret only in the recoverable link fragment while storing its hash and hint on the link', async () => {
    const { service, state } = makeGrantHarness()
    const previousPublicUrl = process.env.PUBLIC_URL
    process.env.PUBLIC_URL = 'http://10.0.0.8:3000'
    try {
      const result = await service.create('org-1', 'admin-1', 'account-1', { expiresAt: null, linkExpiresAt: null })
      const link = new URL(result.connectionUrl).hash.slice('#link='.length)
      expect(result.connectionUrl).toBe(`http://10.0.0.8:3000/connect#link=${link}`)
      expect(link).not.toBe('')
      expect(result).not.toHaveProperty('secret')
      expect(result.currentLink).toMatchObject({ id: 'link-2', status: 'AVAILABLE', expiresAt: null })
      expect(state.grants.at(-1)).not.toHaveProperty('tokenHash')
      expect(state.grants.at(-1)).not.toHaveProperty('tokenHint')
      expect(state.links.at(-1)?.secretHash).toBeDefined()
      expect(state.links.at(-1)?.secretHint).toMatch(/^••••/)
      expect(state.links).toHaveLength(2)
      expect(result).not.toHaveProperty('tokenHash')
      expect(state.audits).toContainEqual(expect.objectContaining({ action: 'device_grant.create', resourceType: 'device_grant', resourceId: result.id, organizationId: 'org-1' }))
      expect(state.audits).toContainEqual(expect.objectContaining({ metadata: expect.objectContaining({ secretHint: state.links.at(-1)?.secretHint }) }))
      expect(JSON.stringify(state.audits)).not.toContain('tokenHint')
      expect(JSON.stringify(state.audits)).not.toContain(link)
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = previousPublicUrl
    }
  })

  for (const role of ['PLATFORM_ADMIN', 'ORG_ADMIN', 'MEMBER'] as const) {
    it(`creates an initial 7-day link for active ${role}`, async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
      const { service, calls } = makeGrantHarness({ membershipRole: role })
      const previousPublicUrl = process.env.PUBLIC_URL
      process.env.PUBLIC_URL = 'http://10.0.0.8:3000'
      try {
        const result = await service.create('org-1', 'actor-1', 'account-1', {})
        expect(result.connectionUrl).toMatch(/^http:\/\/10\.0\.0\.8:3000\/connect#link=/)
        expect(result.currentLink.expiresAt).toEqual(new Date('2026-09-03T00:00:00.000Z'))
        expect(calls.linkCreate).toHaveLength(1)
      } finally {
        if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL
        else process.env.PUBLIC_URL = previousPublicUrl
        vi.useRealTimers()
      }
    })
  }

  it('rejects disabled account, membership, or organization before writing a grant or link', async () => {
    for (const options of [{ membershipStatus: 'DISABLED' }, { accountStatus: 'DISABLED' }, { organizationEnabled: false }]) {
      const { service, state } = makeGrantHarness(options)
      await expect(service.create('org-1', 'admin-1', 'account-1', { expiresAt: null })).rejects.toMatchObject({ status: 403 })
      expect(state.grants).toHaveLength(1)
      expect(state.links).toHaveLength(1)
    }
    const { service } = makeGrantHarness()
    await expect(service.create('org-2', 'admin-1', 'account-1', { expiresAt: null })).rejects.toMatchObject({ status: 404 })
  })

  it('rechecks locked eligibility inside the transaction before creating a grant or link', async () => {
    const { service, state, calls } = makeGrantHarness({ deactivateBeforeTransaction: 'membership' })
    const previousPublicUrl = process.env.PUBLIC_URL
    process.env.PUBLIC_URL = 'http://10.0.0.8:3000'
    try {
      await expect(service.create('org-1', 'admin-1', 'account-1', { expiresAt: null })).rejects.toMatchObject({ status: 403 })
      expect(calls.eligibilityLocks).toEqual([['org-1', 'account-1']])
      expect(state.grants).toHaveLength(1)
      expect(state.links).toHaveLength(1)
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = previousPublicUrl
    }
  })

  it('keeps authorization and link expiry independent', async () => {
    const { service } = makeGrantHarness()
    const previousPublicUrl = process.env.PUBLIC_URL
    process.env.PUBLIC_URL = 'http://10.0.0.8:3000'
    try {
      const result = await service.create('org-1', 'admin-1', 'account-1', {
        expiresAt: '2026-09-10T00:00:00.000Z', linkExpiresAt: '2026-09-03T00:00:00.000Z'
      })
      expect(result.expiresAt).toEqual(new Date('2026-09-10T00:00:00.000Z'))
      expect(result.currentLink.expiresAt).toEqual(new Date('2026-09-03T00:00:00.000Z'))
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = previousPublicUrl
    }
  })

  it('rejects a non-future expiration', async () => {
    const { service } = makeGrantHarness()
    await expect(service.create('org-1', 'admin-1', 'account-1', { expiresAt: new Date().toISOString() })).rejects.toMatchObject({ status: 400 })
    await expect(service.create('org-1', 'admin-1', 'account-1', { linkExpiresAt: new Date().toISOString() })).rejects.toMatchObject({ status: 400 })
  })

  it('revalidates a custom link expiry after waiting for the eligibility lock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
    const previousPublicUrl = process.env.PUBLIC_URL
    process.env.PUBLIC_URL = 'http://10.0.0.8:3000'
    try {
      const { service, state } = makeGrantHarness({ eligibilityLockTime: new Date('2026-08-27T00:02:00.000Z') })
      await expect(service.create('org-1', 'admin-1', 'account-1', {
        linkExpiresAt: '2026-08-27T00:01:00.000Z'
      })).rejects.toMatchObject({ status: 400 })
      expect(state.grants).toHaveLength(1)
      expect(state.links).toHaveLength(1)
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = previousPublicUrl
      vi.useRealTimers()
    }
  })

  it('rejects a missing public origin before creating a grant', async () => {
    const { service, state } = makeGrantHarness()
    const previousPublicUrl = process.env.PUBLIC_URL
    delete process.env.PUBLIC_URL
    try {
      await expect(service.create('org-1', 'admin-1', 'account-1', { expiresAt: null })).rejects.toThrow('PUBLIC_URL is required')
      expect(state.grants).toHaveLength(1)
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = previousPublicUrl
    }
  })

  it('disables reversibly without revoking the device but permanently revokes the current link', async () => {
    const { service, state } = makeGrantHarness({ bound: true })
    await service.disable('org-1', 'admin-1', 'grant-1')
    expect(state.grants[0].disabledAt).toBeInstanceOf(Date)
    expect(state.devices[0].revokedAt).toBeNull()
    expect(state.links[0]).toMatchObject({ revokedAt: expect.any(Date), secretEncrypted: null })
    await service.enable('org-1', 'admin-1', 'grant-1')
    expect(state.grants[0].disabledAt).toBeNull()
    expect(state.links[0]).toMatchObject({ revokedAt: expect.any(Date), secretEncrypted: null })
  })

  it('locks link before grant when disabling so an old URL cannot revive after enable', async () => {
    const { service, state, calls } = makeGrantHarness()

    await service.disable('org-1', 'admin-1', 'grant-1')
    await service.enable('org-1', 'admin-1', 'grant-1')

    expect(calls.rowLockTables.slice(0, 2)).toEqual(['device_grant_links', 'device_grants'])
    expect(state.links[0]).toMatchObject({ revokedAt: expect.any(Date), secretEncrypted: null })
  })

  it('soft deletes and permanently revokes the bound device', async () => {
    const { service, state } = makeGrantHarness({ bound: true })
    await service.delete('org-1', 'admin-1', 'grant-1')
    expect(state.grants[0].deletedAt).toBeInstanceOf(Date)
    expect(state.devices[0].revokedAt).toBeInstanceOf(Date)
    expect(state.links[0]).toMatchObject({ revokedAt: expect.any(Date), secretEncrypted: null })
    expect(state.audits).toContainEqual(expect.objectContaining({ action: 'device_grant.delete', resourceType: 'device_grant', resourceId: 'grant-1' }))
  })

  it('locks link before grant and clears the recoverable URL when deleting an unbound grant', async () => {
    const { service, state, calls } = makeGrantHarness()

    await service.delete('org-1', 'admin-1', 'grant-1')

    expect(calls.rowLockTables.slice(0, 2)).toEqual(['device_grant_links', 'device_grants'])
    expect(state.links[0]).toMatchObject({ revokedAt: expect.any(Date), secretEncrypted: null })
  })

  it('locks before reading the grant and revokes a device bound while delete waits for that lock', async () => {
    const { service, state, calls } = makeGrantHarness({ bindOnLock: true })
    await service.delete('org-1', 'admin-1', 'grant-1')
    expect(calls.rowLocks).toEqual([['grant-1'], ['grant-1', 'org-1']])
    expect(calls.grantReadsAfterLock).toEqual([true])
    expect(state.devices[0].revokedAt).toBeInstanceOf(Date)
  })

  it('does not enable or extend a deleted grant', async () => {
    const { service } = makeGrantHarness()
    await service.delete('org-1', 'admin-1', 'grant-1')
    await expect(service.enable('org-1', 'admin-1', 'grant-1')).rejects.toMatchObject({ status: 404 })
    await expect(service.updateExpiration('org-1', 'admin-1', 'grant-1', new Date(Date.now() + 3_600_000).toISOString())).rejects.toMatchObject({ status: 404 })
  })

  it('paginates grouped grants with their latest link summary and never serializes link credentials', async () => {
    const { service, state } = makeGrantHarness({ secondUser: true })
    const linkExpiry = new Date('2026-08-25T00:00:00.000Z')
    state.links.push(
      { id: 'link-1-revoked', deviceGrantId: 'grant-1', issuanceOrder: 4n, secretHash: 'older-link-hash', secretHint: '••••old', secretEncrypted: { ciphertext: 'older-encrypted-secret' }, expiresAt: null, revokedAt: new Date('2026-08-27T00:00:00.000Z'), consumedAt: null, createdAt: new Date('2026-08-25T00:00:00.000Z') },
      { id: 'link-2-expired', deviceGrantId: 'grant-2', issuanceOrder: 5n, secretHash: 'latest-link-hash', secretHint: '••••abcd', secretEncrypted: { ciphertext: 'latest-encrypted-secret' }, expiresAt: linkExpiry, revokedAt: null, consumedAt: null, createdAt: new Date('2026-08-25T00:00:00.000Z') },
      { id: 'link-3-consumed', deviceGrantId: 'grant-3', issuanceOrder: 6n, secretHash: 'consumed-link-hash', secretHint: '••••used', secretEncrypted: { ciphertext: 'consumed-encrypted-secret' }, expiresAt: null, revokedAt: null, consumedAt: new Date('2026-08-28T00:00:00.000Z'), createdAt: new Date('2026-08-25T00:00:00.000Z') }
    )
    const result = await service.listGrouped('org-1', { limit: 1, offset: 0, status: DeviceGrantFilter.ALL })
    expect(result).toMatchObject({ total: 2, limit: 1, offset: 0, items: [{ id: 'account-1', deviceGrants: [
      { id: 'grant-1', currentLink: { id: 'link-1-revoked', secretHint: '••••old', status: 'REVOKED' } },
      { id: 'grant-2', currentLink: { id: 'link-2-expired', secretHint: '••••abcd', status: 'EXPIRED', expiresAt: linkExpiry } }
    ] }] })
    expect(result.items[0].deviceGrants[0]).not.toHaveProperty('tokenHash')
    expect(result.items[0].deviceGrants[0]).not.toHaveProperty('tokenHint')
    expect(JSON.stringify(result)).not.toContain('existing-secret-hash')
    expect(JSON.stringify(result)).not.toContain('latest-encrypted-secret')
    expect(JSON.stringify(result)).not.toContain('connectionUrl')
    const all = await service.listGrouped('org-1', { limit: 50, offset: 0, status: DeviceGrantFilter.ALL })
    expect(all.items.find(item => item.id === 'account-2')).toMatchObject({
      deviceGrants: [{ id: 'grant-3', currentLink: { id: 'link-3-consumed', secretHint: '••••used', status: 'CONSUMED' } }]
    })
  })

  it('applies mutually exclusive status filters and excludes deleted grants from ALL', async () => {
    const { service, state } = makeGrantHarness({ bound: true })
    const createdAt = state.grants[0].createdAt
    state.grants.push(
      { id: 'grant-available', organizationId: 'org-1', accountId: 'account-1', expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt },
      { id: 'grant-disabled', organizationId: 'org-1', accountId: 'account-1', expiresAt: null, disabledAt: new Date(), deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt },
      { id: 'grant-expired', organizationId: 'org-1', accountId: 'account-1', expiresAt: new Date(Date.now() - 1_000), disabledAt: null, deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt },
      { id: 'grant-deleted', organizationId: 'org-1', accountId: 'account-1', expiresAt: null, disabledAt: null, deletedAt: new Date(), boundAt: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt }
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
