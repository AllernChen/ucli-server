import { describe, expect, it } from 'vitest'
import { createRequestLifecycle, deviceGrantQuery, grantActions, grantExpiryPayload, grantStatusLabel } from '../../apps/admin/src/device-grants.js'

describe('device grant administration helpers', () => {
  it('offers reversible actions for disabled grants and no actions for deleted grants', () => {
    expect(grantActions({ status: 'DISABLED' })).toEqual(['enable', 'edit-expiry', 'delete'])
    expect(grantActions({ status: 'DELETED' })).toEqual([])
  })

  it('maps the permanent option to a null expiry', () => {
    expect(grantExpiryPayload({ permanent: true, expiresAt: '2026-12-31T00:00' })).toEqual({ expiresAt: null })
  })

  it('converts a local expiry input to ISO and rejects an empty dated expiry', () => {
    expect(grantExpiryPayload({ permanent: false, expiresAt: '2026-12-31T00:00' }).expiresAt).toBe(new Date('2026-12-31T00:00').toISOString())
    expect(() => grantExpiryPayload({ permanent: false, expiresAt: '' })).toThrow('请选择有效期')
  })

  it('builds encoded grouped-list filters', () => {
    expect(deviceGrantQuery({ status: 'EXPIRED', q: '张 三', limit: 50, offset: 0 }))
      .toBe('status=EXPIRED&q=%E5%BC%A0+%E4%B8%89&limit=50&offset=0')
  })

  it('labels and exposes only valid actions for every derived grant status', () => {
    const cases = [
      ['AVAILABLE', '待绑定', ['disable', 'edit-expiry', 'delete']],
      ['BOUND', '已绑定', ['disable', 'edit-expiry', 'delete']],
      ['DISABLED', '已禁用', ['enable', 'edit-expiry', 'delete']],
      ['EXPIRED', '已过期', ['disable', 'edit-expiry', 'delete']],
      ['DELETED', '已删除', []]
    ] as const
    for (const [status, label, actions] of cases) {
      expect(grantStatusLabel(status)).toBe(label)
      expect(grantActions({ status })).toEqual(actions)
    }
  })

  it('rejects stale and disposed responses after a user-detail route change', () => {
    const lifecycle = createRequestLifecycle()
    const userOneRequest = lifecycle.next()
    const userTwoRequest = lifecycle.next()
    const applied: string[] = []

    if (lifecycle.isCurrent(userOneRequest)) applied.push('old-user-secret')
    if (lifecycle.isCurrent(userTwoRequest)) applied.push('new-user')
    lifecycle.dispose()
    if (lifecycle.isCurrent(userTwoRequest)) applied.push('after-unmount')

    expect(applied).toEqual(['new-user'])
  })
})
