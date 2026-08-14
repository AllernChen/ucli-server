import { describe, expect, it } from 'vitest'
import { registry } from '../../packages/monitoring/src/registry.js'

describe('monitoring registry', () => {
  it('registers default metrics with the ucli_ prefix', async () => {
    const metrics = await registry.metrics()
    expect(metrics).toContain('ucli_process_cpu_seconds_total')
  })
})
