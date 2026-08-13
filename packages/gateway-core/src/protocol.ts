export type GatewayProtocol = 'openai_responses' | 'openai_chat' | 'anthropic_messages'

const ENDPOINTS: Record<GatewayProtocol, string> = {
  openai_responses: '/v1/responses',
  openai_chat: '/v1/chat/completions',
  anthropic_messages: '/v1/messages'
}

export function endpointFor(protocol: GatewayProtocol): string {
  return ENDPOINTS[protocol]
}

export interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  source: 'upstream' | 'estimated'
}

function count(value: unknown): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.trunc(Number(value)) : 0
}

export function normalizeUsage(usage: Record<string, any> | null | undefined): NormalizedUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, source: 'estimated' }
  const cachedTokens = count(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens)
  const providerInput = count(usage.prompt_tokens ?? usage.input_tokens)
  // OpenAI prompt_tokens already includes cached tokens; Anthropic input_tokens does not.
  const inputTokens = usage.cache_read_input_tokens === undefined ? providerInput : providerInput + cachedTokens
  return {
    inputTokens,
    outputTokens: count(usage.completion_tokens ?? usage.output_tokens),
    cachedTokens,
    reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens),
    source: 'upstream'
  }
}

export function retryableBeforeResponse(status: number, responseStarted: boolean): boolean {
  return !responseStarted && (status === 408 || status === 429 || status >= 500)
}
