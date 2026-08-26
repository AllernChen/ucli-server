import { describe, expect, it } from 'vitest'
import { createOpaqueToken, hashOpaqueToken, opaqueTokenHint, verifyOpaqueToken } from '../../packages/security/src/tokens.js'

describe('device authentication tokens', () => {
  it('creates an opaque base64url token and a non-secret hint', () => {
    const token = createOpaqueToken(() => Buffer.alloc(32, 3))
    expect(token).toBe(Buffer.alloc(32, 3).toString('base64url'))
    expect(opaqueTokenHint(token)).toBe(`••••${token.slice(-6)}`)
  })

  it('stores opaque credentials as hashes', () => {
    const hash = hashOpaqueToken('device-secret')
    expect(hash).not.toContain('device-secret')
    expect(verifyOpaqueToken('device-secret', hash)).toBe(true)
    expect(verifyOpaqueToken('wrong', hash)).toBe(false)
  })
})
