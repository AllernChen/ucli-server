import { describe, expect, it } from 'vitest'
import { createDeviceGrantLinkCredential, deriveDeviceGrantLinkStatus, deviceGrantLinkFailure, revealDeviceGrantLinkSecret } from '../../packages/security/src/device-grant-links.js'

const key = Buffer.alloc(32, 7)
const link = (overrides: Partial<{ revokedAt: Date | null; consumedAt: Date | null; expiresAt: Date | null }> = {}) => ({
  revokedAt: null,
  consumedAt: null,
  expiresAt: null,
  ...overrides
})

describe('device grant link lifecycle', () => {
  it('derives consumed, revoked, expired, and available in priority order', () => {
    const now = new Date('2026-08-27T00:00:00.000Z')

    expect(deriveDeviceGrantLinkStatus(link({ consumedAt: now, revokedAt: now }), now)).toBe('CONSUMED')
    expect(deriveDeviceGrantLinkStatus(link({ revokedAt: now }), now)).toBe('REVOKED')
    expect(deriveDeviceGrantLinkStatus(link({ expiresAt: now }), now)).toBe('EXPIRED')
    expect(deriveDeviceGrantLinkStatus(link(), now)).toBe('AVAILABLE')
    expect(deviceGrantLinkFailure(link({ expiresAt: now }), now)).toBe('link_expired')
  })

  it('stores a hash and ciphertext that recover the same high-entropy secret', () => {
    const created = createDeviceGrantLinkCredential(key)

    expect(created.secret.length).toBeGreaterThanOrEqual(32)
    expect(created.secretHash).not.toContain(created.secret)
    expect(revealDeviceGrantLinkSecret(created.secretEncrypted, key)).toBe(created.secret)
    expect(() => revealDeviceGrantLinkSecret(created.secretEncrypted, Buffer.alloc(32, 8))).toThrow()
  })
})
