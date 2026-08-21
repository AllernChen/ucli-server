import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common'
import type { GatewayProtocol as PrismaProtocol } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { nextModelHealth } from '../../../packages/gateway-core/src/model-health.js'
import type { GatewayProtocol } from '../../../packages/gateway-core/src/protocol.js'
import { relayRequest } from '../../../packages/gateway-core/src/relay.js'
import { resolveChannelCost, type ResolvedCost, type ScheduledCost } from '../../../packages/gateway-core/src/cost-schedule.js'
import { calculateCost } from '../../../packages/gateway-core/src/cost.js'
import { StreamUsageCollector } from '../../../packages/gateway-core/src/stream-usage.js'
import { selectKey, selectKeyRoundRobin } from '../../../packages/gateway-core/src/routing.js'
import { decryptSecret } from '../../../packages/security/src/envelope-crypto.js'
import { loadMasterKey } from '../../../packages/security/src/master-key.js'

export const MODEL_TEST_FETCH = Symbol('MODEL_TEST_FETCH')

const PROTOCOLS: Record<PrismaProtocol, GatewayProtocol> = {
  OPENAI_RESPONSES: 'openai_responses', OPENAI_CHAT: 'openai_chat',
  ANTHROPIC_MESSAGES: 'anthropic_messages', GEMINI: 'gemini'
}

export interface ModelTestResult {
  channelModelId: string
  ok: boolean
  statusCode: number
  latencyMs: number
  firstTokenMs: number | null
  inputTokens: number
  outputTokens: number
  keySuffix: string | null
  errorCode: string | null
  health: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
}

export interface AdminModelTestRequest {
  channelModelId: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature: number
  maxTokens: number
  keyId?: string
  stream?: boolean
}

export interface AdminModelTestResponse extends ModelTestResult {
  assistantMessage: string
  rawResponse: unknown
  appliedCost: ResolvedCost
  estimatedProcurementCostUsd: string
}

type ProbeSource = 'MANUAL' | 'BATCH' | 'SCHEDULED'

function probeBody(protocol: PrismaProtocol): Record<string, unknown> {
  if (protocol === 'OPENAI_RESPONSES') return {
    input: [{ role: 'system', content: 'You are a health check.' }, { role: 'user', content: 'Reply OK.' }],
    max_output_tokens: 1, temperature: 0, stream: false
  }
  if (protocol === 'ANTHROPIC_MESSAGES') return {
    system: 'You are a health check.', messages: [{ role: 'user', content: 'Reply OK.' }],
    max_tokens: 1, temperature: 0, stream: false
  }
  return {
    messages: [{ role: 'system', content: 'You are a health check.' }, { role: 'user', content: 'Reply OK.' }],
    max_tokens: 1, temperature: 0, stream: false
  }
}

function upstreamErrorCode(payload: any): string | null {
  const value = payload?.error?.code ?? payload?.error?.type ?? payload?.code ?? payload?.type
  return typeof value === 'string' ? value.toLowerCase() : null
}

function failureCode(statusCode: number, payload?: unknown): { code: string; terminal: boolean } {
  if (statusCode === 401 || statusCode === 403) return { code: 'UPSTREAM_AUTH_FAILED', terminal: true }
  if (statusCode === 404 && upstreamErrorCode(payload) === 'model_not_found') return { code: 'UPSTREAM_MODEL_NOT_FOUND', terminal: true }
  if (statusCode === 408 || statusCode === 0) return { code: 'UPSTREAM_TIMEOUT', terminal: false }
  if (statusCode === 429) return { code: 'UPSTREAM_RATE_LIMITED', terminal: false }
  if (statusCode >= 500) return { code: 'UPSTREAM_5XX', terminal: false }
  return { code: `UPSTREAM_HTTP_${statusCode}`, terminal: false }
}

async function concurrentMap<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await operation(items[index]!)
    }
  }))
  return output
}

@Injectable()
export class ModelTestingService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(MODEL_TEST_FETCH) private readonly injectedFetcher?: typeof fetch
  ) {}

  private async applyHealthTransition(
    id: string, initialFailures: number, outcome: { ok: true } | { ok: false; terminal: boolean; errorCode: string }, testedAt: Date
  ) {
    let consecutiveFailures = initialFailures
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const transition = nextModelHealth({ consecutiveFailures }, outcome)
      const updated = await this.prisma.channelModel.updateMany({
        where: { id, consecutiveFailures },
        data: { ...transition, lastTestedAt: testedAt, ...(outcome.ok ? { lastSuccessAt: testedAt } : {}) }
      })
      if (updated.count === 1) return transition
      const latest = await this.prisma.channelModel.findUnique({ where: { id }, select: { consecutiveFailures: true } })
      if (!latest) throw new NotFoundException('Channel model not found')
      consecutiveFailures = latest.consecutiveFailures
    }
    throw new ConflictException('Channel model health changed concurrently; retry the test')
  }

  async testChannelModel(
    id: string, _input: Record<string, unknown> = {}, actorId: string | null = null, source: ProbeSource = 'MANUAL'
  ): Promise<ModelTestResult> {
    void actorId
    const channelModel: any = await this.prisma.channelModel.findUnique({
      where: { id }, include: { channel: { include: { keys: true } } }
    })
    if (!channelModel) throw new NotFoundException('Channel model not found')
    if (!channelModel.enabled || !channelModel.channel.enabled) throw new BadRequestException('Channel model is disabled')
    const keys = channelModel.channel.keys.map((key: any) => ({
      ...key, remainingUsd: key.remainingUsd === null ? null : Number(key.remainingUsd),
      healthy: key.health === 'HEALTHY' || key.health === 'DEGRADED'
    }))
    const key: any = channelModel.channel.keySelection === 'ROUND_ROBIN'
      ? selectKeyRoundRobin(keys, Math.floor(Date.now() / 1000)) : selectKey(keys)
    if (!key) throw new BadRequestException('Channel model requires an available key')
    const apiKey = key.plaintext ?? decryptSecret(
      { algorithm: 'aes-256-gcm', ciphertext: key.ciphertext, iv: key.iv, tag: key.tag }, loadMasterKey()
    )
    const started = Date.now()
    let ok = false
    let statusCode = 0
    let inputTokens = 0
    let outputTokens = 0
    let errorCode: string | null = null
    let terminal = false
    try {
      const result = await relayRequest({
        candidates: [{
          channelId: channelModel.channelId, keyId: key.id, baseUrl: channelModel.channel.baseUrl,
          channelModelId: channelModel.id,
          apiKey, upstreamModel: channelModel.upstreamModel, protocol: PROTOCOLS[channelModel.protocol as PrismaProtocol],
          maxRetries: channelModel.channel.maxRetries, timeoutMs: Math.min(channelModel.channel.timeoutMs, 30_000),
          cost: { id: 'health-check', source: 'PUBLIC_MODEL_FALLBACK', currency: 'USD', timezone: 'UTC',
            resolvedAt: new Date(started).toISOString(), inputPerMillion: '0', outputPerMillion: '0',
            cachedPerMillion: '0', reasoningPerMillion: '0' }
        }],
        body: probeBody(channelModel.protocol), fetcher: this.injectedFetcher ?? fetch
      })
      statusCode = result.response.status
      ok = result.response.ok
      inputTokens = result.usage.inputTokens
      outputTokens = result.usage.outputTokens
      if (!ok) {
        let payload: unknown
        try { payload = await result.response.clone().json() } catch { payload = undefined }
        ;({ code: errorCode, terminal } = failureCode(statusCode, payload))
      }
    } catch (error: any) {
      const lastAttempt = error?.attempts?.at(-1)
      statusCode = Number(lastAttempt?.status || 0)
      ;({ code: errorCode, terminal } = failureCode(statusCode))
    }
    const testedAt = new Date()
    const transition = await this.applyHealthTransition(id, channelModel.consecutiveFailures,
      ok ? { ok: true } : { ok: false, terminal, errorCode: errorCode! }, testedAt)
    const latencyMs = Math.max(0, Date.now() - started)
    await this.prisma.channelModelProbe.create({ data: {
      channelModelId: id, source, health: transition.health, statusCode: statusCode || null,
      latencyMs, firstTokenMs: null, errorCode, keySuffix: key.suffix
    } })
    return {
      channelModelId: id, ok, statusCode, latencyMs, firstTokenMs: null,
      inputTokens, outputTokens, keySuffix: key.suffix, errorCode, health: transition.health
    }
  }

  async runConversation(
    input: AdminModelTestRequest, actorId: string, signal?: AbortSignal, onDelta?: (content: string) => void
  ): Promise<AdminModelTestResponse> {
    void actorId
    if (!input.messages.length || input.messages.length > 50 || input.messages.some(message => message.content.length > 20_000) ||
      input.messages.reduce((sum, message) => sum + message.content.length, 0) > 100_000) {
      throw new BadRequestException('Conversation exceeds message or content limits')
    }
    const testedAt = new Date()
    const channelModel: any = await this.prisma.channelModel.findUnique({ where: { id: input.channelModelId }, include: {
      costRules: true, publicModel: { include: { prices: { where: { validFrom: { lte: testedAt }, OR: [
        { validUntil: null }, { validUntil: { gt: testedAt } }
      ] }, orderBy: { validFrom: 'desc' }, take: 1 } } }, channel: { include: { keys: true } }
    } })
    if (!channelModel) throw new NotFoundException('Channel model not found')
    if (!channelModel.enabled || !channelModel.channel.enabled) throw new BadRequestException('Channel model is disabled')
    const availableKeys = channelModel.channel.keys.map((key: any) => ({
      ...key, remainingUsd: key.remainingUsd === null ? null : Number(key.remainingUsd),
      healthy: key.health === 'HEALTHY' || key.health === 'DEGRADED'
    }))
    const eligibleKeys = input.keyId ? availableKeys.filter((key: any) => key.id === input.keyId) : availableKeys
    const key: any = channelModel.channel.keySelection === 'ROUND_ROBIN'
      ? selectKeyRoundRobin(eligibleKeys, Math.floor(Date.now() / 1000)) : selectKey(eligibleKeys)
    if (!key) throw new BadRequestException(input.keyId ? 'Selected key is unavailable for this channel' : 'Channel model requires an available key')
    const rules: ScheduledCost[] = channelModel.costRules.map((rule: any) => ({
      ...rule, inputPerMillion: rule.inputPerMillion.toString(), outputPerMillion: rule.outputPerMillion.toString(),
      cachedPerMillion: rule.cachedPerMillion.toString(), reasoningPerMillion: rule.reasoningPerMillion.toString()
    }))
    const fallback = channelModel.publicModel.prices[0]
    const appliedCost: ResolvedCost | null = resolveChannelCost(rules, testedAt, channelModel.channel.costTimezone) || (fallback ? {
      id: fallback.id, source: 'PUBLIC_MODEL_FALLBACK', currency: 'USD', timezone: channelModel.channel.costTimezone,
      resolvedAt: testedAt.toISOString(), inputPerMillion: fallback.inputPerMillion.toString(), outputPerMillion: fallback.outputPerMillion.toString(),
      cachedPerMillion: fallback.cachedPerMillion.toString(), reasoningPerMillion: fallback.reasoningPerMillion.toString()
    } : null)
    if (!appliedCost) throw new BadRequestException('Channel model has no current procurement cost')
    const apiKey = key.plaintext ?? decryptSecret(
      { algorithm: 'aes-256-gcm', ciphertext: key.ciphertext, iv: key.iv, tag: key.tag }, loadMasterKey()
    )
    const protocol = channelModel.protocol as PrismaProtocol
    const body: Record<string, unknown> = protocol === 'OPENAI_RESPONSES' ? {
      input: input.messages, temperature: input.temperature, max_output_tokens: input.maxTokens, stream: input.stream === true
    } : protocol === 'ANTHROPIC_MESSAGES' ? {
      system: input.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'),
      messages: input.messages.filter(message => message.role !== 'system'), temperature: input.temperature,
      max_tokens: input.maxTokens, stream: input.stream === true
    } : { messages: input.messages, temperature: input.temperature, max_tokens: input.maxTokens, stream: input.stream === true }
    const started = Date.now()
    let ok = false
    let statusCode = 0
    let inputTokens = 0
    let outputTokens = 0
    let errorCode: string | null = null
    let terminal = false
    let rawResponse: any = null
    let assistantMessage = ''
    let firstTokenMs: number | null = null
    try {
      const result = await relayRequest({ candidates: [{
        channelId: channelModel.channelId, channelModelId: channelModel.id, keyId: key.id,
        baseUrl: channelModel.channel.baseUrl, apiKey, upstreamModel: channelModel.upstreamModel,
        protocol: PROTOCOLS[protocol], maxRetries: 0, timeoutMs: Math.min(channelModel.channel.timeoutMs, 300_000), cost: appliedCost
      }], body, fetcher: this.injectedFetcher ?? fetch, signal })
      statusCode = result.response.status
      ok = result.response.ok
      inputTokens = result.usage.inputTokens
      outputTokens = result.usage.outputTokens
      if (ok && input.stream === true) {
        const streamed = await consumeConversationStream(
          result.response, PROTOCOLS[protocol], started, input.messages, signal, onDelta
        )
        assistantMessage = streamed.assistantMessage
        rawResponse = streamed.rawResponse
        inputTokens = streamed.inputTokens
        outputTokens = streamed.outputTokens
        firstTokenMs = streamed.firstTokenMs
      } else {
        const raw = await result.response.text()
        try { rawResponse = JSON.parse(raw) } catch { rawResponse = raw }
        if (ok) assistantMessage = extractAssistantMessage(rawResponse, protocol)
        else ({ code: errorCode, terminal } = failureCode(statusCode, rawResponse))
      }
    } catch (error: any) {
      if (signal?.aborted) throw error
      ok = false
      const lastAttempt = error?.attempts?.at(-1)
      if (statusCode === 200 && !lastAttempt) {
        statusCode = 0
        errorCode = 'UPSTREAM_STREAM_INTERRUPTED'
        terminal = false
      } else {
        statusCode = Number(lastAttempt?.status || 0)
        ;({ code: errorCode, terminal } = failureCode(statusCode))
      }
    }
    const finishedAt = new Date()
    const transition = await this.applyHealthTransition(channelModel.id, channelModel.consecutiveFailures,
      ok ? { ok: true } : { ok: false, terminal, errorCode: errorCode! }, finishedAt)
    const latencyMs = Math.max(0, Date.now() - started)
    await this.prisma.channelModelProbe.create({ data: {
      channelModelId: channelModel.id, source: 'CONVERSATION', health: transition.health,
      statusCode: statusCode || null, latencyMs, firstTokenMs, errorCode, keySuffix: key.suffix
    } })
    return {
      channelModelId: channelModel.id, ok, statusCode, latencyMs, firstTokenMs, inputTokens, outputTokens,
      keySuffix: key.suffix, errorCode, health: transition.health, assistantMessage, rawResponse, appliedCost,
      estimatedProcurementCostUsd: calculateCost({ inputTokens, outputTokens, cachedTokens: 0, reasoningTokens: 0,
        source: resultUsageSource(inputTokens, outputTokens) }, appliedCost)
    }
  }

  async testChannelModels(channelId: string, ids: string[], actorId: string | null): Promise<ModelTestResult[]> {
    const uniqueIds = [...new Set(ids)]
    if (!uniqueIds.length || uniqueIds.length > 20) throw new BadRequestException('Select between 1 and 20 channel models')
    const models = await this.prisma.channelModel.findMany({ where: { id: { in: uniqueIds } }, select: { id: true, channelId: true } })
    if (models.length !== uniqueIds.length || models.some((model: any) => model.channelId !== channelId)) {
      throw new BadRequestException('Every channel model must belong to the selected channel')
    }
    return concurrentMap(uniqueIds, 3, id => this.testChannelModel(id, {}, actorId, 'BATCH').catch(error => ({
      channelModelId: id, ok: false, statusCode: error?.status || 500, latencyMs: 0, firstTokenMs: null,
      inputTokens: 0, outputTokens: 0, keySuffix: null, errorCode: 'TEST_FAILED', health: 'UNHEALTHY' as const
    })))
  }

  async testDueChannelModels(now = new Date()): Promise<ModelTestResult[]> {
    const candidates: any[] = await this.prisma.channelModel.findMany({
      where: { enabled: true, probeEnabled: true, channel: { enabled: true } },
      select: { id: true, lastTestedAt: true, probeIntervalMinutes: true }, orderBy: { lastTestedAt: 'asc' }, take: 200
    })
    const due = candidates.filter(model => !model.lastTestedAt ||
      model.lastTestedAt.getTime() + model.probeIntervalMinutes * 60_000 <= now.getTime()).slice(0, 30)
    const results = await concurrentMap(due, 3, async model => {
      const claimed = await this.prisma.channelModel.updateMany({
        where: { id: model.id, lastTestedAt: model.lastTestedAt }, data: { lastTestedAt: now }
      })
      if (claimed.count !== 1) return null
      return this.testChannelModel(model.id, {}, null, 'SCHEDULED').catch(error => ({
        channelModelId: model.id, ok: false, statusCode: error?.status || 500, latencyMs: 0, firstTokenMs: null,
        inputTokens: 0, outputTokens: 0, keySuffix: null, errorCode: 'TEST_FAILED', health: 'UNHEALTHY' as const
      }))
    })
    return results.filter((result): result is ModelTestResult => result !== null)
  }
}

function resultUsageSource(inputTokens: number, outputTokens: number): 'upstream' | 'estimated' {
  return inputTokens || outputTokens ? 'upstream' : 'estimated'
}

function extractAssistantMessage(payload: any, protocol: PrismaProtocol): string {
  if (protocol === 'ANTHROPIC_MESSAGES') return (payload?.content || []).map((item: any) => item?.text || '').join('')
  if (protocol === 'OPENAI_RESPONSES') {
    if (typeof payload?.output_text === 'string') return payload.output_text
    return (payload?.output || []).flatMap((item: any) => item?.content || []).map((item: any) => item?.text || item?.output_text || '').join('')
  }
  const content = payload?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map((item: any) => item?.text || '').join('') : ''
}

function extractStreamDelta(payload: any, protocol: GatewayProtocol): string {
  if (protocol === 'anthropic_messages') return typeof payload?.delta?.text === 'string' ? payload.delta.text : ''
  if (protocol === 'openai_responses') return typeof payload?.delta === 'string' &&
    String(payload?.type || '').includes('output_text.delta') ? payload.delta : ''
  const content = payload?.choices?.[0]?.delta?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((item: any) => item?.text || '').join('') : ''
}

async function consumeConversationStream(
  response: Response, protocol: GatewayProtocol, started: number,
  messages: AdminModelTestRequest['messages'], signal?: AbortSignal, onDelta?: (content: string) => void
) {
  if (!response.body) throw new BadRequestException('Upstream returned an empty stream')
  const reader = response.body.getReader()
  const cancel = () => void reader.cancel().catch(() => undefined)
  signal?.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  const usage = new StreamUsageCollector(protocol)
  const rawEvents: unknown[] = []
  let buffer = ''
  let assistantMessage = ''
  let firstTokenMs: number | null = null
  let completed = false
  const consumeEvent = (event: string) => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('')
    if (!data) return
    if (data === '[DONE]') { completed = true; return }
    try {
      const payload = JSON.parse(data)
      if (rawEvents.length < 1000) rawEvents.push(payload)
      if (payload?.type === 'message_stop' || payload?.type === 'response.completed' ||
        payload?.choices?.some((choice: any) => choice?.finish_reason != null)) completed = true
      const delta = extractStreamDelta(payload, protocol)
      if (delta) {
        if (firstTokenMs === null) firstTokenMs = Math.max(0, Date.now() - started)
        assistantMessage += delta
        onDelta?.(delta)
      }
    } catch { /* Ignore non-JSON upstream event metadata. */ }
  }
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Model test was cancelled', 'AbortError')
      const { done, value } = await reader.read()
      if (signal?.aborted) throw new DOMException('Model test was cancelled', 'AbortError')
      if (done) break
      const chunk = Buffer.from(value)
      usage.push(chunk)
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() || ''
      events.forEach(consumeEvent)
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeEvent(buffer)
    if (signal?.aborted) throw new DOMException('Model test was cancelled', 'AbortError')
    if (!completed) throw new Error('Upstream stream ended before a completion event')
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  const normalized = usage.usage(Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 4)))
  return {
    assistantMessage, rawResponse: { stream: true, events: rawEvents, truncated: rawEvents.length >= 1000 },
    inputTokens: normalized.inputTokens, outputTokens: normalized.outputTokens, firstTokenMs
  }
}
