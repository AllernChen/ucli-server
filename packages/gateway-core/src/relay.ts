import { randomUUID } from 'node:crypto'
import type { GatewayProtocol, NormalizedUsage } from './protocol.js'
import { endpointFor, normalizeUsage, retryableBeforeResponse } from './protocol.js'

export interface RelayCandidate {
  channelId: string
  keyId: string
  baseUrl: string
  apiKey: string
  upstreamModel: string
  protocol: GatewayProtocol
  maxRetries: number
  timeoutMs: number
}

export interface RelayResult {
  requestId: string
  response: Response
  usage: NormalizedUsage
  candidate: RelayCandidate
  attempts: Array<{ channelId: string; keyId: string; status: number; durationMs: number }>
}

export async function relayRequest({ candidates, body, incomingHeaders, fetcher = fetch }: {
  candidates: RelayCandidate[]
  body: Record<string, unknown>
  incomingHeaders?: Record<string, string | undefined>
  fetcher?: typeof fetch
}): Promise<RelayResult> {
  const requestId = randomUUID()
  const attempts: RelayResult['attempts'] = []
  for (const candidate of candidates) {
    for (let retry = 0; retry <= Math.max(0, candidate.maxRetries); retry += 1) {
      const started = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), candidate.timeoutMs)
      try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-ucli-request-id': requestId }
      if (candidate.protocol === 'anthropic_messages') {
        headers['x-api-key'] = candidate.apiKey
        headers['anthropic-version'] = incomingHeaders?.['anthropic-version'] || '2023-06-01'
      } else headers.authorization = `Bearer ${candidate.apiKey}`
      const outgoingBody: Record<string, unknown> = { ...body, model: candidate.upstreamModel }
      if (candidate.protocol === 'openai_chat' && body.stream === true) {
        outgoingBody.stream_options = { ...(body.stream_options as object || {}), include_usage: true }
      }
      const response = await fetcher(new URL(endpointFor(candidate.protocol), candidate.baseUrl), {
        method: 'POST', headers, body: JSON.stringify(outgoingBody), signal: controller.signal
      })
      attempts.push({ channelId: candidate.channelId, keyId: candidate.keyId, status: response.status, durationMs: Date.now() - started })
      if (!response.ok && retryableBeforeResponse(response.status, false)) {
        await response.body?.cancel().catch(() => undefined)
        continue
      }
      let usage = normalizeUsage(undefined)
      if (!body.stream && response.ok) {
        const clone = response.clone()
        const raw = await clone.text()
        try { usage = normalizeUsage(JSON.parse(raw).usage) } catch { /* Estimate below. */ }
        if (usage.source === 'estimated') {
          usage = {
            inputTokens: Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(body), 'utf8') / 4)),
            outputTokens: Math.max(1, Math.ceil(Buffer.byteLength(raw, 'utf8') / 4)),
            cachedTokens: 0, reasoningTokens: 0, source: 'estimated'
          }
        }
      }
      return { requestId, response, usage, candidate, attempts }
      } catch (error) {
        attempts.push({ channelId: candidate.channelId, keyId: candidate.keyId, status: 0, durationMs: Date.now() - started })
      } finally { clearTimeout(timeout) }
    }
  }
  throw Object.assign(new Error('No upstream channel succeeded'), { code: 'UPSTREAM_UNAVAILABLE', requestId, attempts })
}
