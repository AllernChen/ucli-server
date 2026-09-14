import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { geminiResponseToOpenAI, geminiUrl, GeminiStreamTranslator, toGeminiRequest } from './gemini.js'
import type { GatewayProtocol, NormalizedUsage } from './protocol.js'
import { normalizeUsage, retryableBeforeResponse, upstreamUrl } from './protocol.js'
import type { ResolvedCost } from './cost-schedule.js'
import { calculateCost } from './cost.js'

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
    billingState?: 'CONFIRMED' | 'ESTIMATED' | 'UNKNOWN' | 'NO_CHARGE'
    costCny?: string
    usage?: NormalizedUsage
    costSnapshot?: ResolvedCost
  }>
}

export async function relayRequest({ candidates, body, incomingHeaders, fetcher = fetch, signal, requestId, beforeAttempt }: {
  candidates: RelayCandidate[]
  body: Record<string, unknown>
  incomingHeaders?: Record<string, string | undefined>
  fetcher?: typeof fetch
  signal?: AbortSignal
  requestId?: string
  beforeAttempt?: (candidate: RelayCandidate, attemptIndex: number, previous: RelayResult['attempts']) => Promise<void>
}): Promise<RelayResult> {
  const resolvedRequestId = requestId ?? randomUUID()
  const attempts: RelayResult['attempts'] = []
  for (const candidate of candidates) {
    for (let retry = 0; retry <= Math.max(0, candidate.maxRetries); retry += 1) {
      try {
        signal?.throwIfAborted()
        await beforeAttempt?.(candidate, attempts.length, attempts)
        signal?.throwIfAborted()
      } catch (error) { throw Object.assign(error as Error, { attempts, requestId: resolvedRequestId }) }
      const started = Date.now()
      const controller = new AbortController()
      let timedOut = false
      const fetchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const attempt: RelayResult['attempts'][number] = { channelId: candidate.channelId, keyId: candidate.keyId, status: 0, durationMs: 0,
        ...(beforeAttempt ? { billingState: 'UNKNOWN', costSnapshot: candidate.cost } : {}) }
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, candidate.timeoutMs)
      try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-ucli-request-id': resolvedRequestId }
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
          if (incomingHeaders?.['anthropic-beta']) headers['anthropic-beta'] = incomingHeaders['anthropic-beta']
        } else headers.authorization = `Bearer ${candidate.apiKey}`
        url = upstreamUrl(candidate.baseUrl, candidate.protocol)
        outgoingBody = { ...body, model: candidate.upstreamModel }
        if (candidate.protocol === 'openai_chat' && body.stream === true) {
          outgoingBody.stream_options = { ...(body.stream_options as object || {}), include_usage: true }
        }
      }
      const response = await fetcher(url, {
        method: 'POST', headers, body: JSON.stringify(outgoingBody), signal: fetchSignal
      })
      attempt.status = response.status; attempt.durationMs = Date.now() - started
      attempts.push(attempt)
      if (beforeAttempt && !response.ok) {
        const raw = await response.clone().json().catch(() => null)
        if (raw?.usage && Object.keys(raw.usage).length) {
          attempt.usage = normalizeUsage(raw.usage); attempt.costCny = calculateCost(attempt.usage, candidate.cost)
          attempt.billingState = attempt.usage.unpricedTokens || attempt.usage.source !== 'upstream' ? 'UNKNOWN' : 'CONFIRMED'
        } else if ([400, 401, 403, 404, 422, 429].includes(response.status)) {
          attempt.billingState = 'NO_CHARGE'; attempt.costCny = '0.00000000'
        }
      }
      if (!response.ok && retryableBeforeResponse(response.status, false)) {
        await response.body?.cancel().catch(() => undefined)
        continue
      }
      if (candidate.protocol === 'gemini') {
        if (body.stream === true) {
          const upstream = Readable.fromWeb(response.body as any)
          const translator = new GeminiStreamTranslator(candidate.upstreamModel)
          const webStream = Readable.toWeb(upstream.pipe(translator)) as unknown as ReadableStream
          return { requestId: resolvedRequestId, response: new Response(webStream, { status: response.status, headers: { 'content-type': 'text/event-stream' } }), usage: normalizeUsage(undefined), candidate, attempts }
        }
        const raw = await response.text()
        let translated = geminiResponseToOpenAI(null, candidate.upstreamModel)
        try { translated = geminiResponseToOpenAI(JSON.parse(raw), candidate.upstreamModel) } catch { /* 空/异常响应回退为空消息 */ }
        const usage = normalizeUsage((translated as any).usage)
        return { requestId: resolvedRequestId, response: new Response(JSON.stringify(translated), { status: response.status, headers: { 'content-type': 'application/json' } }), usage, candidate, attempts }
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
      if (beforeAttempt && !body.stream && response.ok) {
        attempt.usage = usage; attempt.costCny = calculateCost(usage, candidate.cost); attempt.billingState = usage.source === 'upstream' ? 'CONFIRMED' : 'ESTIMATED'
      }
      return { requestId: resolvedRequestId, response, usage, candidate, attempts }
      } catch (error) {
        const errorCode = timedOut || (error as { name?: string })?.name === 'AbortError'
          ? 'UPSTREAM_TIMEOUT'
          : 'UPSTREAM_NETWORK_ERROR'
        attempt.status = 0; attempt.durationMs = Date.now() - started; attempt.errorCode = errorCode
        if (!attempts.includes(attempt)) attempts.push(attempt)
      } finally { clearTimeout(timeout) }
    }
  }
  throw Object.assign(new Error('No upstream channel succeeded'), { code: 'UPSTREAM_UNAVAILABLE', requestId: resolvedRequestId, attempts })
}
