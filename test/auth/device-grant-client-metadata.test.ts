import { describe, expect, it, vi } from 'vitest'
import { ClientController } from '../../apps/api/src/client.controller.js'

describe('device bootstrap authorization metadata', () => {
  it('returns the latest device-grant expiration and a service-generated server time', async () => {
    const expiresAt = new Date('2026-12-31T16:00:00.000Z')
    const prisma: any = {
      organization: { findUniqueOrThrow: vi.fn(async () => ({ id: 'org-1', name: 'Example', timezone: 'UTC' })) },
      publicModel: { findMany: vi.fn(async () => []) },
      device: { findFirst: vi.fn(async () => ({ id: 'device-1', grant: { id: 'grant-1', disabledAt: null, deletedAt: null, expiresAt } })) }
    }
    const controller = new ClientController(prisma)
    const result = await controller.bootstrap({ principal: { sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER' } })
    if (!result.authorization) throw new Error('Device bootstrap must return authorization metadata')
    expect(result.authorization.expiresAt).toBe('2026-12-31T16:00:00.000Z')
    expect(new Date(result.authorization.serverTime).toISOString()).toBe(result.authorization.serverTime)
  })

  it('rejects bootstrap before returning configuration when a device grant is inactive', async () => {
    const prisma: any = {
      organization: { findUniqueOrThrow: vi.fn(async () => ({ id: 'org-1', name: 'Example', timezone: 'UTC' })) },
      publicModel: { findMany: vi.fn(async () => []) },
      device: { findFirst: vi.fn(async () => ({ id: 'device-1', grant: { id: 'grant-1', disabledAt: new Date(), deletedAt: null, expiresAt: null } })) }
    }
    const controller = new ClientController(prisma)
    await expect(controller.bootstrap({ principal: { sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER' } }))
      .rejects.toSatisfy(error => (error as any).getResponse().code === 'grant_disabled')
  })
})
