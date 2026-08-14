import { describe, expect, it } from 'vitest'
import { registry } from '../../packages/monitoring/src/registry.js'
import { recordQuotaRejection } from '../../packages/monitoring/src/quota-metrics.js'

describe('quota rejection metrics', () => {
  it('records quota rejections with the quota code label', async () => {
    recordQuotaRejection('DAILY_TOKEN_QUOTA')
    const metrics = await registry.metrics()
    expect(metrics).toContain('ucli_quota_rejections_total{code="DAILY_TOKEN_QUOTA"} 1')
  })
})
