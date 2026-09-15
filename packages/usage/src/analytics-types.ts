export interface AnalyticsFilter {
  start: Date
  end: Date
  organizationId?: string
  accountId?: string
  groupId?: string
  apiKeyId?: string
  credentialType?: 'DEVICE' | 'API_KEY'
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
  /** Compatibility costUsd fields contain CNY, not a currency conversion. */
  currency: 'CNY'
  costCny: string
  avgCostPerRequestCny: string
  unsettledRequests: number
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
