import { describe, expect, it } from 'vitest'
import { createDeviceCode, hashOpaqueToken, verifyOpaqueToken } from '../../packages/security/src/tokens.js'

describe('device authentication tokens', () => {
  it('creates user-friendly device codes without ambiguous characters', () => {
    const code = createDeviceCode(() => Buffer.alloc(8, 3))
    expect(code.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(code.deviceCode.length).toBeGreaterThan(30)
  })

  it('stores opaque credentials as hashes', () => {
    const hash = hashOpaqueToken('device-secret')
    expect(hash).not.toContain('device-secret')
    expect(verifyOpaqueToken('device-secret', hash)).toBe(true)
    expect(verifyOpaqueToken('wrong', hash)).toBe(false)
  })
})
