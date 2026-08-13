import { describe, expect, it } from 'vitest'
import { QuotaExceededError, QuotaLedger } from '../../packages/quota/src/quota-ledger.js'

describe('quota reservation and settlement', () => {
  it('reserves estimated usage and settles the difference', () => {
    const ledger = new QuotaLedger({ tokenLimit: 100, costLimitUsd: '1.00' })
    const reservation = ledger.reserve({ tokens: 40, costUsd: '0.40' })
    expect(ledger.snapshot()).toMatchObject({ reservedTokens: 40, usedTokens: 0 })
    ledger.settle(reservation, { tokens: 30, costUsd: '0.25' })
    expect(ledger.snapshot()).toMatchObject({ reservedTokens: 0, usedTokens: 30, usedCostUsd: '0.25' })
  })

  it('blocks reservations exceeding hard limits', () => {
    const ledger = new QuotaLedger({ tokenLimit: 10, costLimitUsd: '0.10' })
    expect(() => ledger.reserve({ tokens: 11, costUsd: '0.01' })).toThrow(QuotaExceededError)
    expect(() => ledger.reserve({ tokens: 1, costUsd: '0.11' })).toThrow(QuotaExceededError)
  })

  it('reports each threshold at most once', () => {
    const ledger = new QuotaLedger({ tokenLimit: 100, costLimitUsd: '10' })
    const first = ledger.reserve({ tokens: 55, costUsd: '1' })
    ledger.settle(first, { tokens: 55, costUsd: '1' })
    expect(ledger.takeAlerts()).toEqual([50])
    const second = ledger.reserve({ tokens: 30, costUsd: '1' })
    ledger.settle(second, { tokens: 30, costUsd: '1' })
    expect(ledger.takeAlerts()).toEqual([80])
    expect(ledger.takeAlerts()).toEqual([])
  })
})
