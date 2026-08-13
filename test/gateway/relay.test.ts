import { describe, expect, it } from 'vitest'
import { relayRequest } from '../../packages/gateway-core/src/relay.js'

describe('upstream relay', () => {
  it('maps the model, hides the first failed candidate, and returns normalized usage', async () => {
    const requests: Array<{ url: string; body: any }> = []
    const fetcher = async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      if (requests.length === 1) return new Response('{"error":"busy"}', { status: 503 })
      return new Response(JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 2 } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }
    const base = { apiKey: 'secret', protocol: 'openai_chat' as const, maxRetries: 0, timeoutMs: 1000 }
    const result = await relayRequest({
      candidates: [
        { ...base, channelId: 'first', keyId: 'k1', baseUrl: 'https://one.example', upstreamModel: 'm1' },
        { ...base, channelId: 'second', keyId: 'k2', baseUrl: 'https://two.example', upstreamModel: 'm2' }
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
      candidates: [{ channelId: 'c', keyId: 'k', baseUrl: 'https://one.example', upstreamModel: 'm',
        apiKey: 'secret', protocol: 'openai_chat', maxRetries: 0, timeoutMs: 1000 }],
      body: { model: 'public', messages: [], stream: true }, fetcher: fetcher as typeof fetch
    })
    expect(sent.stream_options.include_usage).toBe(true)
  })

  it('honors per-channel retry count before switching candidate', async () => {
    let calls = 0
    const fetcher = async () => { calls += 1; return new Response('{}', { status: calls < 3 ? 503 : 200 }) }
    const result = await relayRequest({
      candidates: [{ channelId: 'c', keyId: 'k', baseUrl: 'https://one.example', upstreamModel: 'm',
        apiKey: 'secret', protocol: 'openai_chat', maxRetries: 2, timeoutMs: 1000 }],
      body: { model: 'public', messages: [] }, fetcher: fetcher as typeof fetch
    })
    expect(calls).toBe(3)
    expect(result.attempts).toHaveLength(3)
  })
})
