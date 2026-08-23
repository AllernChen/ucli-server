import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { geminiResponseToOpenAI, geminiUrl, GeminiStreamTranslator, toGeminiRequest } from './gemini.js'
import type { GatewayProtocol, NormalizedUsage } from './protocol.js'
import { normalizeUsage, retryableBeforeResponse, upstreamUrl } from './protocol.js'
import type { ResolvedCost } from './cost-schedule.js'

export interface RelayCandidate {
  channelId: string
  channelModelId: string
  keyId: string
  baseUrl: string
  apiKey: string
  upstreamModel: string
  protocol: GatewayProtocol
  maxRetries: number
  timeoutMs: number
  cost: ResolvedCost
}

export interface RelayResult {
  requestId: string
  response: Response
  usage: NormalizedUsage
  candidate: RelayCandidate
  attempts: Array<{
    channelId: string
    keyId: string
    status: number
    durationMs: number
    errorCode?: 'UPSTREAM_TIMEOUT' | 'UPSTREAM_NETWORK_ERROR'
  }>
}

export async function relayRequest({ candidates, body, incomingHeaders, fetcher = fetch, signal }: {
  candidates: RelayCandidate[]
  body: Record<string, unknown>
  incomingHeaders?: Record<string, string | undefined>
  fetcher?: typeof fetch
  signal?: AbortSignal
}): Promise<RelayResult> {
  const requestId = randomUUID()
  const attempts: RelayResult['attempts'] = []
  for (const candidate of candidates) {
    for (let retry = 0; retry <= Math.max(0, candidate.maxRetries); retry += 1) {
      const started = Date.now()
      const controller = new AbortController()
      let timedOut = false
      const cancel = () => controller.abort()
      if (signal?.aborted) controller.abort()
      else signal?.addEventListener('abort', cancel, { once: true })
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, candidate.timeoutMs)
      try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-ucli-request-id': requestId }
      let url: string
      let outgoingBody: Record<string, unknown>
      if (candidate.protocol === 'gemini') {
        headers['x-goog-api-key'] = candidate.apiKey
        url = geminiUrl(candidate.baseUrl, candidate.upstreamModel, body.stream === true)
        outgoingBody = toGeminiRequest(body)
      } else {
        if (candidate.protocol === 'anthropic_messages') {
          headers['x-api-key'] = candidate.apiKey
          headers['anthropic-version'] = incomingHeaders?.['anthropic-version'] || '2023-06-01'
        } else headers.authorization = `Bearer ${candidate.apiKey}`
        url = upstreamUrl(candidate.baseUrl, candidate.protocol)
        outgoingBody = { ...body, model: candidate.upstreamModel }
        if (candidate.protocol === 'openai_chat' && body.stream === true) {
          outgoingBody.stream_options = { ...(body.stream_options as object || {}), include_usage: true }
        }
      }
      const response = await fetcher(url, {
        method: 'POST', headers, body: JSON.stringify(outgoingBody), signal: controller.signal
      })
      attempts.push({ channelId: candidate.channelId, keyId: candidate.keyId, status: response.status, durationMs: Date.now() - started })
      if (!response.ok && retryableBeforeResponse(response.status, false)) {
        await response.body?.cancel().catch(() => undefined)
        continue
      }
      if (candidate.protocol === 'gemini') {
        if (body.stream === true) {
          const upstream = Readable.fromWeb(response.body as any)
          const translator = new GeminiStreamTranslator(candidate.upstreamModel)
          const webStream = Readable.toWeb(upstream.pipe(translator)) as unknown as ReadableStream
          return { requestId, response: new Response(webStream, { status: response.status, headers: { 'content-type': 'text/event-stream' } }), usage: normalizeUsage(undefined), candidate, attempts }
        }
        const raw = await response.text()
        let translated = geminiResponseToOpenAI(null, candidate.upstreamModel)
        try { translated = geminiResponseToOpenAI(JSON.parse(raw), candidate.upstreamModel) } catch { /* 空/异常响应回退为空消息 */ }
        const usage = normalizeUsage((translated as any).usage)
        return { requestId, response: new Response(JSON.stringify(translated), { status: response.status, headers: { 'content-type': 'application/json' } }), usage, candidate, attempts }
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
        const errorCode = timedOut || (error as { name?: string })?.name === 'AbortError'
          ? 'UPSTREAM_TIMEOUT'
          : 'UPSTREAM_NETWORK_ERROR'
        attempts.push({
          channelId: candidate.channelId, keyId: candidate.keyId, status: 0,
          durationMs: Date.now() - started, errorCode
        })
      } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel) }
    }
  }
  throw Object.assign(new Error('No upstream channel succeeded'), { code: 'UPSTREAM_UNAVAILABLE', requestId, attempts })
}
