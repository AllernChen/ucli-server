import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common'
import type { GatewayProtocol as PrismaProtocol } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { nextModelHealth } from '../../../packages/gateway-core/src/model-health.js'
import type { GatewayProtocol } from '../../../packages/gateway-core/src/protocol.js'
import { relayRequest } from '../../../packages/gateway-core/src/relay.js'
import { resolveChannelCost, type ResolvedCost, type ScheduledCost } from '../../../packages/gateway-core/src/cost-schedule.js'
import { calculateCost } from '../../../packages/gateway-core/src/cost.js'
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

function failureCode(statusCode: number): { code: string; terminal: boolean } {
  if (statusCode === 401 || statusCode === 403) return { code: 'UPSTREAM_AUTH_FAILED', terminal: true }
  if (statusCode === 408 || statusCode === 0) return { code: 'UPSTREAM_TIMEOUT', terminal: false }
  if (statusCode === 429) return { code: 'UPSTREAM_RATE_LIMITED', terminal: false }
  if (statusCode >= 500) return { code: 'UPSTREAM_5XX', terminal: false }
  return { code: `UPSTREAM_HTTP_${statusCode}`, terminal: statusCode >= 400 && statusCode < 500 }
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
      if (!ok) ({ code: errorCode, terminal } = failureCode(statusCode))
    } catch (error: any) {
      const lastAttempt = error?.attempts?.at(-1)
      statusCode = Number(lastAttempt?.status || 0)
      ;({ code: errorCode, terminal } = failureCode(statusCode))
    }
    const transition = nextModelHealth(
      { consecutiveFailures: channelModel.consecutiveFailures },
      ok ? { ok: true } : { ok: false, terminal, errorCode: errorCode! }
    )
    const testedAt = new Date()
    await this.prisma.channelModel.update({ where: { id }, data: {
      ...transition, lastTestedAt: testedAt, ...(ok ? { lastSuccessAt: testedAt } : {})
    } })
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

  async runConversation(input: AdminModelTestRequest, actorId: string, signal?: AbortSignal): Promise<AdminModelTestResponse> {
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
      input: input.messages, temperature: input.temperature, max_output_tokens: input.maxTokens, stream: false
    } : protocol === 'ANTHROPIC_MESSAGES' ? {
      system: input.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'),
      messages: input.messages.filter(message => message.role !== 'system'), temperature: input.temperature,
      max_tokens: input.maxTokens, stream: false
    } : { messages: input.messages, temperature: input.temperature, max_tokens: input.maxTokens, stream: false }
    const started = Date.now()
    let ok = false
    let statusCode = 0
    let inputTokens = 0
    let outputTokens = 0
    let errorCode: string | null = null
    let terminal = false
    let rawResponse: any = null
    let assistantMessage = ''
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
      const raw = await result.response.text()
      try { rawResponse = JSON.parse(raw) } catch { rawResponse = raw }
      if (ok) assistantMessage = extractAssistantMessage(rawResponse, protocol)
      else ({ code: errorCode, terminal } = failureCode(statusCode))
    } catch (error: any) {
      if (signal?.aborted) throw error
      const lastAttempt = error?.attempts?.at(-1)
      statusCode = Number(lastAttempt?.status || 0)
      ;({ code: errorCode, terminal } = failureCode(statusCode))
    }
    const transition = nextModelHealth({ consecutiveFailures: channelModel.consecutiveFailures },
      ok ? { ok: true } : { ok: false, terminal, errorCode: errorCode! })
    const finishedAt = new Date()
    await this.prisma.channelModel.update({ where: { id: channelModel.id }, data: {
      ...transition, lastTestedAt: finishedAt, ...(ok ? { lastSuccessAt: finishedAt } : {})
    } })
    const latencyMs = Math.max(0, Date.now() - started)
    await this.prisma.channelModelProbe.create({ data: {
      channelModelId: channelModel.id, source: 'CONVERSATION', health: transition.health,
      statusCode: statusCode || null, latencyMs, firstTokenMs: null, errorCode, keySuffix: key.suffix
    } })
    return {
      channelModelId: channelModel.id, ok, statusCode, latencyMs, firstTokenMs: null, inputTokens, outputTokens,
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
    return concurrentMap(due, 3, model => this.testChannelModel(model.id, {}, null, 'SCHEDULED').catch(error => ({
      channelModelId: model.id, ok: false, statusCode: error?.status || 500, latencyMs: 0, firstTokenMs: null,
      inputTokens: 0, outputTokens: 0, keySuffix: null, errorCode: 'TEST_FAILED', health: 'UNHEALTHY' as const
    })))
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
