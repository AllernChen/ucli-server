import { HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import type { GatewayProtocol as PrismaProtocol } from '@prisma/client'
import { Response as ExpressResponse } from 'express'
import { Readable, Transform } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { calculateCost } from '../../../packages/gateway-core/src/cost.js'
import type { GatewayProtocol } from '../../../packages/gateway-core/src/protocol.js'
import { relayRequest, type RelayCandidate } from '../../../packages/gateway-core/src/relay.js'
import { selectChannel, selectKey, selectKeyRoundRobin } from '../../../packages/gateway-core/src/routing.js'
import { parseUcliContext } from '../../../packages/gateway-core/src/ucli-context.js'
import { decryptSecret } from '../../../packages/security/src/envelope-crypto.js'
import { loadMasterKey } from '../../../packages/security/src/master-key.js'
import { RedisQuotaService } from '../../../packages/quota/src/redis-quota.js'
import { recordQuotaRejection, recordQuotaSettlement } from '../../../packages/monitoring/src/quota-metrics.js'
import { StreamUsageCollector } from '../../../packages/gateway-core/src/stream-usage.js'
import { canAccessModel, type ModelAccessPrincipal } from '../../../packages/gateway-core/src/access-policy.js'
import { highestReservationCost, resolveChannelCost, type ResolvedCost, type ScheduledCost } from '../../../packages/gateway-core/src/cost-schedule.js'

const PRISMA_PROTOCOL: Record<GatewayProtocol, PrismaProtocol> = {
  openai_responses: 'OPENAI_RESPONSES', openai_chat: 'OPENAI_CHAT', anthropic_messages: 'ANTHROPIC_MESSAGES', gemini: 'GEMINI'
}

// 客户端协议 → 可服务的上游协议集合（openai_chat 客户端可翻译到 Gemini）。
const CLIENT_UPSTREAMS: Record<GatewayProtocol, PrismaProtocol[]> = {
  openai_responses: ['OPENAI_RESPONSES'],
  openai_chat: ['OPENAI_CHAT', 'GEMINI'],
  anthropic_messages: ['ANTHROPIC_MESSAGES'],
  gemini: ['GEMINI']
}

const PRISMA_TO_PROTOCOL: Record<PrismaProtocol, GatewayProtocol> = {
  OPENAI_RESPONSES: 'openai_responses', OPENAI_CHAT: 'openai_chat', ANTHROPIC_MESSAGES: 'anthropic_messages', GEMINI: 'gemini'
}

@Injectable()
export class GatewayService {
  constructor(private readonly prisma: PrismaService, private readonly quota: RedisQuotaService) {}

  async models(principal: ModelAccessPrincipal) {
    const models = await this.prisma.publicModel.findMany({ where: { enabled: true },
      include: { policies: true } })
    return models.filter(model => canAccessModel(model.policies, principal))
      .map(({ id, displayName, contextSize }) => ({ id, displayName, contextSize }))
  }

  private async candidates(publicModelId: string, protocol: GatewayProtocol, at: Date, fallbackPrice?: any): Promise<RelayCandidate[]> {
    const abilities = await this.prisma.channelModel.findMany({ where: {
      publicModelId, protocol: { in: CLIENT_UPSTREAMS[protocol] }, enabled: true,
      health: { in: ['HEALTHY', 'DEGRADED'] },
      channel: { enabled: true, health: { in: ['HEALTHY', 'DEGRADED'] }, OR: [{ circuitOpenUntil: null }, { circuitOpenUntil: { lt: new Date() } }] }
    }, include: { costRules: true, channel: { include: { keys: true } } } })
    const remaining = [...abilities]
    const result: RelayCandidate[] = []
    while (remaining.length) {
      const selected = selectChannel(remaining.map(item => ({
        ...item, id: item.channel.id, priority: item.channel.priority, weight: item.channel.weight,
        healthy: item.channel.health === 'HEALTHY' || item.channel.health === 'DEGRADED'
      })))
      if (!selected) break
      const ability = remaining.splice(remaining.findIndex(item => item.channel.id === selected.id), 1)[0]!
      const keyCandidates = ability.channel.keys.map(item => ({
        ...item, remainingUsd: item.remainingUsd === null ? null : Number(item.remainingUsd),
        healthy: item.health === 'HEALTHY' || item.health === 'DEGRADED'
      }))
      const key = ability.channel.keySelection === 'ROUND_ROBIN'
        ? selectKeyRoundRobin(keyCandidates, Math.floor(Date.now() / 1000))
        : selectKey(keyCandidates)
      if (!key) continue
      const rules: ScheduledCost[] = ability.costRules.map(rule => ({
        ...rule, inputPerMillion: rule.inputPerMillion.toString(), outputPerMillion: rule.outputPerMillion.toString(),
        cachedPerMillion: rule.cachedPerMillion.toString(), reasoningPerMillion: rule.reasoningPerMillion.toString()
      }))
      let scheduled: ResolvedCost | null
      try { scheduled = resolveChannelCost(rules, at, ability.channel.costTimezone) } catch {
        // A legacy or externally-corrupted rule must not take every other healthy
        // candidate down with it. New writes are rejected by API and DB validation.
        continue
      }
      const cost: ResolvedCost | null = scheduled || (fallbackPrice ? {
        id: fallbackPrice.id, source: 'PUBLIC_MODEL_FALLBACK', currency: 'USD', timezone: ability.channel.costTimezone,
        resolvedAt: at.toISOString(), inputPerMillion: fallbackPrice.inputPerMillion.toString(),
        outputPerMillion: fallbackPrice.outputPerMillion.toString(), cachedPerMillion: fallbackPrice.cachedPerMillion.toString(),
        reasoningPerMillion: fallbackPrice.reasoningPerMillion.toString()
      } : null)
      if (!cost) continue
      const apiKey = decryptSecret({ algorithm: 'aes-256-gcm', ciphertext: key.ciphertext, iv: key.iv, tag: key.tag }, loadMasterKey())
      result.push({
        channelId: ability.channel.id, channelModelId: ability.id, keyId: key.id, baseUrl: ability.channel.baseUrl,
        apiKey, upstreamModel: ability.upstreamModel, protocol: PRISMA_TO_PROTOCOL[ability.protocol],
        maxRetries: ability.channel.maxRetries, timeoutMs: ability.channel.timeoutMs, cost
      })
    }
    return result
  }

  async relay({ protocol, body, headers, principal, response }: {
    protocol: GatewayProtocol
    body: Record<string, any>
    headers: Record<string, string | string[] | undefined>
    principal: { sub: string; organizationId: string; deviceId: string; role: 'PLATFORM_ADMIN' | 'ORG_ADMIN' | 'MEMBER' }
    response: ExpressResponse
  }): Promise<void> {
    const publicModelId = String(body?.model || '')
    if (!publicModelId) throw new NotFoundException('Model is required')
    const startedAt = new Date()
    const model = await this.prisma.publicModel.findFirst({ where: { id: publicModelId, enabled: true }, include: {
      policies: true,
      prices: { where: { validFrom: { lte: startedAt }, OR: [{ validUntil: null }, { validUntil: { gt: startedAt } }] }, orderBy: { validFrom: 'desc' }, take: 1 }
    } })
    if (!model || !canAccessModel(model.policies, { organizationId: principal.organizationId, accountId: principal.sub, role: principal.role })) {
      throw new NotFoundException('Model is unavailable')
    }
    const price = model.prices[0]
    const candidates = await this.candidates(publicModelId, protocol, startedAt, price)
    if (!candidates.length) throw new ServiceUnavailableException('No healthy model channel')
    const context = parseUcliContext(headers)
    const policies = await this.prisma.quotaPolicy.findMany({ where: {
      OR: [
        { organizationId: principal.organizationId, accountId: null, publicModelId: null },
        { organizationId: principal.organizationId, accountId: null, publicModelId },
        { organizationId: principal.organizationId, accountId: principal.sub, publicModelId: null },
        { organizationId: principal.organizationId, accountId: principal.sub, publicModelId }
      ]
    } })
    // UTF-8 bytes are a conservative tokenizer-independent upper bound for text requests.
    const estimatedInputTokens = Math.max(1, Buffer.byteLength(JSON.stringify(body), 'utf8'))
    const estimatedOutputTokens = Math.max(1, Number(body.max_output_tokens ?? body.max_tokens ?? 4096))
    const estimateTokens = estimatedInputTokens + estimatedOutputTokens
    const reservationCost = highestReservationCost(candidates.map(candidate => candidate.cost))
    const estimatedCost = reservationCost ? calculateCost({
      inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens, cachedTokens: 0, reasoningTokens: 0, source: 'estimated'
    }, reservationCost) : '0'
    const reservations: any[] = []
    try {
      for (const policy of policies) {
        reservations.push(await this.quota.reserve({
          organizationId: principal.organizationId,
          accountId: policy.accountId || '*',
          model: policy.publicModelId || '*'
        }, {
          tokens: estimateTokens, costMicroUsd: Math.round(Number(estimatedCost) * 1_000_000)
        }, {
          dailyTokens: policy.dailyTokens, monthlyTokens: policy.monthlyTokens,
          dailyCostUsd: policy.dailyCostUsd?.toString(), monthlyCostUsd: policy.monthlyCostUsd?.toString(),
          qps: policy.qps, tpm: policy.tpm, concurrency: policy.concurrency
        }))
        const latest = reservations.at(-1)
        for (const threshold of latest?.thresholds || []) {
          await this.prisma.auditLog.create({ data: {
            actorAccountId: principal.sub, organizationId: principal.organizationId,
            action: 'QUOTA_THRESHOLD', resourceType: 'quota_policy', resourceId: policy.id,
            metadata: { threshold, publicModelId }
          } })
          void notifyQuotaAlert({ organizationId: principal.organizationId, accountId: principal.sub, publicModelId, threshold, policyId: policy.id })
        }
      }
    } catch (error) {
      await Promise.all(reservations.map(reservation => this.quota.release(reservation)))
      if (error instanceof HttpException && error.getStatus() === 429) {
        const code = String(error.getResponse())
        recordQuotaRejection(code)
        await this.prisma.auditLog.create({ data: {
          actorAccountId: principal.sub, organizationId: principal.organizationId,
          action: 'QUOTA_REJECTED', resourceType: 'model_request', resourceId: null,
          metadata: { publicModelId, code }
        } }).catch(logError => console.error('quota-rejection-audit-failed', { error: logError.message }))
      }
      throw error
    }
    const anthropicVersion = headers['anthropic-version']
    let result
    try {
      result = await relayRequest({ candidates, body, incomingHeaders: {
        'anthropic-version': Array.isArray(anthropicVersion) ? anthropicVersion[0] : anthropicVersion
      } })
    } catch (error) {
      await Promise.all(reservations.map(reservation => this.quota.release(reservation)))
      const failure = error as any
      const finishedAt = new Date()
      const fallback = candidates[0]!
      await this.prisma.usageLog.create({ data: {
        requestId: failure.requestId || randomUUID(), organizationId: principal.organizationId,
        accountId: principal.sub, deviceId: principal.deviceId, sessionId: context.sessionId,
        projectId: context.projectId, cliType: context.cliType, clientVersion: context.clientVersion,
        timezone: context.timezone, protocol: PRISMA_PROTOCOL[protocol], publicModelId,
        upstreamModel: fallback.upstreamModel, channelId: fallback.channelId, channelModelId: fallback.channelModelId,
        priceVersionId: fallback.cost.source === 'PUBLIC_MODEL_FALLBACK' ? fallback.cost.id : undefined,
        channelCostRuleId: fallback.cost.source === 'CHANNEL_COST_RULE' ? fallback.cost.id : undefined,
        costSnapshot: { ...fallback.cost }, costUsd: '0',
        startedAt, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(),
        usageSource: 'ESTIMATED', streaming: body.stream === true, statusCode: 503,
        errorCode: failure.code || 'UPSTREAM_UNAVAILABLE', routeAttempts: failure.attempts?.length || 1,
        switched: (failure.attempts?.length || 1) > 1,
        routes: failure.attempts?.length ? { create: failure.attempts.map((attempt: any, index: number) => ({
          channelId: attempt.channelId, channelKeyId: attempt.keyId, attempt: index + 1,
          startedAt, durationMs: attempt.durationMs, statusCode: attempt.status || null, errorType: failure.code || 'UPSTREAM_UNAVAILABLE'
        })) } : undefined
      } }).catch(logError => console.error('failure-usage-log-write-failed', { error: logError.message }))
      await Promise.all((failure.attempts || []).filter((attempt: any) => attempt.status === 0 || attempt.status === 429 || attempt.status >= 500)
        .map((attempt: any) => this.prisma.channelKey.updateMany({ where: { id: attempt.keyId }, data: {
          health: 'DEGRADED', isolatedUntil: new Date(Date.now() + 60_000)
        } })))
      await Promise.all([...new Set((failure.attempts || []).map((attempt: any) => attempt.channelId) as string[])]
        .map(channelId => this.prisma.channel.update({ where: { id: channelId }, data: {
          health: 'DEGRADED', circuitOpenUntil: new Date(Date.now() + 60_000)
        } })))
      throw new ServiceUnavailableException(`No upstream channel succeeded (request: ${failure.requestId})`)
    }
    response.status(result.response.status)
    response.setHeader('x-ucli-request-id', result.requestId)
    result.response.headers.forEach((value, name) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) response.setHeader(name, value)
    })
    let firstTokenMs: number | null = null
    let streamInterrupted = false
    const streamUsage = new StreamUsageCollector(protocol)
    let finalized = false
    const saveLog = async (statusCode: number) => {
      if (finalized) return
      finalized = true
      const finalUsage = body.stream === true ? streamUsage.usage(estimatedInputTokens) : result.usage
      const costUsd = calculateCost(finalUsage, result.candidate.cost)
      const settlementResults = await Promise.all(reservations.map(reservation => this.quota.settle(reservation, {
        tokens: finalUsage.inputTokens + finalUsage.outputTokens,
        costMicroUsd: Math.round(Number(costUsd) * 1_000_000)
      }))).catch(error => console.error('quota-settlement-failed', { requestId: result.requestId, error: error.message }))
      if (Array.isArray(settlementResults) && settlementResults.some(item => item.exceeded)) {
        await this.prisma.auditLog.create({ data: {
          actorAccountId: principal.sub, organizationId: principal.organizationId,
          action: 'QUOTA_HARD_LIMIT_EXCEEDED_ON_SETTLEMENT', resourceType: 'model_request',
          resourceId: result.requestId, metadata: { publicModelId }
        } }).catch(error => console.error('quota-settlement-audit-failed', { requestId: result.requestId, error: error.message }))
      }
      if (reservations.length && statusCode < 400) {
        recordQuotaSettlement(finalUsage.inputTokens + finalUsage.outputTokens, Math.round(Number(costUsd) * 1_000_000))
      }
      const finishedAt = new Date()
      await this.prisma.usageLog.create({ data: {
        requestId: result.requestId, organizationId: principal.organizationId, accountId: principal.sub,
        deviceId: principal.deviceId, sessionId: context.sessionId, projectId: context.projectId,
        cliType: context.cliType, clientVersion: context.clientVersion, timezone: context.timezone,
        protocol: PRISMA_PROTOCOL[protocol], publicModelId, upstreamModel: result.candidate.upstreamModel,
        channelId: result.candidate.channelId, channelModelId: result.candidate.channelModelId,
        priceVersionId: result.candidate.cost.source === 'PUBLIC_MODEL_FALLBACK' ? result.candidate.cost.id : undefined,
        channelCostRuleId: result.candidate.cost.source === 'CHANNEL_COST_RULE' ? result.candidate.cost.id : undefined,
        costSnapshot: { ...result.candidate.cost },
        startedAt, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), firstTokenMs,
        inputTokens: finalUsage.inputTokens, outputTokens: finalUsage.outputTokens,
        cachedTokens: finalUsage.cachedTokens, reasoningTokens: finalUsage.reasoningTokens,
        costUsd, usageSource: finalUsage.source === 'upstream' ? 'UPSTREAM' : 'ESTIMATED',
        streaming: body.stream === true, statusCode, routeAttempts: result.attempts.length,
        switched: result.attempts.length > 1, streamInterrupted,
        routes: { create: result.attempts.map((attempt, index) => ({
          channelId: attempt.channelId, channelKeyId: attempt.keyId, attempt: index + 1,
          startedAt, durationMs: attempt.durationMs, statusCode: attempt.status || null
        })) }
      } }).catch(error => console.error('usage-log-write-failed', { requestId: result.requestId, error: error.message }))
      if (statusCode === 401 || statusCode === 403) {
        await this.prisma.channelKey.updateMany({ where: { id: result.candidate.keyId }, data: {
          enabled: false, health: 'UNHEALTHY', isolatedUntil: null
        } })
        await this.prisma.channel.update({ where: { id: result.candidate.channelId }, data: { health: 'DEGRADED' } })
      } else if (statusCode < 400) {
        await this.prisma.channelKey.updateMany({ where: { id: result.candidate.keyId }, data: {
          health: 'HEALTHY', isolatedUntil: null, lastUsedAt: new Date()
        } })
      }
      const failedAttempts = result.attempts.filter(attempt => attempt.keyId !== result.candidate.keyId &&
        (attempt.status === 0 || attempt.status === 429 || attempt.status >= 500))
      await Promise.all(failedAttempts.map(attempt => this.prisma.channelKey.updateMany({
        where: { id: attempt.keyId }, data: { health: 'DEGRADED', isolatedUntil: new Date(Date.now() + 60_000) }
      })))
      await this.prisma.channel.update({ where: { id: result.candidate.channelId }, data: {
        health: statusCode < 400 ? 'HEALTHY' : undefined,
        lastSuccessAt: statusCode < 400 ? new Date() : undefined,
        circuitOpenUntil: statusCode < 400 ? null : undefined
      } })
    }
    if (!result.response.body) {
      response.end()
      await saveLog(result.response.status)
      return
    }
    if (body.stream === true) {
      const marker = new Transform({ transform(chunk, _encoding, callback) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt.getTime()
        streamUsage.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback(null, chunk)
      } })
      const source = Readable.fromWeb(result.response.body as any)
      source.on('error', () => { streamInterrupted = true })
      source.pipe(marker).pipe(response)
      response.once('finish', () => void saveLog(result.response.status))
      response.once('close', () => {
        if (!response.writableFinished) {
          streamInterrupted = true
          void saveLog(499)
        }
      })
      return
    }
    response.send(Buffer.from(await result.response.arrayBuffer()))
    await saveLog(result.response.status)
  }
}

async function notifyQuotaAlert(payload: Record<string, unknown>): Promise<void> {
  const url = process.env.QUOTA_ALERT_WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'quota_threshold', at: new Date().toISOString(), ...payload }) })
  } catch (error) { console.error('quota-alert-webhook-failed', { error: (error as Error).message }) }
}
