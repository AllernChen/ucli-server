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
  // OpenAI-style completion token totals already include reasoning tokens. Charge the
  // ordinary output rate only for the remainder to avoid counting reasoning twice.
  const nonReasoningOutput = Math.max(0, usage.outputTokens - usage.reasoningTokens)
  return new Decimal(nonCachedInput).mul(price.inputPerMillion)
    .plus(new Decimal(nonReasoningOutput).mul(price.outputPerMillion))
    .plus(new Decimal(usage.cachedTokens).mul(price.cachedPerMillion))
    .plus(new Decimal(usage.reasoningTokens).mul(price.reasoningPerMillion))
    .div(1_000_000).toFixed(8)
}
