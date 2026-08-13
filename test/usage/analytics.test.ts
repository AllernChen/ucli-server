import { describe, expect, it } from 'vitest'
import { estimateActiveMinutes, usageSummary } from '../../packages/usage/src/analytics.js'

describe('usage analytics', () => {
  it('counts distinct five minute activity buckets', () => {
    const base = Date.UTC(2026, 0, 1, 8, 0)
    expect(estimateActiveMinutes([base, base + 60_000, base + 6 * 60_000])).toBe(10)
  })

  it('summarizes only gateway request metadata', () => {
    const summary = usageSummary([
      { accountId: 'a', occurredAt: 1000, inputTokens: 10, outputTokens: 5, costUsd: '0.02', success: true },
      { accountId: 'a', occurredAt: 2000, inputTokens: 3, outputTokens: 2, costUsd: '0.01', success: false },
      { accountId: 'b', occurredAt: 3000, inputTokens: 7, outputTokens: 1, costUsd: '0.03', success: true }
    ])
    expect(summary).toMatchObject({ requests: 3, activeAccounts: 2, totalTokens: 28, successRate: 2 / 3 })
    expect(summary.costUsd).toBe('0.06')
  })
})
