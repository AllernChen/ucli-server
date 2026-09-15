import { describe, expect, it } from 'vitest'
import { endpointFor, normalizeUsage, retryableBeforeResponse, upstreamUrl } from '../../packages/gateway-core/src/protocol.js'
import { calculateCost } from '../../packages/gateway-core/src/cost.js'

describe('gateway protocol handling', () => {
  it.each([
    [800, 200, '0.00123200'], [0, 1000, '0.00280000'], [1000, 0, '0.00084000']
  ])('uses DeepSeek reported cache hits (%s) without adding them to prompt total', (hit, miss, expectedCost) => {
    const usage = normalizeUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss,
      completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 60 } })
    expect(usage).toEqual({ inputTokens: 1000, cachedTokens: hit, outputTokens: 100, reasoningTokens: 60, source: 'upstream' })
    expect(calculateCost(usage, { inputPerMillion: '2', cachedPerMillion: '0.04', outputPerMillion: '8', reasoningPerMillion: '8' })).toBe(expectedCost)
  })

  it('preserves explicit standard cache counts including zero when alias fields coexist', () => {
    expect(normalizeUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 800 }).cachedTokens).toBe(0)
    expect(normalizeUsage({ input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 800, prompt_cache_hit_tokens: 800 }))
      .toMatchObject({ inputTokens: 1000, cachedTokens: 800 })
  })

  it('maps supported public protocols to upstream endpoints', () => {
    expect(endpointFor('openai_responses')).toBe('/v1/responses')
    expect(endpointFor('openai_chat')).toBe('/v1/chat/completions')
    expect(endpointFor('anthropic_messages')).toBe('/v1/messages')
  })

  it('appends endpoints under a base URL with a path (does not drop it)', () => {
    expect(upstreamUrl('https://api.deepseek.com/anthropic', 'anthropic_messages')).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(upstreamUrl('https://api.deepseek.com', 'openai_chat')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(upstreamUrl('https://example.com/base/', 'openai_responses')).toBe('https://example.com/base/v1/responses')
  })

  it('normalizes OpenAI and Anthropic usage shapes', () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } }))
      .toMatchObject({ inputTokens: 10, outputTokens: 4, cachedTokens: 2, source: 'upstream' })
    expect(normalizeUsage({ input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 5 }))
      .toMatchObject({ inputTokens: 13, outputTokens: 3, cachedTokens: 5, source: 'upstream' })
    expect(normalizeUsage({ input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } }))
      .toMatchObject({ inputTokens: 10, outputTokens: 4, cachedTokens: 2, reasoningTokens: 3 })
    expect(normalizeUsage({})).toMatchObject({ source: 'estimated' })
    expect(normalizeUsage({ input_tokens: 3, cache_creation_input_tokens: 5, output_tokens: 1 })).toMatchObject({ unpricedTokens: 5 })
  })

  it('retries transient failures only before response output starts', () => {
    expect(retryableBeforeResponse(429, false)).toBe(true)
    expect(retryableBeforeResponse(503, false)).toBe(true)
    expect(retryableBeforeResponse(503, true)).toBe(false)
    expect(retryableBeforeResponse(400, false)).toBe(false)
  })
})
