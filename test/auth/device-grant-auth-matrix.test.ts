import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import argon2 from 'argon2'
import { AuthService } from '../../apps/api/src/auth.service.js'
import { ClientController } from '../../apps/api/src/client.controller.js'
import { AuthGuard, signAccessToken } from '../../packages/security/src/auth.js'
import { hashOpaqueToken } from '../../packages/security/src/tokens.js'

vi.mock('argon2', () => ({ default: { hash: vi.fn(), verify: vi.fn() } }))

const oldRefreshToken = 'refresh-secret'
const oldRefreshHash = hashOpaqueToken(oldRefreshToken)
const past = new Date('2026-08-25T00:00:00.000Z')

const messages = {
  invalid_grant: 'Device grant is invalid',
  grant_disabled: 'Device grant is disabled',
  grant_expired: 'Device grant has expired',
  grant_deleted: 'Device grant has been deleted',
  account_inactive: 'Account or membership is inactive',
  organization_inactive: 'Organization is inactive',
  invalid_device: 'Device is invalid'
} as const

type FailureCode = keyof typeof messages
type AuthorizationOptions = {
  grant?: Record<string, unknown> | null
  revokedAt?: Date | null
  accountStatus?: string
  organizationEnabled?: boolean
  membershipStatus?: string
  membershipRole?: string
  membershipMissing?: boolean
  accountTokenVersion?: number
  deviceAccountId?: string
  deviceOrganizationId?: string
}

function activeGrant(overrides: Record<string, unknown> = {}) {
  return { id: 'grant-1', deviceId: 'device-1', deletedAt: null, disabledAt: null, expiresAt: null, ...overrides }
}

function expectAuthorizationFailure(error: unknown, code: FailureCode) {
  const exception = error as any
  expect(exception.getStatus()).toBe(401)
  expect(exception.getResponse()).toEqual({ code, message: messages[code] })
}

function makeRefreshHarness(options: AuthorizationOptions = {}, synchronizeReads = false) {
  const membership = {
    organizationId: 'org-1', accountId: 'account-1', role: options.membershipRole ?? 'MEMBER', status: options.membershipStatus ?? 'ACTIVE'
  }
  const account = {
    id: 'account-1', status: options.accountStatus ?? 'ACTIVE', tokenVersion: options.accountTokenVersion ?? 1,
    memberships: options.membershipMissing ? [] : [membership]
  }
  const organization = { id: 'org-1', enabled: options.organizationEnabled ?? true }
  const device = {
    id: 'device-1', accountId: options.deviceAccountId ?? 'account-1', organizationId: options.deviceOrganizationId ?? 'org-1',
    refreshTokenHash: oldRefreshHash, revokedAt: options.revokedAt ?? null, lastSeenAt: null as Date | null,
    grant: options.grant === undefined ? activeGrant() : options.grant
  }
  let reads = 0
  let releaseReads: (() => void) | undefined
  const bothReads = synchronizeReads ? new Promise<void>(resolve => { releaseReads = resolve }) : Promise.resolve()
  const snapshot = () => ({ ...device, account: { ...account, memberships: [...account.memberships] }, organization, grant: device.grant })
  const prisma: any = {
    device: {
      findUnique: async ({ where }: any) => {
        if (where.refreshTokenHash !== oldRefreshHash || device.refreshTokenHash !== oldRefreshHash) return null
        reads += 1
        if (synchronizeReads && reads === 2) releaseReads?.()
        await bothReads
        return snapshot()
      },
      update: async ({ data }: any) => {
        device.refreshTokenHash = data.refreshTokenHash
        return device
      },
      updateMany: async ({ where, data }: any) => {
        if (where.id !== device.id || where.refreshTokenHash !== device.refreshTokenHash) return { count: 0 }
        device.refreshTokenHash = data.refreshTokenHash
        device.lastSeenAt = data.lastSeenAt
        return { count: 1 }
      }
    },
    $transaction: async (operation: any) => {
      const before = { refreshTokenHash: device.refreshTokenHash, lastSeenAt: device.lastSeenAt }
      let changed = false
      const transaction = {
        ...prisma,
        device: {
          ...prisma.device,
          updateMany: async (args: any) => {
            const result = await prisma.device.updateMany(args)
            changed = result.count === 1
            return result
          }
        }
      }
      try { return await operation(transaction) } catch (error) {
        if (changed) {
          device.refreshTokenHash = before.refreshTokenHash
          device.lastSeenAt = before.lastSeenAt
        }
        throw error
      }
    }
  }
  return { service: new AuthService(prisma), device, prisma }
}

function makeGuardHarness(options: AuthorizationOptions = {}) {
  const membership = {
    organizationId: 'org-1', accountId: 'account-1', role: options.membershipRole ?? 'MEMBER', status: options.membershipStatus ?? 'ACTIVE',
    organization: { enabled: options.organizationEnabled ?? true }
  }
  const account = {
    id: 'account-1', status: options.accountStatus ?? 'ACTIVE', tokenVersion: options.accountTokenVersion ?? 1,
    memberships: options.membershipMissing ? [] : [membership]
  }
  const device = {
    id: 'device-1', accountId: options.deviceAccountId ?? 'account-1', organizationId: options.deviceOrganizationId ?? 'org-1',
    revokedAt: options.revokedAt ?? null, grant: options.grant === undefined ? activeGrant() : options.grant
  }
  const prisma: any = {
    account: { findUnique: vi.fn(async () => account) },
    device: {
      findFirst: vi.fn(async ({ where }: any) => (
        where.id === device.id && where.accountId === device.accountId && where.organizationId === device.organizationId ? device : null
      )),
      update: vi.fn(async () => device)
    }
  }
  const guard = new AuthGuard({ getAllAndOverride: vi.fn(() => undefined) } as any, prisma)
  return { guard, prisma }
}

function guardContext(token: string) {
  const request: any = { headers: { authorization: `Bearer ${token}` } }
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined
  } as any
}

function deviceToken(overrides: Record<string, unknown> = {}) {
  return signAccessToken({ sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER', tokenVersion: 1, ...overrides })
}

let originalJwtSecret: string | undefined
beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = 'test-secret'
  vi.mocked(argon2.verify).mockReset()
  vi.mocked(argon2.hash).mockReset()
})
afterEach(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

describe('refresh token rotation', () => {
  it('allows only one concurrent use of an old refresh token', async () => {
    const { service, device } = makeRefreshHarness({}, true)
    const results = await Promise.allSettled([service.refresh(oldRefreshToken), service.refresh(oldRefreshToken)])
    const successes = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expectAuthorizationFailure(failures[0].reason, 'invalid_grant')
    expect(device.refreshTokenHash).toBe(hashOpaqueToken(successes[0].value.refreshToken))
  })

  it.each([
    ['missing grant', { grant: null }, 'invalid_grant'],
    ['disabled grant', { grant: activeGrant({ disabledAt: new Date() }) }, 'grant_disabled'],
    ['deleted grant', { grant: activeGrant({ deletedAt: new Date() }) }, 'grant_deleted'],
    ['expired grant', { grant: activeGrant({ expiresAt: past }) }, 'grant_expired'],
    ['permanently revoked device', { revokedAt: new Date() }, 'invalid_device'],
    ['inactive account', { accountStatus: 'DISABLED' }, 'account_inactive'],
    ['inactive organization', { organizationEnabled: false }, 'organization_inactive'],
    ['missing membership', { membershipMissing: true }, 'account_inactive'],
    ['inactive membership', { membershipStatus: 'DISABLED' }, 'account_inactive']
  ] as const)('returns the stable %s error during refresh', async (_name, options, code) => {
    const { service } = makeRefreshHarness(options)
    const error = await service.refresh(oldRefreshToken).catch(error => error)
    expectAuthorizationFailure(error, code)
  })

  it('does not expose either refresh-token hash in a successful refresh response', async () => {
    const { service, device } = makeRefreshHarness()
    const result = await service.refresh(oldRefreshToken)
    expect(JSON.stringify(result)).not.toContain(oldRefreshHash)
    expect(JSON.stringify(result)).not.toContain(device.refreshTokenHash)
  })

  it.each(['PLATFORM_ADMIN', 'ORG_ADMIN', 'MEMBER'])('refreshes a live device for an active %s grant owner', async membershipRole => {
    const { service } = makeRefreshHarness({ membershipRole })
    await expect(service.refresh(oldRefreshToken)).resolves.toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) })
  })

  it('does not consume an old refresh token when access-token signing fails', async () => {
    const { service, device } = makeRefreshHarness()
    const before = { refreshTokenHash: device.refreshTokenHash, lastSeenAt: device.lastSeenAt }
    delete process.env.JWT_SECRET

    await expect(service.refresh(oldRefreshToken)).rejects.toThrow('JWT_SECRET is required')
    expect(device).toMatchObject(before)

    process.env.JWT_SECRET = 'test-secret'
    await expect(service.refresh(oldRefreshToken)).resolves.toMatchObject({ refreshToken: expect.any(String) })
  })
})

describe('device JWT authorization matrix', () => {
  it.each([
    ['missing device', {}, { deviceId: 'missing-device' }, 'invalid_device'],
    ['cross-account device', { deviceAccountId: 'other-account' }, {}, 'invalid_device'],
    ['cross-organization device', { deviceOrganizationId: 'other-org' }, {}, 'invalid_device'],
    ['missing grant', { grant: null }, {}, 'invalid_grant'],
    ['disabled grant', { grant: activeGrant({ disabledAt: new Date() }) }, {}, 'grant_disabled'],
    ['deleted grant', { grant: activeGrant({ deletedAt: new Date() }) }, {}, 'grant_deleted'],
    ['expired grant', { grant: activeGrant({ expiresAt: past }) }, {}, 'grant_expired'],
    ['permanently revoked device', { revokedAt: new Date() }, {}, 'invalid_device'],
    ['inactive account', { accountStatus: 'DISABLED' }, {}, 'account_inactive'],
    ['changed token version', { accountTokenVersion: 2 }, {}, 'account_inactive'],
    ['inactive organization', { organizationEnabled: false }, {}, 'organization_inactive'],
    ['missing membership', { membershipMissing: true }, {}, 'account_inactive'],
    ['non-member membership', { membershipRole: 'ORG_ADMIN' }, {}, 'account_inactive'],
    ['inactive membership', { membershipStatus: 'DISABLED' }, {}, 'account_inactive']
  ] as const)('returns the stable %s error', async (_name, options, tokenOverrides, code) => {
    const { guard } = makeGuardHarness(options)
    const error = await guard.canActivate(guardContext(deviceToken(tokenOverrides))).catch(error => error)
    expectAuthorizationFailure(error, code)
  })
})

describe('password administrator compatibility', () => {
  it('allows an administrator with a password to log in and change that password', async () => {
    vi.mocked(argon2.verify).mockResolvedValue(true)
    vi.mocked(argon2.hash).mockResolvedValue('new-password-hash')
    const account = {
      id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', passwordHash: 'old-password-hash', status: 'ACTIVE', tokenVersion: 1,
      memberships: [{ organizationId: 'org-1', role: 'PLATFORM_ADMIN', status: 'ACTIVE', organization: { enabled: true } }]
    }
    const prisma: any = {
      account: { findUnique: vi.fn(async () => account), update: vi.fn(async () => account) },
      organization: { findUnique: vi.fn(async () => ({ id: 'org-1', enabled: true })) }
    }
    const service = new AuthService(prisma)
    await expect(service.login({ email: 'admin@example.com', password: 'old-password' })).resolves.toMatchObject({ accessToken: expect.any(String) })
    await expect(service.changePassword('admin-1', { currentPassword: 'old-password', newPassword: 'new-password' })).resolves.toEqual({ message: 'Password changed' })
  })

  it('keeps administrator bootstrap response unchanged and does not query devices', async () => {
    const prisma: any = {
      organization: { findUniqueOrThrow: vi.fn(async () => ({ id: 'org-1', name: 'Example', timezone: 'UTC' })) },
      publicModel: { findMany: vi.fn(async () => [{ policies: [], channelModels: [] }]) },
      device: { findFirst: vi.fn() }
    }
    const controller = new ClientController(prisma)
    await expect(controller.bootstrap({ principal: { sub: 'admin-1', organizationId: 'org-1', role: 'PLATFORM_ADMIN' } })).resolves.toEqual({
      organization: { id: 'org-1', name: 'Example', timezone: 'UTC' }, gateway: { baseUrl: 'http://localhost:3001' },
      models: [], skillsCatalogUrl: 'http://localhost:3000/api/v1/skills/catalog'
    })
    expect(prisma.device.findFirst).not.toHaveBeenCalled()
  })
})
