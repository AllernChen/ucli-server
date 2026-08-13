import { describe, expect, it } from 'vitest'
import { calculateCost } from '../../packages/gateway-core/src/cost.js'

describe('price snapshot settlement', () => {
  it('charges each token category using the request price snapshot', () => {
    expect(calculateCost({
      inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 100_000,
      reasoningTokens: 50_000, source: 'upstream'
    }, {
      inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0.1', reasoningPerMillion: '3'
    })).toBe('2.06000000')
  })
})
