import { describe, expect, it } from 'vitest'
import { canAccessModel } from '../../packages/gateway-core/src/access-policy.js'

const principal = { organizationId: 'org-a', accountId: 'account-a', role: 'MEMBER' as const }

describe('model access policy', () => {
  it('requires every populated field on one policy to match', () => {
    expect(canAccessModel([{ organizationId: 'org-b', accountId: 'account-a', role: null }], principal)).toBe(false)
    expect(canAccessModel([{ organizationId: 'org-a', accountId: 'account-a', role: 'MEMBER' }], principal)).toBe(true)
  })

  it('allows a model without policies and supports wildcard dimensions', () => {
    expect(canAccessModel([], principal)).toBe(true)
    expect(canAccessModel([{ organizationId: 'org-a', accountId: null, role: null }], principal)).toBe(true)
  })
})
