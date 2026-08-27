import 'reflect-metadata'
import { GUARDS_METADATA, HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthController } from '../../apps/api/src/auth.controller.js'
import { DeviceGrantLinksService } from '../../apps/api/src/device-grant-links.service.js'
import { DeviceGrantsService } from '../../apps/api/src/device-grants.service.js'
import { hashOpaqueToken } from '../../packages/security/src/tokens.js'

const link = 'g'.repeat(32)
const otherLink = 'h'.repeat(32)
const installationId = '10000000-0000-4000-8000-000000000001'
const otherInstallationId = '10000000-0000-4000-8000-000000000002'
const createdAt = new Date('2026-08-26T04:00:00.000Z')

type HarnessOptions = {
  accountStatus?: string; organizationEnabled?: boolean; membershipRole?: string; membershipStatus?: string
  disabledAt?: Date | null; deletedAt?: Date | null; grantExpiresAt?: Date | null; linkExpiresAt?: Date | null
  linkRevokedAt?: Date | null; linkConsumedAt?: Date | null; boundInstallationId?: string; deviceRevokedAt?: Date | null
  retryUntil?: Date | null; additionalGrant?: boolean; pauseRedeemLinkLock?: boolean
}

function redeemInput(installation = installationId, linkSecret = link) {
  return { link: linkSecret, device: { installationId: installation, name: '张三的工作站', platform: 'windows', clientVersion: '1.2.0' } }
}

function makeRedeemHarness(options: HarnessOptions = {}) {
  const state = {
    organization: { id: 'org-1', name: '示例组织', enabled: options.organizationEnabled ?? true },
    accounts: [{ id: 'account-1', displayName: '张三', status: options.accountStatus ?? 'ACTIVE', tokenVersion: 1 }],
    memberships: [{ organizationId: 'org-1', accountId: 'account-1', role: options.membershipRole ?? 'MEMBER', status: options.membershipStatus ?? 'ACTIVE' }],
    grants: [{
      id: 'grant-1', organizationId: 'org-1', accountId: 'account-1', tokenHash: 'legacy-grant-hash', tokenHint: '••••legacy',
      expiresAt: options.grantExpiresAt ?? null, disabledAt: options.disabledAt ?? null, deletedAt: options.deletedAt ?? null,
      boundAt: options.boundInstallationId ? createdAt : null, redeemRetryUntil: options.retryUntil ?? null,
      deviceId: options.boundInstallationId ? 'device-1' : null, createdById: 'admin-1', createdAt, updatedAt: createdAt
    }],
    links: [{
      id: 'link-1', deviceGrantId: 'grant-1', secretHash: hashOpaqueToken(link), secretHint: '••••link', secretEncrypted: { ciphertext: 'encrypted' },
      expiresAt: options.linkExpiresAt ?? null, revokedAt: options.linkRevokedAt ?? null, consumedAt: options.linkConsumedAt ?? null,
      createdById: 'admin-1', createdAt
    }],
    devices: options.boundInstallationId ? [{
      id: 'device-1', organizationId: 'org-1', accountId: 'account-1', installationId: options.boundInstallationId,
      name: 'Existing device', platform: 'windows', clientVersion: '1.0.0', refreshTokenHash: 'old-refresh-hash',
      revokedAt: options.deviceRevokedAt ?? null, lastSeenAt: null, createdAt
    }] : [] as any[], audits: [] as any[]
  }
  if (options.additionalGrant) {
    state.grants.push({ id: 'grant-2', organizationId: 'org-1', accountId: 'account-1', tokenHash: 'legacy-grant-hash-2', tokenHint: '••••legacy-2', expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, redeemRetryUntil: null, deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt })
    state.links.push({ id: 'link-2', deviceGrantId: 'grant-2', secretHash: hashOpaqueToken(otherLink), secretHint: '••••other-link', secretEncrypted: { ciphertext: 'encrypted' }, expiresAt: null, revokedAt: null, consumedAt: null, createdById: 'admin-1', createdAt })
  }
  const calls = { rowLocks: [] as unknown[][], lockRequests: [] as string[] }
  const queues = new Map<string, Promise<void>>()
  let redeemLinkLockEntered: (() => void) | undefined
  let releaseRedeemLinkLock: (() => void) | undefined
  const redeemLinkLockWaiter = new Promise<void>(resolve => { redeemLinkLockEntered = resolve })
  const redeemLinkLockPause = new Promise<void>(resolve => { releaseRedeemLinkLock = resolve })
  const accountFor = (id: string) => state.accounts.find(account => account.id === id) || null
  const deviceFor = (id: string | null) => state.devices.find(device => device.id === id) || null
  const membershipFor = (organizationId: string, accountId: string) => state.memberships.find(membership => membership.organizationId === organizationId && membership.accountId === accountId) || null
  const grantFor = (id: string) => state.grants.find(grant => grant.id === id) || null
  const linkForHash = (secretHash: string) => state.links.find(item => item.secretHash === secretHash) || null
  const linkForId = (id: string) => state.links.find(item => item.id === id) || null
  const grantWithRelations = (grant: any) => grant && { ...grant, account: accountFor(grant.accountId), organization: state.organization, device: deviceFor(grant.deviceId) }
  const linkWithGrant = (item: any) => item && { ...item, deviceGrant: grantWithRelations(grantFor(item.deviceGrantId)) }
  const prisma: any = {
    auditLog: { create: async ({ data }: any) => { state.audits.push(data); return data } },
    deviceGrantLink: {
      findUnique: async ({ where }: any) => linkWithGrant(where.secretHash ? linkForHash(where.secretHash) : linkForId(where.id)),
      findFirst: async ({ where }: any) => state.links.filter(item => item.deviceGrantId === where.deviceGrantId && item.revokedAt === where.revokedAt && item.consumedAt === where.consumedAt).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null,
      update: async ({ where, data }: any) => {
        const item = linkForId(where.id)
        if (!item) throw new Error('Link not found')
        Object.assign(item, data, { ...(data.secretEncrypted ? { secretEncrypted: null } : {}) })
        return linkWithGrant(item)
      },
      updateMany: async ({ where, data }: any) => {
        const matching = state.links.filter(item => item.deviceGrantId === where.deviceGrantId && item.revokedAt === where.revokedAt && item.consumedAt === where.consumedAt)
        matching.forEach(item => Object.assign(item, data, { ...(data.secretEncrypted ? { secretEncrypted: null } : {}) }))
        return { count: matching.length }
      },
      create: async ({ data }: any) => {
        if (state.links.some(item => item.deviceGrantId === data.deviceGrantId && !item.revokedAt && !item.consumedAt)) throw { code: 'P2002', meta: { target: ['device_grant_links_one_current_per_grant'] } }
        const item = { id: `link-${state.links.length + 1}`, createdAt: new Date(), revokedAt: null, consumedAt: null, ...data }
        state.links.push(item)
        return item
      }
    },
    deviceGrant: {
      findUnique: async ({ where }: any) => grantWithRelations(grantFor(where.id)),
      findFirst: async ({ where }: any) => grantFor(where.id)?.organizationId === where.organizationId ? grantFor(where.id) : null,
      update: async ({ where, data }: any) => { const grant = grantFor(where.id); if (!grant) throw new Error('Grant not found'); Object.assign(grant, data, { updatedAt: new Date() }); return grantWithRelations(grant) }
    },
    membership: { findUnique: async ({ where }: any) => membershipFor(where.organizationId_accountId.organizationId, where.organizationId_accountId.accountId) },
    device: {
      findFirst: async ({ where }: any) => state.devices.find(device => device.installationId === where.installationId && (where.revokedAt === undefined || device.revokedAt === where.revokedAt)) || null,
      create: async ({ data }: any) => { if (state.devices.some(device => device.installationId === data.installationId && device.revokedAt === null)) throw { code: 'P2002', meta: { target: ['installation_id'] } }; const device = { id: `device-${state.devices.length + 1}`, revokedAt: null, lastSeenAt: null, createdAt: new Date(), ...data }; state.devices.push(device); return device },
      update: async ({ where, data }: any) => { const device = deviceFor(where.id); if (!device) throw new Error('Device not found'); Object.assign(device, data); return device }
    },
    $transaction: async (operation: any) => {
      const releases: Array<() => void> = []
      const transaction = { ...prisma, $queryRaw: async (query: any) => {
        const value = query.values[0] as string
        const sql = query.strings.join('')
        const isLinkLock = sql.includes('device_grant_links')
        const isSecretLookup = sql.includes('secret_hash')
        const lockedLink = isLinkLock ? (isSecretLookup ? linkForHash(value) : state.links.find(item => item.deviceGrantId === value && !item.revokedAt && !item.consumedAt)) : null
        const key = `${isLinkLock ? 'link' : 'grant'}:${lockedLink?.id ?? value}`
        calls.lockRequests.push(isLinkLock ? 'device_grant_links' : 'device_grants')
        const previous = queues.get(key) || Promise.resolve()
        queues.set(key, new Promise<void>(resolve => { releases.push(resolve) }))
        await previous; calls.rowLocks.push(query.values)
        if (options.pauseRedeemLinkLock && isLinkLock && isSecretLookup) {
          redeemLinkLockEntered!()
          await redeemLinkLockPause
        }
        if (isLinkLock) return lockedLink ? [{ id: lockedLink.id, deviceGrantId: lockedLink.deviceGrantId }] : []
        return grantFor(value) ? [{ id: value }] : []
      } }
      try { return await operation(transaction) } finally { releases.forEach(release => release()) }
    }
  }
  return {
    service: new DeviceGrantsService(prisma), prisma, state, calls,
    waitForRedeemLinkLock: () => redeemLinkLockWaiter, releaseRedeemLinkLock: () => releaseRedeemLinkLock!()
  }
}

function errorCode(error: unknown) { return (error as any).getResponse().code }
let initialJwtSecret: string | undefined
beforeEach(() => { initialJwtSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'test-secret' })
afterEach(() => { if (initialJwtSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = initialJwtSecret })

describe('link-based device grant redemption', () => {
  it('previews independent link and authorization lifecycle with server time', async () => {
    const { service, state } = makeRedeemHarness({ grantExpiresAt: new Date('2026-12-31T00:00:00.000Z'), linkExpiresAt: new Date('2026-09-01T00:00:00.000Z') })
    const preview = await service.preview(link)
    expect(preview).toMatchObject({ account: { id: 'account-1', displayName: '张三' }, organization: { id: 'org-1', name: '示例组织' }, link: { status: 'AVAILABLE', expiresAt: new Date('2026-09-01T00:00:00.000Z') }, authorization: { status: 'AVAILABLE', expiresAt: new Date('2026-12-31T00:00:00.000Z'), serverTime: expect.any(String) } })
    expect(state.links[0].consumedAt).toBeNull()
    expect(JSON.stringify(preview)).not.toContain(state.links[0].secretHash)
  })
  it.each([
    ['unknown', 'x'.repeat(32), {}, 'invalid_link'], ['malformed', 'short', {}, 'invalid_link'],
    ['expired before disabled grant', link, { linkExpiresAt: new Date('2026-08-25T00:00:00.000Z'), disabledAt: createdAt }, 'link_expired'],
    ['revoked before disabled grant', link, { linkRevokedAt: createdAt, disabledAt: createdAt }, 'link_revoked'],
    ['consumed before disabled grant', link, { linkConsumedAt: createdAt, disabledAt: createdAt }, 'link_consumed']
  ] as const)('returns %s as a stable link error', async (_name, presentedLink, options, code) => {
    const { service } = makeRedeemHarness(options); const error = await service.preview(presentedLink).catch(error => error)
    expect(errorCode(error)).toBe(code); expect(JSON.stringify(error.getResponse())).not.toContain(presentedLink)
  })
  it.each([
    ['grant disabled', { disabledAt: createdAt }, 'grant_disabled'], ['grant expired', { grantExpiresAt: new Date('2026-08-25T00:00:00.000Z') }, 'grant_expired'], ['grant deleted', { deletedAt: createdAt }, 'grant_deleted'], ['inactive account', { accountStatus: 'DISABLED' }, 'account_inactive'], ['inactive organization', { organizationEnabled: false }, 'organization_inactive'], ['inactive membership', { membershipStatus: 'DISABLED' }, 'account_inactive']
  ] as const)('returns %s only after an available link', async (_name, options, code) => {
    const { service } = makeRedeemHarness(options); await expect(service.preview(link)).rejects.toSatisfy(error => errorCode(error) === code); await expect(service.redeem(redeemInput())).rejects.toSatisfy(error => errorCode(error) === code)
  })
  it.each(['PLATFORM_ADMIN', 'ORG_ADMIN', 'MEMBER'])('redeems for every active %s membership', async membershipRole => {
    const { service } = makeRedeemHarness({ membershipRole }); await expect(service.redeem(redeemInput())).resolves.toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) })
  })
  it('rejects the removed token request field', async () => {
    const { service } = makeRedeemHarness()
    await expect(service.redeem({ token: link, device: redeemInput().device } as any)).rejects.toSatisfy(error => errorCode(error) === 'invalid_link')
  })
  it('creates and binds one device, consumes the link, and clears only ciphertext', async () => {
    const { service, state, calls } = makeRedeemHarness(); const result = await service.redeem(redeemInput())
    expect(state.grants[0]).toMatchObject({ deviceId: 'device-1', boundAt: expect.any(Date), redeemRetryUntil: expect.any(Date) })
    expect(state.links[0]).toMatchObject({ consumedAt: expect.any(Date), secretHash: hashOpaqueToken(link), secretHint: '••••link', secretEncrypted: null })
    expect(calls.rowLocks).toEqual([[hashOpaqueToken(link)], ['grant-1']]); expect(JSON.stringify(result)).not.toContain(link); expect(JSON.stringify(state.audits)).not.toContain(link); expect(JSON.stringify(state.audits)).not.toContain(hashOpaqueToken(link))
    expect(state.audits).toContainEqual(expect.objectContaining({
      action: 'device_grant_link.redeem', resourceType: 'device_grant_link', resourceId: 'link-1',
      metadata: expect.objectContaining({ deviceGrantId: 'grant-1', secretHint: '••••link', mode: 'first_bind' })
    }))
  })
  it('allows only same-installation retry before the window and rotates its refresh token', async () => {
    const { service, state } = makeRedeemHarness({ boundInstallationId: installationId, linkConsumedAt: createdAt, retryUntil: new Date(Date.now() + 60_000) }); const first = await service.redeem(redeemInput()); const second = await service.redeem(redeemInput()); expect(second.refreshToken).not.toBe(first.refreshToken); expect(state.devices).toHaveLength(1)
    expect(state.audits).toHaveLength(2)
    expect(state.audits).toEqual(expect.arrayContaining([expect.objectContaining({
      action: 'device_grant_link.redeem', resourceType: 'device_grant_link', resourceId: 'link-1',
      metadata: expect.objectContaining({ deviceGrantId: 'grant-1', secretHint: '••••link', mode: 'idempotent_retry' })
    })]))
  })
  it.each([
    ['another installation', redeemInput(otherInstallationId), { boundInstallationId: installationId, linkConsumedAt: createdAt, retryUntil: new Date(Date.now() + 60_000) }], ['expired retry window', redeemInput(), { boundInstallationId: installationId, linkConsumedAt: createdAt, retryUntil: new Date(Date.now() - 1) }], ['revoked existing device', redeemInput(), { boundInstallationId: installationId, linkConsumedAt: createdAt, deviceRevokedAt: createdAt, retryUntil: new Date(Date.now() + 60_000) }]
  ])('rejects %s retry as consumed', async (_name, input, options) => { const { service } = makeRedeemHarness(options); await expect(service.redeem(input)).rejects.toSatisfy(error => errorCode(error) === 'link_consumed') })
  it('audits a failed redeem against the link without retaining credential material', async () => {
    const { service, state } = makeRedeemHarness({ linkExpiresAt: new Date('2026-08-25T00:00:00.000Z') })

    await expect(service.redeem(redeemInput())).rejects.toSatisfy(error => errorCode(error) === 'link_expired')

    expect(state.audits).toContainEqual(expect.objectContaining({
      action: 'device_grant_link.redeem', resourceType: 'device_grant_link', resourceId: 'link-1',
      metadata: expect.objectContaining({ outcome: 'failure', code: 'link_expired', deviceGrantId: 'grant-1', secretHint: '••••link' })
    }))
    expect(JSON.stringify(state.audits)).not.toContain(link)
    expect(JSON.stringify(state.audits)).not.toContain(hashOpaqueToken(link))
  })
  it('serializes simultaneous first redemption to exactly one bound device', async () => {
    const { service, state } = makeRedeemHarness(); const results = await Promise.allSettled([service.redeem(redeemInput()), service.redeem(redeemInput(otherInstallationId))]); expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(errorCode((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason)).toBe('link_consumed'); expect(state.devices).toHaveLength(1); expect(state.links[0].consumedAt).toEqual(expect.any(Date))
  })
  it('races regeneration behind redemption on the current link before either transaction locks the grant', async () => {
    const previousMasterKey = process.env.MASTER_KEY
    const previousPublicUrl = process.env.PUBLIC_URL
    process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
    process.env.PUBLIC_URL = 'https://ucli.example.test'
    const { service, prisma, calls, waitForRedeemLinkLock, releaseRedeemLinkLock } = makeRedeemHarness({ pauseRedeemLinkLock: true })
    const links = new DeviceGrantLinksService(prisma)
    const redemption = service.redeem(redeemInput())
    await waitForRedeemLinkLock()
    const regeneration = links.regenerate('org-1', 'admin-1', 'grant-1', { expiresAt: null })
    let results: PromiseSettledResult<unknown>[] = []
    try {
      await Promise.resolve()
      expect(calls.lockRequests.slice(0, 2)).toEqual(['device_grant_links', 'device_grant_links'])
    } finally {
      releaseRedeemLinkLock()
      results = await Promise.allSettled([redemption, regeneration])
      if (previousMasterKey === undefined) delete process.env.MASTER_KEY
      else process.env.MASTER_KEY = previousMasterKey
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = previousPublicUrl
    }
    expect(results[0]).toMatchObject({ status: 'fulfilled' })
    expect(errorCode((results[1] as PromiseRejectedResult).reason)).toBe('grant_bound')
  })
})

describe('public device-grant routes', () => {
  it('accepts only link bodies on unguarded no-store routes', async () => {
    const grants = { preview: vi.fn(async () => ({})), redeem: vi.fn(async () => ({})) }; const controller = new AuthController({} as any, grants as any)
    await controller.preview({ link, token: otherLink } as any); await controller.redeem(redeemInput() as any)
    expect(grants.preview).toHaveBeenCalledWith(link); expect(grants.redeem).toHaveBeenCalledWith(redeemInput())
    await controller.preview({ token: otherLink } as any)
    expect(grants.preview).toHaveBeenLastCalledWith(undefined)
    for (const handler of [controller.preview, controller.redeem]) { expect(Reflect.getMetadata(PATH_METADATA, handler)).toMatch(/^device-grants\/(preview|redeem)$/); expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST); expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined(); expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toContainEqual({ name: 'Cache-Control', value: 'no-store' }) }
  })
})
