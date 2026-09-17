import 'reflect-metadata'
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { ProfileController } from '../../apps/api/src/profile.controller.js'

const actor = { sub: '10000000-0000-4000-8000-000000000001', organizationId: '20000000-0000-4000-8000-000000000001', role: 'PLATFORM_ADMIN' as const, tokenVersion: 1 }
const groupId = '30000000-0000-4000-8000-000000000001'

function harness() {
  const prisma: any = { groupMember: { findMany: vi.fn(async () => [{ joinedAt: new Date('2026-09-01T00:00:00Z'), group: {
    id: groupId, name: 'Personal group', type: 'PROJECT', enabled: false, archivedAt: new Date('2026-09-02T00:00:00Z'), defaultLimitCny: '999' } }]) } }
  const catalog = { list: vi.fn(async () => [{ id: 'model', displayName: 'Allowed model', protocols: ['openai_chat'] }]) }
  const analytics = { overview: vi.fn(async () => ({ requests: 2 })), breakdown: vi.fn(async () => ({ items: [], total: 0, limit: 50, offset: 0 })) }
  return { controller: new ProfileController(prisma, catalog as any, analytics as any), prisma, catalog, analytics }
}

describe('personal profile reads', () => {
  it('lists only the actor current organization memberships without budget data', async () => {
    const { controller, prisma } = harness()
    await expect(controller.groups({ principal: actor })).resolves.toEqual([{
      id: groupId, name: 'Personal group', type: 'PROJECT', enabled: false, archivedAt: new Date('2026-09-02T00:00:00Z'), joinedAt: new Date('2026-09-01T00:00:00Z')
    }])
    expect(prisma.groupMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      organizationId: actor.organizationId, accountId: actor.sub, removedAt: null
    } }))
  })

  it('uses the authenticated member and requested group for model visibility', async () => {
    const { controller, catalog } = harness()
    await expect(controller.models({ principal: actor }, groupId)).resolves.toEqual([{ id: 'model', displayName: 'Allowed model', protocols: ['openai_chat'] }])
    expect(catalog.list).toHaveBeenCalledWith({ organizationId: actor.organizationId, accountId: actor.sub, role: actor.role, groupId })
  })

  it('rejects device sessions for every personal read', async () => {
    const { controller } = harness()
    const deviceRequest = { principal: { ...actor, deviceId: 'device-1' } }
    await expect(controller.groups(deviceRequest)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(controller.models(deviceRequest, groupId)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(controller.usage(deviceRequest, {} as any)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('forces even administrators to their own organization, account, and group breakdown', async () => {
    const { controller, analytics } = harness()
    const query: any = { organizationId: '40000000-0000-4000-8000-000000000001', accountId: '50000000-0000-4000-8000-000000000001', dimension: 'account', start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z' }
    await expect(controller.usage({ principal: actor }, query)).resolves.toMatchObject({ overview: { requests: 2 }, groups: { total: 0 } })
    const calls = [analytics.overview.mock.calls, analytics.breakdown.mock.calls] as unknown as any[][][]
    for (const [, scoped] of calls.map(calls => calls[0])) {
      expect(scoped).toMatchObject({ organizationId: actor.organizationId, accountId: actor.sub })
    }
    expect(analytics.breakdown).toHaveBeenCalledWith(actor, expect.objectContaining({ dimension: 'group' }))
  })
})
