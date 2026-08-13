import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, secretSuffix } from '../../packages/security/src/envelope-crypto.js'

describe('envelope encryption', () => {
  it('round trips a secret without exposing it in ciphertext', () => {
    const masterKey = Buffer.alloc(32, 7)
    const encrypted = encryptSecret('sk-private-value', masterKey)
    expect(JSON.stringify(encrypted)).not.toContain('sk-private-value')
    expect(decryptSecret(encrypted, masterKey)).toBe('sk-private-value')
    expect(secretSuffix('sk-private-value')).toBe('alue')
  })

  it('rejects a different master key', () => {
    const encrypted = encryptSecret('secret', Buffer.alloc(32, 1))
    expect(() => decryptSecret(encrypted, Buffer.alloc(32, 2))).toThrow()
  })
})
