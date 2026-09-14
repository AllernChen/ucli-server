import { describe, expect, it } from 'vitest'
import { extractGatewayCredential } from '../../packages/security/src/gateway-auth.js'

describe('gateway credential headers', () => {
  it('accepts one credential or identical dual headers', () => {
    expect(extractGatewayCredential({ authorization: 'Bearer ucli_sk_a', 'x-api-key': 'ucli_sk_a' })).toBe('ucli_sk_a')
    expect(extractGatewayCredential({ authorization: 'bearer token' })).toBe('token')
    expect(extractGatewayCredential({ 'x-api-key': 'ucli_sk_a' })).toBe('ucli_sk_a')
  })
  it.each([
    {}, { authorization: 'Basic abc', 'x-api-key': 'valid' },
    { authorization: 'Bearer a', 'x-api-key': 'b' }, { authorization: ['Bearer a', 'Bearer a'] },
    { 'x-api-key': ['a', 'a'] }, { authorization: 'Bearer a,b' }, { 'x-api-key': 'a\nb' },
    { authorization: '', 'x-api-key': 'valid' }
  ])('rejects missing, ambiguous or malformed credentials: %j', headers => {
    expect(() => extractGatewayCredential(headers)).toThrow()
  })
})
