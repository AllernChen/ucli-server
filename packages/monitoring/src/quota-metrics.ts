import { Counter } from 'prom-client'
import { registry } from './registry.js'

const quotaRejections = new Counter({
  name: 'ucli_quota_rejections_total',
  help: 'Requests rejected by quota policies',
  labelNames: ['code'],
  registers: [registry]
})

export function recordQuotaRejection(code: string): void {
  quotaRejections.inc({ code })
}
