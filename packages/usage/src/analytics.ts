import Decimal from 'decimal.js'

export interface UsageEvent {
  accountId: string
  occurredAt: number
  inputTokens: number
  outputTokens: number
  costUsd: string
  success: boolean
}

export function estimateActiveMinutes(timestamps: number[]): number {
  const bucketMs = 5 * 60 * 1000
  return new Set(timestamps.map(value => Math.floor(value / bucketMs))).size * 5
}

export function usageSummary(events: UsageEvent[]) {
  const requests = events.length
  const successes = events.filter(event => event.success).length
  return {
    requests,
    activeAccounts: new Set(events.map(event => event.accountId)).size,
    totalTokens: events.reduce((sum, event) => sum + event.inputTokens + event.outputTokens, 0),
    costUsd: events.reduce((sum, event) => sum.plus(event.costUsd), new Decimal(0)).toFixed(2),
    successRate: requests ? successes / requests : 0,
    estimatedActiveMinutes: estimateActiveMinutes(events.map(event => event.occurredAt))
  }
}
