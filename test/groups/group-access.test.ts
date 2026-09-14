import { describe, expect, it, vi } from 'vitest'
import { canAccessGroupModel, type ModelAccessPolicy } from '../../packages/gateway-core/src/access-policy.js'
import { assertActiveGroupMember } from '../../packages/security/src/group-access.js'
import { ModelCatalogService } from '../../packages/gateway-core/src/model-catalog.service.js'

const identity = { organizationId: 'org-a', accountId: 'employee-a', groupId: 'group-a', role: 'MEMBER' as const }
const mapping = { protocol: 'OPENAI_CHAT', enabled: true, deletedAt: null,
  channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }] } }
const model = (id: string, policies: ModelAccessPolicy[] = []) => ({ id, displayName: id, contextSize: 128000, policies, channelModels: [mapping] })

describe('group model authorization', () => {
  it('denies empty group allowlists and does not borrow other groups', () => {
    expect(canAccessGroupModel('model-a', [])).toBe(false)
    expect(canAccessGroupModel('model-b', ['model-a'])).toBe(false)
    expect(canAccessGroupModel('model-a', ['model-a'])).toBe(true)
    expect(canAccessGroupModel('legacy', null)).toBe(true)
  })

  it('rejects missing or removed membership rather than treating it as unrestricted', async () => {
    const db = { groupMember: { findFirst: vi.fn().mockResolvedValue(null) } }
    await expect(assertActiveGroupMember(db as any, identity)).rejects.toMatchObject({ status: 403 })
  })

  it('intersects legacy policies with group grants and filters by protocol', async () => {
    const db = {
      groupMember: { findFirst: vi.fn().mockResolvedValue({ group: { models: [
        { publicModelId: 'allowed' }, { publicModelId: 'other-org-only' }
      ] } }) },
      publicModel: { findMany: vi.fn().mockResolvedValue([
        model('not-in-group'), model('allowed'), model('other-org-only', [{ organizationId: 'other', accountId: null, role: null }])
      ]) }
    }
    const catalog = new ModelCatalogService(db as any)
    expect((await catalog.list(identity)).map(item => item.id)).toEqual(['allowed'])
    expect(await catalog.list(identity, 'anthropic_messages')).toEqual([])
    await expect(catalog.assertAllowed(identity, model('not-in-group'))).rejects.toMatchObject({ status: 403 })
    expect(db.groupMember.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      groupId: 'group-a', accountId: 'employee-a', organizationId: 'org-a', removedAt: null,
      group: expect.objectContaining({ enabled: true, archivedAt: null }),
      membership: expect.objectContaining({ status: 'ACTIVE' })
    }) }))
  })
})
