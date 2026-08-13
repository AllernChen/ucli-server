import { describe, expect, it } from 'vitest'
import { quotaReservationKeys, reserveQuotaLua, settleQuotaLua } from '../../packages/quota/src/redis-quota.js'

describe('distributed quota reservation contract', () => {
  it('uses organization, account, model and calendar period in Redis keys', () => {
    const keys = quotaReservationKeys({ organizationId: 'org', accountId: 'account', model: 'gpt', now: new Date('2026-08-13T12:00:00Z') })
    expect(keys.dailyTokens).toBe('quota:org:account:gpt:2026-08-13:tokens')
    expect(keys.monthlyCost).toBe('quota:org:account:gpt:2026-08:cost-microusd')
    expect(keys.concurrency).toBe('concurrency:org:account:gpt')
  })

  it('atomically rejects limits before incrementing counters', () => {
    expect(reserveQuotaLua).toContain("return {0, 'QPS_EXCEEDED'}")
    expect(reserveQuotaLua.indexOf("QPS_EXCEEDED")).toBeLessThan(reserveQuotaLua.indexOf("INCRBY', KEYS[1]"))
  })

  it('reports when actual settlement crosses a hard limit', () => {
    expect(settleQuotaLua).toContain("'HARD_LIMIT_EXCEEDED'")
    expect(settleQuotaLua).toContain('ARGV[7]')
  })
})
