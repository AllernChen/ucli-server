export interface AnalyticsFilter {
  start: Date
  end: Date
  organizationId?: string
  accountId?: string
  channelId?: string
  publicModelId?: string
  channelModelId?: string
}

export interface AnalyticsOverview {
  requests: number
  successRate: number
  activeAccounts: number
  inputTokens: string
  outputTokens: string
  costUsd: string
  avgCostPerRequestUsd: string
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  p50FirstTokenMs: number | null
  p95FirstTokenMs: number | null
  failoverRate: number
}

export interface AnalyticsPrincipal {
  sub: string
  organizationId: string
  role: 'PLATFORM_ADMIN' | 'ORG_ADMIN' | 'MEMBER'
}
