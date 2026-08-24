import Decimal from 'decimal.js'
import type { NormalizedUsage } from './protocol.js'

export interface PriceSnapshot {
  inputPerMillion: string
  outputPerMillion: string
  cachedPerMillion: string
  reasoningPerMillion: string
}

export interface ProcurementTokenCounts {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
}

export interface ProcurementCostEstimate {
  inputCost: string
  outputCost: string
  cachedCost: string
  reasoningCost: string
  totalCost: string
  currency: 'CNY'
}

export function estimateProcurementCost(price: PriceSnapshot, usage: ProcurementTokenCounts): ProcurementCostEstimate {
  const amount = (tokens: number, rate: string) => new Decimal(tokens).mul(rate).div(1_000_000)
  const inputCost = amount(Math.max(0, usage.inputTokens - usage.cachedTokens), price.inputPerMillion)
  const outputCost = amount(Math.max(0, usage.outputTokens - usage.reasoningTokens), price.outputPerMillion)
  const cachedCost = amount(usage.cachedTokens, price.cachedPerMillion)
  const reasoningCost = amount(usage.reasoningTokens, price.reasoningPerMillion)
  return {
    inputCost: inputCost.toFixed(8), outputCost: outputCost.toFixed(8), cachedCost: cachedCost.toFixed(8),
    reasoningCost: reasoningCost.toFixed(8), totalCost: inputCost.plus(outputCost).plus(cachedCost).plus(reasoningCost).toFixed(8),
    currency: 'CNY'
  }
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
