import { Counter } from 'prom-client'
import { registry } from './registry.js'

const quotaRejections = new Counter({
  name: 'ucli_quota_rejections_total',
  help: 'Requests rejected by quota policies',
  labelNames: ['code'],
  registers: [registry]
})

const quotaSettledTokens = new Counter({
  name: 'ucli_quota_settled_tokens_total',
  help: 'Tokens consumed against quota policies on successful requests',
  registers: [registry]
})

const quotaSettledCost = new Counter({
  name: 'ucli_quota_settled_cost_usd_total',
  help: 'USD cost consumed against quota policies on successful requests',
  registers: [registry]
})

export function recordQuotaRejection(code: string): void {
  quotaRejections.inc({ code })
}

export function recordQuotaSettlement(tokens: number, costMicroUsd: number): void {
  quotaSettledTokens.inc(tokens)
  quotaSettledCost.inc(costMicroUsd / 1_000_000)
}
