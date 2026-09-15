import { describe, expect, it } from 'vitest'
import { prepareBudgetRequest } from '../../packages/quota/src/group-budget.js'

const deepseek = { protocol: 'anthropic_messages' as const, baseUrl: 'https://api.deepseek.com/anthropic' }
const marker = { type: 'ephemeral', ttl: '1h' }
const request = {
  model: 'deepseek-v4-flash', max_tokens: 16,
  system: [{ type: 'text', text: 'Help with code', cache_control: marker }],
  tools: [{ name: 'read', input_schema: { type: 'object' }, cache_control: marker }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Read file', cache_control: marker }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {}, cache_control: marker }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Hello', cache_control: marker }], cache_control: marker }] }
  ]
}

describe('group budget cache hints', () => {
  it('preserves Claude Code cache hints for official DeepSeek routes and counts their full input', () => {
    const prepared = prepareBudgetRequest('anthropic_messages', request, 8192, [deepseek, { ...deepseek, baseUrl: `${deepseek.baseUrl}/` }])
    expect(prepared.body).toEqual(request)
    expect(prepared.inputTokens).toBe(Buffer.byteLength(JSON.stringify(request), 'utf8') + 256)
    expect(prepared.outputTokens).toBe(16)
  })

  it.each([
    'https://api.anthropic.com', 'https://proxy.example/anthropic',
    'https://api.deepseek.com.evil.invalid/anthropic', 'https://api.deepseek.com@evil.invalid/anthropic',
    'http://api.deepseek.com/anthropic', 'https://api.deepseek.com:8443/anthropic',
    'https://api.deepseek.com/other', 'https://api.deepseek.com/anthropic?route=other',
    'https://user:password@api.deepseek.com/anthropic', 'not-a-url'
  ])('rejects cache hints if any fallback is not the verified endpoint: %s', baseUrl => {
    expect(() => prepareBudgetRequest('anthropic_messages', request, 8192, [deepseek, { ...deepseek, baseUrl }])).toThrow()
  })

  it('requires explicit routes and both client and upstream Anthropic protocols', () => {
    expect(() => prepareBudgetRequest('anthropic_messages', request, 8192)).toThrow()
    expect(() => prepareBudgetRequest('anthropic_messages', request, 8192, [])).toThrow()
    expect(() => prepareBudgetRequest('openai_chat', request, 8192, [deepseek])).toThrow()
    expect(() => prepareBudgetRequest('anthropic_messages', request, 8192, [{ ...deepseek, protocol: 'openai_chat' }])).toThrow()
  })

  it.each([null, false, 'ephemeral', {}, { type: 'unknown' }, { type: 'ephemeral', ttl: '2h' }, { type: 'ephemeral', extra: true }])('rejects malformed markers without weakening text-only validation: %j', cache_control => {
    expect(() => prepareBudgetRequest('anthropic_messages', {
      ...request, system: [{ type: 'text', text: 'Hello', cache_control }]
    }, 8192, [deepseek])).toThrow()
    expect(() => prepareBudgetRequest('anthropic_messages', {
      ...request, tools: [{ name: 'read', input_schema: {}, cache_control }]
    }, 8192, [deepseek])).toThrow()
  })

  it('retains image, hosted tool, output cap and unverified top-level cache protection', () => {
    for (const patch of [
      { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' }, cache_control: marker }] }] },
      { tools: [{ type: 'web_search_20250305', name: 'web_search', cache_control: marker }] },
      { max_tokens: 9000 }, { cache_control: marker }
    ]) expect(() => prepareBudgetRequest('anthropic_messages', { ...request, ...patch }, 8192, [deepseek])).toThrow()
  })

  it('rejects top-level cache activation for other providers too', () => {
    expect(() => prepareBudgetRequest('anthropic_messages', {
      messages: [{ role: 'user', content: 'Hello' }], cache_control: marker
    }, 8192, [{ ...deepseek, baseUrl: 'https://api.anthropic.com' }])).toThrow()
  })
})
