import { HttpException, ServiceUnavailableException } from '@nestjs/common'
import { Prisma, type QuotaPolicy } from '@prisma/client'
import type { Response as ClientResponse } from 'express'
import { Readable, Transform } from 'node:stream'
import Decimal from 'decimal.js'
import type { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { GatewayIdentity } from '../../../packages/security/src/gateway-auth.js'
import { GroupBudgetService, type BudgetReservation } from '../../../packages/quota/src/group-budget.service.js'
import type { ProjectBudgetService } from '../../../packages/quota/src/project-budget.service.js'
import { RedisQuotaService } from '../../../packages/quota/src/redis-quota.js'
import { estimateBudgetCost, prepareBudgetRequest } from '../../../packages/quota/src/group-budget.js'
import { calculateCost } from '../../../packages/gateway-core/src/cost.js'
import { relayRequest, type RelayCandidate, type RelayResult } from '../../../packages/gateway-core/src/relay.js'
import type { GatewayProtocol, NormalizedUsage } from '../../../packages/gateway-core/src/protocol.js'
import { StreamUsageCollector } from '../../../packages/gateway-core/src/stream-usage.js'
import { parseUcliContext } from '../../../packages/gateway-core/src/ucli-context.js'

// Budgeted calls share authentication, catalog, routing and pricing; only the durable ledger differs.
type BudgetReservationRef = Pick<BudgetReservation, 'id' | 'requestId' | 'periodId' | 'reservedCny'>

interface BudgetLifecycle {
  reserve(input: { requestId: string; identity: GatewayIdentity & { groupId: string; projectId?: string | null };
    startedAt: Date; estimateCny: string; snapshot: Prisma.InputJsonObject }): Promise<BudgetReservationRef>
  extend(ref: BudgetReservationRef, additionalCny: string, attemptSnapshot: Prisma.InputJsonObject): Promise<BudgetReservationRef>
  markDispatched(ref: BudgetReservationRef, leaseUntil: Date, attempt?: Prisma.InputJsonObject): Promise<unknown>
  settle(ref: BudgetReservationRef, input: { actualCny: string; usage: Prisma.UsageLogUncheckedCreateInput }): Promise<{ exceeded: boolean }>
  hold(ref: BudgetReservationRef, input: { actualCny: string; unresolvedCny: string;
    usage: Prisma.UsageLogUncheckedCreateInput; reason: string }): Promise<unknown>
  release(ref: BudgetReservationRef, reason: string): Promise<unknown>
  markUncertain(ref: BudgetReservationRef, reason: string): Promise<unknown>
  syncQuota(ref: BudgetReservationRef, quota: RedisQuotaService): Promise<unknown>
}

export async function relayBudgetedRequest(input: {
  prisma: PrismaService; quota: RedisQuotaService; budget: GroupBudgetService;
  projectBudget?: ProjectBudgetService; protocol: GatewayProtocol; body: Record<string, any>;
  principal: GatewayIdentity & { groupId: string }; response: ClientResponse; candidates: RelayCandidate[]; policies: QuotaPolicy[];
  requestId: string; startedAt: Date; contextSize: number; headers: Record<string, string | string[] | undefined>
}) {
  const { prisma, quota, protocol, principal, response, candidates, policies, requestId, startedAt, headers } = input
  const budgetPrincipal = principal.projectId ? { ...principal, projectId: principal.projectId } : principal
  if (principal.projectId && !input.projectBudget) throw new Error('Project budget service is required for project credentials')
  const budget = (principal.projectId ? input.projectBudget : input.budget) as unknown as BudgetLifecycle
  const prepared = prepareBudgetRequest(protocol, input.body, input.contextSize, candidates)
  const { body, inputTokens, outputTokens } = prepared
  const estimateCny = estimateBudgetCost(inputTokens, outputTokens, candidates.map(c => c.cost))
  const estimateTokens = inputTokens + outputTokens
  const micro = (amount: string) => {
    const value = new Decimal(amount).times(1_000_000).ceil().toNumber()
    if (!Number.isSafeInteger(value)) throw new HttpException({ code: 'unsupported_budget_estimation', message: 'Cost exceeds the legacy quota numeric range' }, 400)
    return value
  }
  const context = parseUcliContext(headers)
  const actor = await prisma.account.findUniqueOrThrow({ where: { id: principal.sub }, select: { displayName: true } })
  const group = await prisma.usageGroup.findUniqueOrThrow({ where: { id: principal.groupId }, select: { name: true } })
  const project = principal.projectId ? await prisma.project.findUniqueOrThrow({
    where: { id: principal.projectId }, select: { name: true }
  }) : null
  const key = principal.apiKeyId ? await prisma.employeeApiKey.findUniqueOrThrow({ where: { id: principal.apiKeyId }, select: { name: true, secretHint: true } }) : null
  const initial = candidates[0]!
  const usageBase = {
    requestId, organizationId: principal.organizationId, accountId: principal.sub, groupId: principal.groupId,
    budgetProjectId: budgetPrincipal.projectId ?? null,
    credentialType: principal.credentialType, apiKeyId: principal.apiKeyId ?? null, deviceId: principal.deviceId ?? null,
    actorSnapshot: { employeeName: actor.displayName, regionName: group.name,
      ...(project ? { projectName: project.name } : {}), ...(key ? { keyName: key.name, keyHint: key.secretHint } : {}) }, ...context,
    protocol: { openai_chat: 'OPENAI_CHAT', openai_responses: 'OPENAI_RESPONSES', anthropic_messages: 'ANTHROPIC_MESSAGES', gemini: 'GEMINI' }[protocol] as Prisma.UsageLogUncheckedCreateInput['protocol'],
    publicModelId: String(body.model), upstreamModel: initial.upstreamModel, channelId: initial.channelId, channelModelId: initial.channelModelId,
    startedAt, finishedAt: startedAt, durationMs: 0, costUsd: '0.00000000', usageSource: 'ESTIMATED' as const, streaming: body.stream === true,
    statusCode: 503, errorCode: 'RECONCILIATION_REQUIRED', costSnapshot: { ...initial.cost, billingState: 'UNKNOWN' }
  }
  const reservations: Awaited<ReturnType<RedisQuotaService['reserve']>>[] = []
  let reservation: BudgetReservationRef
  try {
    for (const policy of policies) reservations.push(await quota.reserve({ organizationId: principal.organizationId,
      accountId: policy.accountId ?? '*', model: policy.publicModelId ?? '*', now: startedAt, requestId, policyId: policy.id },
      { tokens: estimateTokens, costMicroUsd: micro(estimateCny) }, { ...policy, dailyCostUsd: policy.dailyCostUsd?.toString(), monthlyCostUsd: policy.monthlyCostUsd?.toString() }))
    reservation = await budget.reserve({ requestId, identity: principal, startedAt, estimateCny,
      snapshot: JSON.parse(JSON.stringify({ usage: usageBase, redis: reservations, inputTokens, outputTokens })) })
  } catch (error) {
    await Promise.allSettled(reservations.map(r => quota.release(r)))
    throw error
  }
  const cancellation = new AbortController()
  let finalized = false; let dispatched = false; let firstTokenMs: number | null = null
  const close = () => { if (!response.writableFinished) cancellation.abort() }
  response.once('close', close)
  const lease = () => new Date(Date.now() + Math.max(...candidates.map(c => c.timeoutMs)) + 60_000)
  const heartbeat = setInterval(() => {
    if (finalized) return
    void Promise.all([budget.markDispatched(reservation, lease()), ...reservations.map(r => quota.renew(r))]).catch(error => {
      if (!finalized) { console.error('group-request-lease-failed', { requestId, message: error.message }); cancellation.abort() }
    })
  }, 30_000)
  heartbeat.unref()
  const cleanup = () => { clearInterval(heartbeat); response.removeListener?.('close', close) }
  const sync = async () => {
    await budget.syncQuota(reservation, quota).catch(error => console.error('group-quota-sync-pending', { requestId, message: error.message }))
  }
  const persist = async (attempts: RelayResult['attempts'], candidate: RelayCandidate, statusCode: number, interrupted = false) => {
    if (finalized) return
    finalized = true; cleanup()
    const knownCost = attempts.reduce((sum, a) => sum.plus(a.billingState === 'UNKNOWN' ? '0' : a.costCny ?? '0'), new Decimal(0)).toFixed(8)
    const unknown = attempts.filter(a => a.billingState === 'UNKNOWN')
    const unresolvedCny = unknown.reduce((sum, a) => sum.plus(estimateBudgetCost(inputTokens, outputTokens, [a.costSnapshot ?? candidate.cost])), new Decimal(0)).toFixed(8)
    const usage = attempts.reduce((sum, a) => ({ inputTokens: sum.inputTokens + (a.usage?.inputTokens ?? 0), outputTokens: sum.outputTokens + (a.usage?.outputTokens ?? 0),
      cachedTokens: sum.cachedTokens + (a.usage?.cachedTokens ?? 0), reasoningTokens: sum.reasoningTokens + (a.usage?.reasoningTokens ?? 0) }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 })
    const finishedAt = new Date()
    const log: Prisma.UsageLogUncheckedCreateInput = { ...usageBase, ...usage, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), firstTokenMs,
      statusCode, errorCode: unknown.length ? 'RECONCILIATION_REQUIRED' : statusCode >= 400 ? 'UPSTREAM_ERROR' : null,
      upstreamModel: candidate.upstreamModel, channelId: candidate.channelId, channelModelId: candidate.channelModelId,
      priceVersionId: candidate.cost.source === 'PUBLIC_MODEL_FALLBACK' ? candidate.cost.id : undefined,
      channelCostRuleId: candidate.cost.source === 'CHANNEL_COST_RULE' ? candidate.cost.id : undefined,
      costUsd: knownCost, costSnapshot: { ...candidate.cost, billingState: unknown.length ? 'UNKNOWN' : attempts.some(a => a.billingState === 'ESTIMATED') ? 'ESTIMATED' : 'CONFIRMED' },
      usageSource: attempts.some(a => a.billingState === 'ESTIMATED' || a.billingState === 'UNKNOWN') ? 'ESTIMATED' : 'UPSTREAM',
      clientCancelled: cancellation.signal.aborted, streamInterrupted: interrupted, switched: attempts.length > 1, routeAttempts: attempts.length,
      routes: { create: attempts.map((a, index) => ({ channelId: a.channelId, channelKeyId: a.keyId, attempt: index + 1, startedAt,
        durationMs: a.durationMs, statusCode: a.status || null, errorType: a.errorCode, billingState: a.billingState,
        costCny: a.billingState === 'UNKNOWN' ? null : a.costCny, usageSnapshot: { ...(a.usage ?? {}), cost: { ...(a.costSnapshot ?? candidate.cost) } } })) } }
    const commit = () => unknown.length ? budget.hold(reservation, { actualCny: knownCost, unresolvedCny, usage: log, reason: 'Upstream billing could not be confirmed' }) : budget.settle(reservation, { actualCny: knownCost, usage: log })
    try { await commit() } catch {
      try { await commit() } catch (error) {
        await budget.markUncertain(reservation, 'Usage transaction failed; supplier reconciliation required').catch(() => undefined)
        console.error('group-settlement-pending', { requestId, message: (error as Error).message })
        throw new ServiceUnavailableException({ code: 'group_settlement_pending', message: 'Request accounting requires recovery', requestId })
      }
    }
    if (unknown.length) await Promise.all(reservations.map(r => quota.releaseConcurrency(r))).catch(error => console.error('group-concurrency-release-pending', { requestId, message: error.message }))
    await sync()
    await prisma.channelKey.updateMany({ where: { id: candidate.keyId, deletedAt: null }, data: statusCode < 400 ? { health: 'HEALTHY', isolatedUntil: null, lastUsedAt: finishedAt }
      : [401, 403].includes(statusCode) ? { health: 'UNHEALTHY', enabled: false } : { health: 'DEGRADED' } }).catch(() => undefined)
  }
  let result: RelayResult
  try {
    const header = (name: string) => Array.isArray(headers[name]) ? headers[name].join(',') : headers[name]
    result = await relayRequest({ requestId, candidates, body, signal: cancellation.signal,
      incomingHeaders: { 'anthropic-version': header('anthropic-version'), 'anthropic-beta': header('anthropic-beta') },
      beforeAttempt: async (candidate, index, previous) => {
        if (index && previous[index - 1].billingState !== 'NO_CHARGE') {
          reservation = await budget.extend(reservation, estimateCny, { attemptId: String(index + 1), previous: JSON.parse(JSON.stringify(previous[index - 1])),
            channelId: candidate.channelId, price: { ...candidate.cost } })
        }
        await Promise.all(reservations.map(r => quota.renew(r)))
        await budget.markDispatched(reservation, lease(), { attemptId: String(index + 1), channelId: candidate.channelId,
          channelModelId: candidate.channelModelId, keyId: candidate.keyId, price: { ...candidate.cost } })
        dispatched = true
      } })
  } catch (error) {
    const attempts: RelayResult['attempts'] = (error as any).attempts ?? []
    if (!attempts.length && !dispatched) { finalized = true; cleanup(); await budget.release(reservation, 'Not dispatched'); await sync() }
    else {
      if (!attempts.length) attempts.push({ channelId: initial.channelId, keyId: initial.keyId, status: 0, durationMs: 0, billingState: 'UNKNOWN', costSnapshot: initial.cost })
      await persist(attempts, candidates.find(c => c.keyId === attempts.at(-1)?.keyId) ?? initial, cancellation.signal.aborted ? 499 : 503)
    }
    if (error instanceof HttpException) throw error
    throw new ServiceUnavailableException({ code: 'upstream_unavailable', message: 'Upstream request failed', requestId })
  }
  const finishUsage = (usage: NormalizedUsage, interrupted: boolean) => {
    const attempt = result.attempts.at(-1)!
    if (result.response.ok) {
      attempt.usage = usage; attempt.costSnapshot = result.candidate.cost
      attempt.billingState = interrupted || usage.unpricedTokens ? 'UNKNOWN' : usage.source === 'upstream' ? 'CONFIRMED' : 'ESTIMATED'
      attempt.costCny = calculateCost(usage, result.candidate.cost)
    }
  }
  response.status(result.response.status)
  result.response.headers.forEach((value, name) => {
    if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'x-ucli-request-id', 'cache-control'].includes(name.toLowerCase())) response.setHeader(name, value)
  })
  if (body.stream === true && result.response.ok && result.response.body) {
    const collector = new StreamUsageCollector(protocol)
    let interrupted = false
    const source = Readable.fromWeb(result.response.body as any)
    const marker = new Transform({ transform(chunk, _encoding, callback) {
      if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt.getTime()
      collector.push(Buffer.from(chunk)); callback(null, chunk)
    } })
    const finish = async () => {
      if (finalized) return
      const incomplete = interrupted || cancellation.signal.aborted || !collector.completed
      finishUsage(collector.usage(inputTokens), incomplete)
      await persist(result.attempts, result.candidate, cancellation.signal.aborted ? 499 : result.response.status, incomplete)
    }
    response.once('finish', () => { void finish().catch(error => console.error('group-stream-settlement-pending', { requestId, message: error.message })) })
    response.once('close', () => {
      if (!response.writableFinished) { interrupted = true; source.destroy(); marker.destroy() }
      void finish().catch(error => console.error('group-stream-settlement-pending', { requestId, message: error.message }))
    })
    source.once('error', () => { interrupted = true; marker.destroy(); response.destroy() })
    source.pipe(marker).pipe(response)
    return
  }
  try {
    const bytes = Buffer.from(await result.response.arrayBuffer())
    finishUsage(result.usage, false)
    await persist(result.attempts, result.candidate, result.response.status)
    response.send(bytes)
  } catch (error) {
    if (!finalized) { finishUsage(result.usage, true); await persist(result.attempts, result.candidate, 503, true) }
    throw error
  }
}
