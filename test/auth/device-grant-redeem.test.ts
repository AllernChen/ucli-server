import 'reflect-metadata'
import { GUARDS_METADATA, HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthController } from '../../apps/api/src/auth.controller.js'
import { DeviceGrantsService } from '../../apps/api/src/device-grants.service.js'
import { hashOpaqueToken } from '../../packages/security/src/tokens.js'

const token = 'g'.repeat(32)
const otherGrantToken = 'h'.repeat(32)
const installationId = '10000000-0000-4000-8000-000000000001'
const otherInstallationId = '10000000-0000-4000-8000-000000000002'
const createdAt = new Date('2026-08-26T04:00:00.000Z')

type HarnessOptions = {
  accountStatus?: string
  organizationEnabled?: boolean
  membershipRole?: string
  membershipStatus?: string
  disabledAt?: Date | null
  deletedAt?: Date | null
  expiresAt?: Date | null
  boundInstallationId?: string
  retryUntil?: Date | null
  additionalGrant?: boolean
}

function redeemInput(id = installationId, grantToken = token) {
  return { token: grantToken, device: { installationId: id, name: '张三的工作站', platform: 'windows', clientVersion: '1.2.0' } }
}

function makeRedeemHarness(options: HarnessOptions = {}) {
  const state = {
    organization: { id: 'org-1', name: '示例组织', enabled: options.organizationEnabled ?? true },
    accounts: [{ id: 'account-1', displayName: '张三', status: options.accountStatus ?? 'ACTIVE', tokenVersion: 1 }],
    memberships: [{ organizationId: 'org-1', accountId: 'account-1', role: options.membershipRole ?? 'MEMBER', status: options.membershipStatus ?? 'ACTIVE' }],
    grants: [{
      id: 'grant-1', organizationId: 'org-1', accountId: 'account-1', tokenHash: hashOpaqueToken(token), tokenHint: '••••secret',
      expiresAt: options.expiresAt ?? null, disabledAt: options.disabledAt ?? null, deletedAt: options.deletedAt ?? null,
      boundAt: options.boundInstallationId ? createdAt : null, redeemRetryUntil: options.retryUntil ?? null,
      deviceId: options.boundInstallationId ? 'device-1' : null, createdById: 'admin-1', createdAt, updatedAt: createdAt
    }],
    devices: options.boundInstallationId ? [{
      id: 'device-1', organizationId: 'org-1', accountId: 'account-1', installationId: options.boundInstallationId,
      name: 'Existing device', platform: 'windows', clientVersion: '1.0.0', refreshTokenHash: 'old-refresh-hash', revokedAt: null, lastSeenAt: null, createdAt
    }] : [] as any[], audits: [] as any[]
  }
  if (options.additionalGrant) {
    state.grants.push({
      id: 'grant-2', organizationId: 'org-1', accountId: 'account-1', tokenHash: hashOpaqueToken(otherGrantToken), tokenHint: '••••other',
      expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, redeemRetryUntil: null,
      deviceId: null, createdById: 'admin-1', createdAt, updatedAt: createdAt
    })
  }
  const calls = { rowLocks: [] as unknown[][], grantReadsAfterLock: [] as boolean[] }
  let lockHeld = false
  const rowLockQueues = new Map<string, Promise<void>>()

  const accountFor = (id: string) => state.accounts.find(account => account.id === id) || null
  const deviceFor = (id: string | null) => state.devices.find(device => device.id === id) || null
  const membershipFor = (organizationId: string, accountId: string) =>
    state.memberships.find(membership => membership.organizationId === organizationId && membership.accountId === accountId) || null
  const grantFor = (where: any) => state.grants.find(grant =>
    (!where.id || grant.id === where.id) && (!where.tokenHash || grant.tokenHash === where.tokenHash)
  ) || null
  const grantWithRelations = (grant: any) => grant && {
    ...grant, account: accountFor(grant.accountId), organization: state.organization, device: deviceFor(grant.deviceId)
  }

  const prisma: any = {
    auditLog: { create: async ({ data }: any) => { state.audits.push(data); return data } },
    deviceGrant: {
      findUnique: async ({ where }: any) => {
        calls.grantReadsAfterLock.push(lockHeld)
        return grantWithRelations(grantFor(where))
      },
      update: async ({ where, data }: any) => {
        const grant = grantFor(where)
        if (!grant) throw new Error('Grant not found')
        Object.assign(grant, data, { updatedAt: new Date() })
        return grantWithRelations(grant)
      }
    },
    membership: {
      findUnique: async ({ where }: any) => {
        const key = where.organizationId_accountId
        return membershipFor(key.organizationId, key.accountId)
      }
    },
    device: {
      findUnique: async ({ where }: any) => state.devices.find(device => device.installationId === where.installationId) || null,
      findFirst: async ({ where }: any) => state.devices.find(device => device.installationId === where.installationId && (where.revokedAt === undefined || device.revokedAt === where.revokedAt)) || null,
      create: async ({ data }: any) => {
        if (state.devices.some(device => device.installationId === data.installationId && device.revokedAt === null)) {
          throw { code: 'P2002', meta: { modelName: 'Device', target: ['installation_id'] } }
        }
        const device = { id: `device-${state.devices.length + 1}`, revokedAt: null, lastSeenAt: null, createdAt: new Date(), ...data }
        state.devices.push(device)
        return device
      },
      update: async ({ where, data }: any) => {
        const device = deviceFor(where.id)
        if (!device) throw new Error('Device not found')
        Object.assign(device, data)
        return device
      }
    },
    $transaction: async (operation: any) => {
      let release: (() => void) | undefined
      const transaction = {
        ...prisma,
        $queryRaw: async (query: any) => {
          const tokenHash = query.values[0] as string
          const waitFor = rowLockQueues.get(tokenHash) || Promise.resolve()
          rowLockQueues.set(tokenHash, new Promise<void>(resolve => { release = resolve }))
          await waitFor
          lockHeld = true
          calls.rowLocks.push(query.values)
          const matched = state.grants.find(grant => grant.tokenHash === tokenHash)
          return matched ? [{ id: matched.id }] : []
        }
      }
      try { return await operation(transaction) } finally { release?.() }
    }
  }
  return { service: new DeviceGrantsService(prisma), state, calls }
}

function errorCode(error: unknown) {
  return (error as any).getResponse().code
}

let initialJwtSecret: string | undefined
beforeEach(() => {
  initialJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = 'test-secret'
})
afterEach(() => {
  if (initialJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = initialJwtSecret
})

describe('device grant redemption', () => {
  it('previews a known grant without consuming it', async () => {
    const { service, state } = makeRedeemHarness()
    const preview = await service.preview(token)
    expect(preview).toMatchObject({
      account: { id: 'account-1', displayName: '张三' }, organization: { id: 'org-1', name: '示例组织' },
      status: 'AVAILABLE', authorization: { expiresAt: null }
    })
    expect(state.grants[0].boundAt).toBeNull()
    expect(JSON.stringify(preview)).not.toContain(state.grants[0].tokenHash)
  })

  it.each([
    ['grant_disabled', { disabledAt: createdAt }, 'DISABLED'],
    ['grant_expired', { expiresAt: new Date('2026-08-26T03:59:59.000Z'), membershipStatus: 'DISABLED' }, 'EXPIRED'],
    ['grant_deleted', { deletedAt: createdAt, accountStatus: 'DISABLED' }, 'DELETED']
  ])('previews known %s grants with their derived status but refuses redemption', async (code, options, status) => {
    const { service, state } = makeRedeemHarness(options)
    await expect(service.preview(token)).resolves.toMatchObject({ status })
    await expect(service.redeem(redeemInput())).rejects.toSatisfy(error => errorCode(error) === code)
    expect(state.grants[0].boundAt).toBeNull()
  })

  it('binds exactly one device and returns credentials without persisted hashes', async () => {
    const { service, state, calls } = makeRedeemHarness()
    const result = await service.redeem(redeemInput())
    expect(result).toMatchObject({
      expiresIn: 900, account: { id: 'account-1', displayName: '张三' }, organization: { id: 'org-1', name: '示例组织' },
      authorization: { expiresAt: null }
    })
    expect(result.accessToken).toEqual(expect.any(String))
    expect(result.refreshToken).toEqual(expect.any(String))
    expect(state.grants[0]).toMatchObject({ deviceId: 'device-1', boundAt: expect.any(Date), redeemRetryUntil: expect.any(Date) })
    expect(state.devices[0].refreshTokenHash).toBe(hashOpaqueToken(result.refreshToken))
    expect(state.grants[0].redeemRetryUntil!.getTime() - state.grants[0].boundAt!.getTime()).toBe(10 * 60_000)
    expect(calls.rowLocks).toEqual([[hashOpaqueToken(token)]])
    expect(calls.grantReadsAfterLock).toEqual([true])
    expect(JSON.stringify(result)).not.toContain(state.grants[0].tokenHash)
    expect(JSON.stringify(result)).not.toContain(state.devices[0].refreshTokenHash)
    expect(state.audits).toContainEqual(expect.objectContaining({ action: 'device_grant.redeem', resourceType: 'device_grant', resourceId: 'grant-1', metadata: expect.objectContaining({ outcome: 'success', mode: 'first_bind' }) }))
  })

  it('permits a new grant to reuse an installation after its historical device was permanently revoked', async () => {
    const { service, state } = makeRedeemHarness()
    state.devices.push({ id: 'historical-device', organizationId: 'org-1', accountId: 'account-1', installationId,
      name: 'Old device', platform: 'windows', clientVersion: '1.0.0', refreshTokenHash: 'old', revokedAt: new Date(), lastSeenAt: null, createdAt })
    await expect(service.redeem(redeemInput())).resolves.toMatchObject({ account: { id: 'account-1' } })
    expect(state.devices.filter(device => device.installationId === installationId)).toHaveLength(2)
  })

  it('allows the same installation to retry within ten minutes and rotates its refresh token', async () => {
    const { service, state } = makeRedeemHarness({ boundInstallationId: installationId, retryUntil: new Date(Date.now() + 60_000) })
    const first = await service.redeem(redeemInput())
    const second = await service.redeem(redeemInput())
    expect(second.refreshToken).not.toBe(first.refreshToken)
    expect(state.devices[0].refreshTokenHash).toBe(hashOpaqueToken(second.refreshToken))
  })

  it.each([
    ['another installation', redeemInput(otherInstallationId), { boundInstallationId: installationId, retryUntil: new Date(Date.now() + 60_000) }],
    ['an expired retry window', redeemInput(installationId), { boundInstallationId: installationId, retryUntil: new Date(Date.now() - 1) }]
  ])('rejects %s after a grant is bound', async (_, input, options) => {
    const { service } = makeRedeemHarness(options)
    await expect(service.redeem(input)).rejects.toSatisfy(error => errorCode(error) === 'grant_already_bound')
  })

  it.each([
    ['inactive account', { accountStatus: 'DISABLED' }, 'account_inactive'],
    ['inactive organization', { organizationEnabled: false }, 'organization_inactive'],
    ['inactive membership', { membershipStatus: 'DISABLED' }, 'account_inactive'],
    ['non-member membership', { membershipRole: 'ORG_ADMIN' }, 'invalid_grant']
  ])('rejects %s without disclosing grant state', async (_, options, code) => {
    const { service } = makeRedeemHarness(options)
    await expect(service.preview(token)).rejects.toSatisfy(error => errorCode(error) === code)
    await expect(service.redeem(redeemInput())).rejects.toSatisfy(error => errorCode(error) === code)
  })

  it('records an attributable failed redemption without recording the raw token', async () => {
    const { service, state } = makeRedeemHarness({ membershipStatus: 'DISABLED' })
    await expect(service.redeem(redeemInput())).rejects.toSatisfy(error => errorCode(error) === 'account_inactive')
    expect(state.audits).toContainEqual(expect.objectContaining({ action: 'device_grant.redeem', resourceType: 'device_grant', resourceId: 'grant-1', metadata: expect.objectContaining({ outcome: 'failure', code: 'account_inactive', tokenHint: '••••secret' }) }))
    expect(JSON.stringify(state.audits)).not.toContain(token)
  })

  it('rejects malformed device metadata with a stable error code', async () => {
    const { service } = makeRedeemHarness()
    await expect(service.redeem({ ...redeemInput(), device: { ...redeemInput().device, name: ' ', platform: 'android' } }))
      .rejects.toSatisfy(error => errorCode(error) === 'invalid_device')
  })

  it('does not disclose a presented token in an invalid-grant error', async () => {
    const { service } = makeRedeemHarness()
    const invalidToken = 'x'.repeat(32)
    const error = await service.redeem({ ...redeemInput(), token: invalidToken }).catch(error => error)
    expect(errorCode(error)).toBe('invalid_grant')
    expect(JSON.stringify(error.getResponse())).not.toContain(invalidToken)
  })

  it('serializes simultaneous redemption so only the first installation binds', async () => {
    const { service, state } = makeRedeemHarness()
    const results = await Promise.allSettled([service.redeem(redeemInput()), service.redeem(redeemInput(otherInstallationId))])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: expect.anything() })
    expect(errorCode((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason)).toBe('grant_already_bound')
    expect(state.grants[0].deviceId).toBe('device-1')
  })

  it('maps a cross-grant installation-id race to invalid_device', async () => {
    const { service, state } = makeRedeemHarness({ additionalGrant: true })
    const results = await Promise.allSettled([
      service.redeem(redeemInput(installationId, token)), service.redeem(redeemInput(installationId, otherGrantToken))
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(errorCode((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason)).toBe('invalid_device')
    expect(state.grants.filter(grant => grant.deviceId !== null)).toHaveLength(1)
  })
})

describe('public device-grant routes', () => {
  it('exposes unguarded no-store preview and redemption routes', async () => {
    const grants = { preview: vi.fn(async () => ({ status: 'AVAILABLE' })), redeem: vi.fn(async () => ({ accessToken: 'access' })) }
    const controller = new AuthController({} as any, grants as any)
    await controller.preview({ token })
    await controller.redeem(redeemInput())
    expect(grants.preview).toHaveBeenCalledWith(token)
    expect(grants.redeem).toHaveBeenCalledWith(redeemInput())
    for (const handler of [controller.preview, controller.redeem]) {
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toMatch(/^device-grants\/(preview|redeem)$/)
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST)
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined()
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toContainEqual({ name: 'Cache-Control', value: 'no-store' })
    }
  })
})
