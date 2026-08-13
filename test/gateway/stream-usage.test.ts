import { describe, expect, it } from 'vitest'
import { StreamUsageCollector } from '../../packages/gateway-core/src/stream-usage.js'

describe('stream usage collector', () => {
  it('collects OpenAI usage split across transport chunks', () => {
    const collector = new StreamUsageCollector('openai_chat')
    collector.push(Buffer.from('data: {"choices":[],"usage":{"prompt_tokens":10,'))
    collector.push(Buffer.from('"completion_tokens":4}}\n\ndata: [DONE]\n\n'))
    expect(collector.usage()).toMatchObject({ inputTokens: 10, outputTokens: 4, source: 'upstream' })
  })

  it('merges Anthropic message start and delta usage', () => {
    const collector = new StreamUsageCollector('anthropic_messages')
    collector.push(Buffer.from('event: message_start\ndata: {"message":{"usage":{"input_tokens":8,"cache_read_input_tokens":2}}}\n\n'))
    collector.push(Buffer.from('event: message_delta\ndata: {"usage":{"output_tokens":3}}\n\n'))
    expect(collector.usage()).toMatchObject({ inputTokens: 10, outputTokens: 3, cachedTokens: 2, source: 'upstream' })
  })

  it('collects Responses usage from the completed response envelope', () => {
    const collector = new StreamUsageCollector('openai_responses')
    collector.push(Buffer.from('event: response.completed\ndata: {"response":{"usage":{"input_tokens":12,"output_tokens":5}}}\n\n'))
    expect(collector.usage(99)).toMatchObject({ inputTokens: 12, outputTokens: 5, source: 'upstream' })
  })

  it('uses a non-zero conservative estimate when an upstream omits stream usage', () => {
    const collector = new StreamUsageCollector('openai_chat')
    collector.push(Buffer.from('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'))
    expect(collector.usage(17)).toMatchObject({ inputTokens: 17, source: 'estimated' })
    expect(collector.usage(17).outputTokens).toBeGreaterThan(0)
  })
})
