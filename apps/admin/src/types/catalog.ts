export type HealthStatus = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'DISABLED'
export type ChannelProtocol = 'OPENAI' | 'ANTHROPIC' | 'GEMINI'
export type GatewayProtocol = 'OPENAI_RESPONSES' | 'OPENAI_CHAT' | 'ANTHROPIC_MESSAGES' | 'GEMINI'
export type CatalogLifecycle = 'ACTIVE' | 'ARCHIVED' | 'ALL'

export interface Page<T> { items: T[]; total: number; limit: number; offset: number }

export interface ChannelKey {
  id: string
  deletedAt: string | null
  suffix: string
  enabled: boolean
  health: HealthStatus
  priority: number
  weight: number
  remainingUsd: string | null
  expiresAt: string | null
  isolatedUntil?: string | null
  lastUsedAt?: string | null
}

export interface CostRule {
  id: string
  deletedAt: string | null
  channelModelId: string
  name: string
  daysOfWeek: number[]
  startMinute: number
  endMinute: number
  priority: number
  inputPerMillion: string
  outputPerMillion: string
  cachedPerMillion: string
  reasoningPerMillion: string
  currency: 'CNY'
  enabled: boolean
  validFrom: string
  validUntil: string | null
  createdAt: string
}

export interface ChannelModel {
  id: string
  deletedAt: string | null
  channelId: string
  publicModelId: string
  upstreamModel: string
  protocol: GatewayProtocol
  supportsStream: boolean
  supportsTools: boolean
  enabled: boolean
  health: HealthStatus
  probeEnabled: boolean
  probeIntervalMinutes: number
  consecutiveFailures: number
  lastTestedAt: string | null
  lastSuccessAt: string | null
  lastErrorCode: string | null
  costTimezone: string
  costRules: CostRule[]
  currentCost?: {
    id: string
    source: 'CHANNEL_COST_RULE' | 'PUBLIC_MODEL_FALLBACK'
    inputPerMillion: string
    outputPerMillion: string
    cachedPerMillion: string
    reasoningPerMillion: string
    currency: 'CNY'
    timezone: string
    resolvedAt: string
    ruleName?: string
    daysOfWeek?: number[]
    startMinute?: number
    endMinute?: number
    priority?: number
  } | null
}

export interface ChannelSummary {
  id: string
  deletedAt: string | null
  name: string
  provider: string
  protocol: ChannelProtocol
  baseUrl: string
  modelDiscoveryUrl: string | null
  enabled: boolean
  health: HealthStatus
  priority: number
  weight: number
  timeoutMs: number
  lastTestedAt: string | null
  availableKeys: number
  healthyModels: number
  modelCount: number
  usage24h: { requests: number; successRate: number; p95LatencyMs: number | null }
}

export interface ChannelDetail extends Omit<ChannelSummary, 'availableKeys' | 'healthyModels' | 'modelCount' | 'usage24h'> {
  autoDisable: boolean
  maxRetries: number
  keySelection: 'ROUND_ROBIN' | 'WEIGHTED_RANDOM'
  costTimezone: string
  lastSuccessAt: string | null
  keys: ChannelKey[]
  channelModels: ChannelModel[]
}

export interface PublicModelPrice {
  id: string
  inputPerMillion: string
  outputPerMillion: string
  cachedPerMillion: string
  reasoningPerMillion: string
  currency: 'CNY'
  enabled: boolean
  validFrom: string
  validUntil: string | null
  deletedAt: string | null
  used: boolean
}

export interface PublicModel {
  id: string
  deletedAt: string | null
  manufacturer: string
  manufacturerKey: string
  displayName: string
  contextSize: number | null
  enabled: boolean
  abilities: ChannelModel[]
  prices: PublicModelPrice[]
  usage24h: { requests: number; tokens: number; costUsd: string }
}

export interface PublishCheck {
  ready: boolean
  healthyChannelModels: number
  hasCurrentCost: boolean
  blockers: Array<'NO_HEALTHY_CHANNEL_MODEL' | 'NO_CURRENT_COST' | 'LATEST_TEST_FAILED'>
}

export interface ModelProbe {
  id: string
  source: string
  health: HealthStatus
  statusCode: number | null
  latencyMs: number
  firstTokenMs: number | null
  errorCode: string | null
  keySuffix: string | null
  testedAt: string
}

export interface ModelTestResult {
  channelModelId: string
  ok: boolean
  statusCode: number
  latencyMs: number
  firstTokenMs: number | null
  inputTokens: number
  outputTokens: number
  keySuffix: string | null
  errorCode: string | null
  health: Exclude<HealthStatus, 'UNKNOWN' | 'DISABLED'>
}

export interface AdminModelTestResponse extends ModelTestResult {
  assistantMessage: string
  rawResponse: unknown
  appliedCost: {
    id: string
    source: 'CHANNEL_COST_RULE' | 'PUBLIC_MODEL_FALLBACK'
    inputPerMillion: string
    outputPerMillion: string
    cachedPerMillion: string
    reasoningPerMillion: string
    currency: 'CNY'
    timezone: string
    resolvedAt: string
  }
  estimatedProcurementCostUsd: string
}
