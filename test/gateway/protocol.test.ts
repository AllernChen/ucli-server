import { describe, expect, it } from 'vitest'
import { endpointFor, normalizeUsage, retryableBeforeResponse } from '../../packages/gateway-core/src/protocol.js'

describe('gateway protocol handling', () => {
  it('maps supported public protocols to upstream endpoints', () => {
    expect(endpointFor('openai_responses')).toBe('/v1/responses')
    expect(endpointFor('openai_chat')).toBe('/v1/chat/completions')
    expect(endpointFor('anthropic_messages')).toBe('/v1/messages')
  })

  it('normalizes OpenAI and Anthropic usage shapes', () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } }))
      .toMatchObject({ inputTokens: 10, outputTokens: 4, cachedTokens: 2, source: 'upstream' })
    expect(normalizeUsage({ input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 5 }))
      .toMatchObject({ inputTokens: 13, outputTokens: 3, cachedTokens: 5, source: 'upstream' })
  })

  it('retries transient failures only before response output starts', () => {
    expect(retryableBeforeResponse(429, false)).toBe(true)
    expect(retryableBeforeResponse(503, false)).toBe(true)
    expect(retryableBeforeResponse(503, true)).toBe(false)
    expect(retryableBeforeResponse(400, false)).toBe(false)
  })
})
