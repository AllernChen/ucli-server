import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import argon2 from 'argon2'
import { AuthService } from '../../apps/api/src/auth.service.js'

vi.mock('argon2', () => ({ default: { hash: vi.fn(), verify: vi.fn() } }))

type Membership = { organizationId: string; role: 'PLATFORM_ADMIN' | 'ORG_ADMIN' | 'MEMBER'; status: 'ACTIVE' | 'DISABLED'; organization: { enabled: boolean } }

function loginService(memberships: Membership[]) {
  const account = {
    id: 'account-1', email: 'admin@example.com', displayName: 'Admin', passwordHash: 'password-hash', status: 'ACTIVE', tokenVersion: 1,
    memberships
  }
  const prisma: any = {
    account: { findUnique: vi.fn(async () => account) },
    organization: { findUnique: vi.fn(async () => ({ enabled: true })) }
  }
  return { service: new AuthService(prisma), prisma }
}

let previousJwtSecret: string | undefined
beforeEach(() => {
  previousJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = 'test-secret'
  vi.mocked(argon2.verify).mockReset()
  vi.mocked(argon2.verify).mockResolvedValue(true)
})
afterEach(() => {
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = previousJwtSecret
})

describe('password login membership selection', () => {
  it('rejects a disabled membership before signing a JWT', async () => {
    const { service } = loginService([{ organizationId: 'org-1', role: 'MEMBER', status: 'DISABLED', organization: { enabled: true } }])
    delete process.env.JWT_SECRET

    await expect(service.login({ email: 'admin@example.com', password: 'password' })).rejects.toMatchObject({ status: 401 })
  })

  it('rejects a membership in a disabled organization', async () => {
    const { service } = loginService([{ organizationId: 'org-1', role: 'MEMBER', status: 'ACTIVE', organization: { enabled: false } }])

    await expect(service.login({ email: 'admin@example.com', password: 'password' })).rejects.toMatchObject({ status: 401 })
  })

  it('selects the highest active role and then the lexicographically first organization', async () => {
    const { service } = loginService([
      { organizationId: 'org-z', role: 'MEMBER', status: 'ACTIVE', organization: { enabled: true } },
      { organizationId: 'org-z', role: 'PLATFORM_ADMIN', status: 'ACTIVE', organization: { enabled: true } },
      { organizationId: 'org-a', role: 'PLATFORM_ADMIN', status: 'ACTIVE', organization: { enabled: true } },
      { organizationId: 'org-b', role: 'ORG_ADMIN', status: 'ACTIVE', organization: { enabled: true } }
    ])

    const result = await service.login({ email: 'admin@example.com', password: 'password' })
    const principal = jwt.verify(result.accessToken, 'test-secret') as { organizationId: string; role: string }
    expect(principal).toMatchObject({ organizationId: 'org-a', role: 'PLATFORM_ADMIN' })
  })

  it('continues to allow an administrator with an active membership to log in', async () => {
    const { service, prisma } = loginService([{ organizationId: 'org-1', role: 'PLATFORM_ADMIN', status: 'ACTIVE', organization: { enabled: true } }])

    await expect(service.login({ email: 'admin@example.com', password: 'password' })).resolves.toMatchObject({ accessToken: expect.any(String) })
    expect(prisma.account.findUnique).toHaveBeenCalledWith({
      where: { email: 'admin@example.com' }, include: { memberships: { include: { organization: true } } }
    })
  })
})
