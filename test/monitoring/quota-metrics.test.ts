import { describe, expect, it } from 'vitest'
import { registry } from '../../packages/monitoring/src/registry.js'
import { recordQuotaRejection, recordQuotaSettlement } from '../../packages/monitoring/src/quota-metrics.js'

describe('quota metrics', () => {
  it('records quota rejections with the quota code label', async () => {
    recordQuotaRejection('DAILY_TOKEN_QUOTA')
    const metrics = await registry.metrics()
    expect(metrics).toContain('ucli_quota_rejections_total{code="DAILY_TOKEN_QUOTA"} 1')
  })
  it('records successful quota settlement tokens and cost', async () => {
    recordQuotaSettlement(500, 120_000)
    const metrics = await registry.metrics()
    expect(metrics).toContain('ucli_quota_settled_tokens_total 500')
    expect(metrics).toContain('ucli_quota_settled_cost_usd_total 0.12')
  })
})
