export interface AnalyticsFilter {
  start: Date
  end: Date
  organizationId?: string
  accountId?: string
  groupId?: string
  budgetProjectId?: string
  apiKeyId?: string
  credentialType?: 'DEVICE' | 'API_KEY'
  channelId?: string
  publicModelId?: string
  channelModelId?: string
  channelModelScope?: 'UNASSOCIATED'
}

export type RequestState = 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
export type CostState = 'CONFIRMED' | 'ESTIMATED' | 'UNKNOWN' | 'NO_CHARGE'

export interface UsageReadFilter extends AnalyticsFilter {
  timezone: 'UTC' | 'Asia/Shanghai'
  requestState?: RequestState
  billingState?: CostState
  groupScope?: 'UNGROUPED'
  keyScope?: 'NO_KEY'
  costRuleId?: string
  priceKey?: string
  allocation?: 'UNALLOCATED'
  requestId?: string
  sessionId?: string
  projectId?: string
}

export interface UsageOperationalMetrics {
  requestSuccessRate: number | null
  requestStates: Record<RequestState, number>
  uncachedInputTokens: string
  cachedTokens: string
  reasoningTokens: string
  cacheHitRate: number | null
  cacheCoverage: { knownInputTokens: string; totalInputTokens: string; unknownCalls: number }
  estimatedCostCny: string
  unallocatedCostCny: string
  tokenUsageIncomplete: boolean
  errorCounts: Array<{ errorCode: string; requests: number }>
}

export interface AnalyticsOverview extends UsageOperationalMetrics {
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
