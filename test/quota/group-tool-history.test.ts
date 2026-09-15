import { expect, it } from 'vitest'
import { prepareBudgetRequest } from '../../packages/quota/src/group-budget.js'
it('accepts OpenAI tool call history and result while still rejecting image payloads', () => {
  const messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: '42' }]
  expect(prepareBudgetRequest('openai_chat', { model: 'test', messages, max_tokens: 16 }, 8192).body.messages).toEqual(messages)
  expect(() => prepareBudgetRequest('openai_chat', { model: 'test', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://example.invalid/image' } }] }] }, 8192)).toThrow()
})
