import Decimal from 'decimal.js'
import type { NormalizedUsage } from './protocol.js'

export interface PriceSnapshot {
  inputPerMillion: string
  outputPerMillion: string
  cachedPerMillion: string
  reasoningPerMillion: string
}

export function calculateCost(usage: NormalizedUsage, price: PriceSnapshot): string {
  const nonCachedInput = Math.max(0, usage.inputTokens - usage.cachedTokens)
  return new Decimal(nonCachedInput).mul(price.inputPerMillion)
    .plus(new Decimal(usage.outputTokens).mul(price.outputPerMillion))
    .plus(new Decimal(usage.cachedTokens).mul(price.cachedPerMillion))
    .plus(new Decimal(usage.reasoningTokens).mul(price.reasoningPerMillion))
    .div(1_000_000).toFixed(8)
}
