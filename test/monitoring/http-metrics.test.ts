import { describe, expect, it, vi } from 'vitest'
import { httpMetricsMiddleware } from '../../packages/monitoring/src/http-metrics.js'
import { registry } from '../../packages/monitoring/src/registry.js'

describe('httpMetricsMiddleware', () => {
  it('records request count and duration on response finish', async () => {
    let finish: (() => void) | null = null
    const response = { statusCode: 200, on: (event: string, cb: () => void) => { if (event === 'finish') finish = cb } }
    const request = { method: 'GET', path: '/v1/models' }
    const next = vi.fn()
    httpMetricsMiddleware(request as any, response as any, next)
    expect(next).toHaveBeenCalled()
    finish!()
    const metrics = await registry.metrics()
    expect(metrics).toContain('ucli_http_requests_total{method="GET",route="/v1/models",status_code="200"} 1')
  })
})
