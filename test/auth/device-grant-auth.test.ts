import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import argon2 from 'argon2'
import { AuthService } from '../../apps/api/src/auth.service.js'
import { AuthController } from '../../apps/api/src/auth.controller.js'
import { AuthGuard, signAccessToken } from '../../packages/security/src/auth.js'

vi.mock('argon2', () => ({ default: { hash: vi.fn(), verify: vi.fn() } }))

const now = new Date('2026-08-26T04:00:00.000Z')
const grant = (overrides: Record<string, unknown> = {}) => ({
  id: 'grant-1', deviceId: 'device-1', disabledAt: null, deletedAt: null, expiresAt: null, ...overrides
})

type HarnessOptions = {
  passwordHash?: string | null
  grant?: Record<string, unknown> | null
  accountStatus?: string
  organizationEnabled?: boolean
  membershipStatus?: string
  membershipRole?: string
  revokedAt?: Date | null
}

function makeAuthHarness(options: HarnessOptions = {}) {
  const membership = {
    organizationId: 'org-1', accountId: 'account-1', role: options.membershipRole ?? 'MEMBER', status: options.membershipStatus ?? 'ACTIVE'
  }
  const account = {
    id: 'account-1', email: 'member@example.com', displayName: 'Member', passwordHash: options.passwordHash === undefined ? 'password-hash' : options.passwordHash,
    status: options.accountStatus ?? 'ACTIVE', tokenVersion: 1, memberships: [membership]
  }
  const device = {
    id: 'device-1', accountId: 'account-1', organizationId: 'org-1', revokedAt: options.revokedAt ?? null,
    grant: options.grant === undefined ? grant() : options.grant
  }
  const organization = { id: 'org-1', enabled: options.organizationEnabled ?? true }
  const prisma: any = {
    account: {
      findUnique: vi.fn(async ({ where }: any) => where.email ? account : account)
    },
    organization: { findUnique: vi.fn(async () => organization) },
    device: {
      findUnique: vi.fn(async () => ({ ...device, account, organization })),
      findFirst: vi.fn(async () => device),
      update: vi.fn(async () => device),
      updateMany: vi.fn(async () => ({ count: 1 }))
    }
  }
  return { service: new AuthService(prisma), prisma, verify: vi.mocked(argon2.verify) }
}

function makeRequest(token: string) {
  const request: any = { headers: { authorization: `Bearer ${token}` } }
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined
    } as any
  }
}

function makeGuard(options: HarnessOptions = {}) {
  const membership = {
    organizationId: 'org-1', accountId: 'account-1', role: options.membershipRole ?? 'MEMBER', status: options.membershipStatus ?? 'ACTIVE'
  }
  const account = { id: 'account-1', status: options.accountStatus ?? 'ACTIVE', tokenVersion: 1 }
  const device = {
    id: 'device-1', accountId: 'account-1', organizationId: 'org-1', revokedAt: options.revokedAt ?? null,
    grant: options.grant === undefined ? grant() : options.grant
  }
  const prisma: any = {
    account: {
      findFirst: vi.fn(async () => account),
      findUnique: vi.fn(async () => ({ ...account, memberships: [{ ...membership, organization: { enabled: options.organizationEnabled ?? true } }] }))
    },
    device: {
      findFirst: vi.fn(async () => device),
      update: vi.fn(async () => device)
    }
  }
  const reflector = { getAllAndOverride: vi.fn(() => undefined) }
  return { guard: new AuthGuard(reflector as any, prisma), prisma, membership }
}

function errorCode(error: unknown) {
  return (error as any).getResponse().code
}

let originalJwtSecret: string | undefined
beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = 'test-secret'
  vi.mocked(argon2.verify).mockReset()
})
afterEach(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

describe('live device grant authorization', () => {
  it('rejects password login for a passwordless member without calling argon2.verify', async () => {
    const { service, verify } = makeAuthHarness({ passwordHash: null })
    await expect(service.login({ email: 'member@example.com', password: 'ignored' })).rejects.toMatchObject({ status: 401 })
    expect(verify).not.toHaveBeenCalled()
  })

  it('rejects password changes for a passwordless member without calling argon2.verify', async () => {
    const { service, verify } = makeAuthHarness({ passwordHash: null })
    await expect(service.changePassword('account-1', { currentPassword: 'ignored', newPassword: 'new-password' })).rejects.toMatchObject({ status: 401 })
    expect(verify).not.toHaveBeenCalled()
  })

  it.each([
    ['disabled', { disabledAt: now }, 'grant_disabled'],
    ['expired', { expiresAt: new Date('2026-08-25T00:00:00.000Z') }, 'grant_expired'],
    ['deleted', { deletedAt: now }, 'grant_deleted']
  ])('rejects refresh for a %s grant', async (_name, grantState, code) => {
    const { service } = makeAuthHarness({ grant: grant(grantState) })
    await expect(service.refresh('refresh-secret')).rejects.toSatisfy(error => errorCode(error) === code)
  })

  it('returns current grant metadata when refreshing a live device', async () => {
    const expiresAt = new Date('2026-12-31T16:00:00.000Z')
    const { service } = makeAuthHarness({ grant: grant({ expiresAt }) })
    const refreshed = await service.refresh('refresh-secret')
    expect(refreshed.authorization.expiresAt).toBe('2026-12-31T16:00:00.000Z')
    expect(new Date(refreshed.authorization.serverTime).toISOString()).toBe(refreshed.authorization.serverTime)
  })

  it('rejects a device access token whose device no longer has a grant', async () => {
    const { guard } = makeGuard({ grant: null })
    const token = signAccessToken({ sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER', tokenVersion: 1 })
    await expect(guard.canActivate(makeRequest(token).context)).rejects.toSatisfy(error => errorCode(error) === 'invalid_grant')
  })

  it('rejects a device access token after its grant is disabled', async () => {
    const { guard } = makeGuard({ grant: grant({ disabledAt: now }) })
    const token = signAccessToken({ sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER', tokenVersion: 1 })
    await expect(guard.canActivate(makeRequest(token).context)).rejects.toSatisfy(error => errorCode(error) === 'grant_disabled')
  })

  it('reports grant deletion before the associated device revocation', async () => {
    const { guard } = makeGuard({ grant: grant({ deletedAt: now }), revokedAt: now })
    const token = signAccessToken({ sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER', tokenVersion: 1 })
    await expect(guard.canActivate(makeRequest(token).context)).rejects.toSatisfy(error => errorCode(error) === 'grant_deleted')
  })

  it('accepts a device access token with a live grant', async () => {
    const { guard, prisma } = makeGuard()
    const token = signAccessToken({ sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER', tokenVersion: 1 })
    await expect(guard.canActivate(makeRequest(token).context)).resolves.toBe(true)
    expect(prisma.device.update).toHaveBeenCalledOnce()
  })

  it('rejects a disabled membership for a device using the stable account-inactive error', async () => {
    const { guard } = makeGuard({ membershipStatus: 'DISABLED' })
    const token = signAccessToken({ sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER', tokenVersion: 1 })
    await expect(guard.canActivate(makeRequest(token).context)).rejects.toSatisfy(error => errorCode(error) === 'account_inactive')
  })

  it('keeps password administrators valid when their active membership has no device', async () => {
    const { guard } = makeGuard({ membershipRole: 'PLATFORM_ADMIN' })
    const token = signAccessToken({ sub: 'account-1', organizationId: 'org-1', role: 'PLATFORM_ADMIN', tokenVersion: 1 })
    await expect(guard.canActivate(makeRequest(token).context)).resolves.toBe(true)
  })

  it('does not expose removed invitation and device-code routes', () => {
    const controller = new AuthController({} as any, {} as any)
    expect(controller).not.toHaveProperty('accept')
    expect(controller).not.toHaveProperty('deviceCode')
    expect(controller).not.toHaveProperty('deviceToken')
    expect(controller).not.toHaveProperty('approve')
  })
})
