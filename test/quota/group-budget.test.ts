import { describe, expect, it } from 'vitest'
import { BadRequestException } from '@nestjs/common'
import { availableCny, budgetPeriodKey, cny, prepareBudgetRequest, estimateBudgetCost } from '../../packages/quota/src/group-budget.js'

describe('group budget amounts and periods', () => {
  it('uses local month boundaries without losing tiny costs', () => {
    expect(budgetPeriodKey('MONTHLY', 'Asia/Shanghai', new Date('2026-09-30T15:59:59Z'))).toBe('2026-09')
    expect(budgetPeriodKey('MONTHLY', 'Asia/Shanghai', new Date('2026-09-30T16:00:00Z'))).toBe('2026-10')
    expect(budgetPeriodKey('TOTAL', 'Asia/Shanghai', new Date())).toBe('TOTAL')
    expect(availableCny('0.00000003', '0.00000001', '0.00000001')).toBe('0.00000001')
    expect(availableCny('1', '1.2', '0')).toBe('-0.20000000')
  })
  it('rejects imprecise or ambiguous amounts and invalid timezones', () => {
    for (const value of ['', '-1', 'NaN', 'Infinity', '1e2', '0.000000001', '1000000000000', 1, null]) {
      expect(() => cny(value)).toThrow()
    }
    expect(cny('999999999999.99999999')).toBe('999999999999.99999999')
    expect(cny('0')).toBe('0.00000000')
    expect(() => budgetPeriodKey('MONTHLY', 'invalid', new Date())).toThrow()
  })

  it('writes protocol output caps and reserves the more expensive cached/reasoning token rates', () => {
    for (const [protocol, field] of [['openai_chat', 'max_tokens'], ['openai_responses', 'max_output_tokens'], ['anthropic_messages', 'max_tokens']] as const) {
      const input = protocol === 'openai_responses' ? { input: 'Hello' } : { messages: [{ role: 'user', content: 'Hello' }] }
      const prepared = prepareBudgetRequest(protocol, input, 8192)
      expect(prepared.body[field]).toBe(4096)
      expect(prepared.inputTokens).toBeGreaterThan(5)
    }
    expect(estimateBudgetCost(10, 20, [{ inputPerMillion: '1', cachedPerMillion: '3', outputPerMillion: '2', reasoningPerMillion: '4' }])).toBe('0.00011000')
  })

  it('rejects unbounded output and unsupported nontext billing before dispatch', () => {
    const messages = [{ role: 'user', content: 'hello' }]
    for (const cap of [-1, 0, 1.5, '16', 9000]) expect(() => prepareBudgetRequest('openai_chat', { messages, max_tokens: cap }, 8192)).toThrow(BadRequestException)
    expect(() => prepareBudgetRequest('openai_chat', { messages, max_tokens: 16, max_completion_tokens: 32 }, 8192)).toThrow()
    expect(() => prepareBudgetRequest('openai_chat', { messages, n: 2 }, 8192)).toThrow()
    expect(() => prepareBudgetRequest('openai_chat', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image' } }] }] }, 8192)).toThrow()
    expect(() => prepareBudgetRequest('openai_responses', { input: 'hello', previous_response_id: 'unknown-context' }, 8192)).toThrow()
    for (const body of [{ messages: 'not an array' }, { messages: [null] }, { messages, tools: {} }, { messages, modalities: 'audio' }]) {
      expect(() => prepareBudgetRequest('openai_chat', body, 8192)).toThrow(BadRequestException)
    }
    expect(() => prepareBudgetRequest('anthropic_messages', { messages, system: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }, 8192)).toThrow(BadRequestException)
  })
})
