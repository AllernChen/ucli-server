import { Counter, Histogram } from 'prom-client'
import type { NextFunction, Request, Response } from 'express'
import { registry } from './registry.js'

const httpRequests = new Counter({
  name: 'ucli_http_requests_total',
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry]
})

const httpRequestDurationSeconds = new Histogram({
  name: 'ucli_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry]
})

export function httpMetricsMiddleware(request: Request, response: Response, next: NextFunction): void {
  const method = request.method
  const start = Date.now()
  response.on('finish', () => {
    // route is populated after routing; use the pattern (e.g. /:id) to keep cardinality low
    const route = request.route?.path ?? request.path
    const statusCode = String(response.statusCode)
    httpRequests.inc({ method, route, status_code: statusCode })
    httpRequestDurationSeconds.observe({ method, route, status_code: statusCode }, (Date.now() - start) / 1000)
  })
  next()
}
