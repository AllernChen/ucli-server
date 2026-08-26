import { describe, expect, it } from 'vitest'
import { deviceGrantQuery, grantActions, grantExpiryPayload, grantStatusLabel } from '../../apps/admin/src/device-grants.js'

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

  it('labels each derived grant status for the management UI', () => {
    expect(grantStatusLabel('AVAILABLE')).toBe('待绑定')
    expect(grantStatusLabel('BOUND')).toBe('已绑定')
    expect(grantStatusLabel('EXPIRED')).toBe('已过期')
  })
})
