export type HealthStatus = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'DISABLED'
export type ChannelProtocol = 'OPENAI' | 'ANTHROPIC' | 'GEMINI'
export type GatewayProtocol = 'OPENAI_RESPONSES' | 'OPENAI_CHAT' | 'ANTHROPIC_MESSAGES' | 'GEMINI'

export interface Page<T> { items: T[]; total: number; limit: number; offset: number }

export interface ChannelKey {
  id: string
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
  currency: 'USD'
  enabled: boolean
  validFrom: string
  validUntil: string | null
  createdAt: string
}

export interface ChannelModel {
  id: string
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
  costRules: CostRule[]
}

export interface ChannelSummary {
  id: string
  name: string
  provider: string
  protocol: ChannelProtocol
  baseUrl: string
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

export interface PublicModel {
  id: string
  displayName: string
  contextSize: number | null
  enabled: boolean
  abilities: ChannelModel[]
  prices: Array<{
    id: string
    inputPerMillion: string
    outputPerMillion: string
    cachedPerMillion: string
    reasoningPerMillion: string
    validFrom: string
    validUntil: string | null
  }>
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
