import { describe, expect, it } from 'vitest'
import { requirePublicUrl } from '../../packages/security/src/public-url.js'

describe('PUBLIC_URL', () => {
  it('accepts HTTP and HTTPS origins including a trusted IP and port', () => {
    expect(requirePublicUrl('http://10.0.0.8:3000')).toBe('http://10.0.0.8:3000')
    expect(requirePublicUrl('https://server.example')).toBe('https://server.example')
  })

  it.each([undefined, '', 'file:///tmp/ucli', 'https://server.example/connect', 'https://server.example?x=1', 'https://user:pass@server.example'])('rejects non-origin configuration %#', value => {
    expect(() => requirePublicUrl(value)).toThrow(/PUBLIC_URL/)
  })
})
