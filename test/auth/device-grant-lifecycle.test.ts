import { describe, expect, it } from 'vitest'
import { deriveDeviceGrantStatus, deviceGrantFailure } from '../../packages/security/src/device-grants.js'

const now = new Date('2026-08-26T04:00:00.000Z')
const grant = (overrides: Record<string, unknown> = {}) => ({
  deviceId: null, disabledAt: null, deletedAt: null, expiresAt: null, ...overrides
})

describe('device grant lifecycle', () => {
  it('uses the approved status precedence', () => {
    expect(deriveDeviceGrantStatus(grant(), now)).toBe('AVAILABLE')
    expect(deriveDeviceGrantStatus(grant({ deviceId: 'device-1' }), now)).toBe('BOUND')
    expect(deriveDeviceGrantStatus(grant({ expiresAt: new Date('2026-08-26T03:59:59Z') }), now)).toBe('EXPIRED')
    expect(deriveDeviceGrantStatus(grant({ disabledAt: now, deletedAt: now }), now)).toBe('DELETED')
  })

  it('maps only blocking lifecycle states to stable client errors', () => {
    expect(deviceGrantFailure(grant(), now)).toBeNull()
    expect(deviceGrantFailure(grant({ disabledAt: now }), now)).toBe('grant_disabled')
  })
})
