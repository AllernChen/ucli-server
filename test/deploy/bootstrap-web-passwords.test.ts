import { describe, expect, it } from 'vitest'
import { generateInitialPassword, planPasswordBootstrap } from '../../scripts/bootstrap-web-passwords.mjs'

describe('web password bootstrap', () => {
  it('generates strong passwords without ambiguous characters', () => {
    const password = generateInitialPassword(24)
    expect(password).toHaveLength(24)
    expect(password).toMatch(/^[A-Za-z0-9!@#$%^*_=\-+]+$/)
  })

  it('plans only active accounts without a password', async () => {
    const result = await planPasswordBootstrap([
      { id: '1', email: 'a@example.invalid', displayName: 'A', status: 'ACTIVE', passwordHash: null },
      { id: '2', email: 'b@example.invalid', displayName: 'B', status: 'ACTIVE', passwordHash: 'existing' },
      { id: '3', email: 'c@example.invalid', displayName: 'C', status: 'DISABLED', passwordHash: null }
    ])
    expect(result).toEqual({ count: 1, targets: [{ id: '1', email: 'a@example.invalid', displayName: 'A' }] })
  })
})
