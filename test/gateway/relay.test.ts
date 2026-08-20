import { describe, expect, it } from 'vitest'
import { relayRequest } from '../../packages/gateway-core/src/relay.js'

describe('upstream relay', () => {
  const cost = { id: 'cost', source: 'CHANNEL_COST_RULE' as const, currency: 'USD' as const, timezone: 'UTC',
    resolvedAt: '2026-01-01T00:00:00.000Z', inputPerMillion: '1', outputPerMillion: '1', cachedPerMillion: '0', reasoningPerMillion: '0' }
  it('maps the model, hides the first failed candidate, and returns normalized usage', async () => {
    const requests: Array<{ url: string; body: any }> = []
    const fetcher = async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      if (requests.length === 1) return new Response('{"error":"busy"}', { status: 503 })
      return new Response(JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 2 } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }
    const base = { apiKey: 'secret', protocol: 'openai_chat' as const, maxRetries: 0, timeoutMs: 1000, cost }
    const result = await relayRequest({
      candidates: [
        { ...base, channelId: 'first', channelModelId: 'cm1', keyId: 'k1', baseUrl: 'https://one.example', upstreamModel: 'm1' },
        { ...base, channelId: 'second', channelModelId: 'cm2', keyId: 'k2', baseUrl: 'https://two.example', upstreamModel: 'm2' }
      ],
      body: { model: 'public', messages: [] }, fetcher: fetcher as typeof fetch
    })
    expect(requests.map(item => item.body.model)).toEqual(['m1', 'm2'])
    expect(result.candidate.channelId).toBe('second')
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 2 })
  })

  it('requests usage in OpenAI chat streams', async () => {
    let sent: any
    const fetcher = async (_input: URL | RequestInfo, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return new Response('data: [DONE]\n\n', { status: 200 })
    }
    await relayRequest({
      candidates: [{ channelId: 'c', channelModelId: 'cm', keyId: 'k', baseUrl: 'https://one.example', upstreamModel: 'm',
        apiKey: 'secret', protocol: 'openai_chat', maxRetries: 0, timeoutMs: 1000, cost }],
      body: { model: 'public', messages: [], stream: true }, fetcher: fetcher as typeof fetch
    })
    expect(sent.stream_options.include_usage).toBe(true)
  })

  it('honors per-channel retry count before switching candidate', async () => {
    let calls = 0
    const fetcher = async () => { calls += 1; return new Response('{}', { status: calls < 3 ? 503 : 200 }) }
    const result = await relayRequest({
      candidates: [{ channelId: 'c', channelModelId: 'cm', keyId: 'k', baseUrl: 'https://one.example', upstreamModel: 'm',
        apiKey: 'secret', protocol: 'openai_chat', maxRetries: 2, timeoutMs: 1000, cost }],
      body: { model: 'public', messages: [] }, fetcher: fetcher as typeof fetch
    })
    expect(calls).toBe(3)
    expect(result.attempts).toHaveLength(3)
  })

  it('uses x-api-key and forwards anthropic-version for the Anthropic protocol', async () => {
    let captured: { url: string; headers: Record<string, string> } = { url: '', headers: {} }
    const fetcher = async (input: URL | RequestInfo, init?: RequestInit) => {
      captured = { url: String(input), headers: init?.headers as Record<string, string> }
      return new Response('{}', { status: 200 })
    }
    await relayRequest({
      candidates: [{ channelId: 'c', channelModelId: 'cm', keyId: 'k', baseUrl: 'https://up.example', upstreamModel: 'claude-sonnet',
        apiKey: 'sk-ant', protocol: 'anthropic_messages', maxRetries: 0, timeoutMs: 1000, cost }],
      body: { model: 'public', max_tokens: 16 },
      incomingHeaders: { 'anthropic-version': '2023-06-01' },
      fetcher: fetcher as typeof fetch
    })
    expect(captured.url).toBe('https://up.example/v1/messages')
    expect(captured.headers['x-api-key']).toBe('sk-ant')
    expect(captured.headers['anthropic-version']).toBe('2023-06-01')
    expect(captured.headers['authorization']).toBeUndefined()
  })

  it('does not retry a non-retryable 4xx and returns it as the result', async () => {
    let calls = 0
    const fetcher = async () => { calls += 1; return new Response('{"error":"bad"}', { status: 400 }) }
    const result = await relayRequest({
      candidates: [{ channelId: 'c', channelModelId: 'cm', keyId: 'k', baseUrl: 'https://up.example', upstreamModel: 'm',
        apiKey: 'k', protocol: 'openai_chat', maxRetries: 2, timeoutMs: 1000, cost }],
      body: { model: 'public', messages: [] }, fetcher: fetcher as typeof fetch
    })
    expect(calls).toBe(1)
    expect(result.attempts).toHaveLength(1)
    expect(result.response.status).toBe(400)
  })

  it('translates an OpenAI chat request to Gemini generateContent and back', async () => {
    let captured: { url: string; headers: Record<string, string>; body: any } = { url: '', headers: {}, body: null }
    const fetcher = async (input: any, init?: RequestInit) => {
      captured = { url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const result = await relayRequest({
      candidates: [{ channelId: 'c', channelModelId: 'cm', keyId: 'k', baseUrl: 'https://generativelanguage.googleapis.com', upstreamModel: 'gemini-2.0-flash',
        apiKey: 'gkey', protocol: 'gemini', maxRetries: 0, timeoutMs: 1000, cost }],
      body: { model: 'public', messages: [{ role: 'user', content: 'hello' }], stream: false },
      fetcher: fetcher as typeof fetch
    })
    expect(captured.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent')
    expect(captured.headers['x-goog-api-key']).toBe('gkey')
    expect(captured.headers['authorization']).toBeUndefined()
    expect(captured.body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }])
    expect(captured.body.model).toBeUndefined()
    const translated = await result.response.json()
    expect(translated.choices[0].message.content).toBe('hi')
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 1 })
  })
})
