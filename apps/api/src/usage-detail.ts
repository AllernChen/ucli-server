import type { GroupBudgetEntry, RouteAttempt, UsageLog } from '@prisma/client'
import Decimal from 'decimal.js'
import { estimateProcurementCost } from '../../../packages/gateway-core/src/cost.js'

export interface BudgetRequestDetail {
  status: GroupBudgetEntry['status']
  initialEstimateCny: string | null
  extendedCny: string | null
  cumulativeReservedCny: string | null
  currentHeldCny: string
  settledCny: string
  manualFinal: boolean
  reason: string | null
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string | null => typeof value === 'string' ? value : null
function amount(value: unknown): Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  try { const result = new Decimal(value); return result.isFinite() && result.gte(0) ? result : null } catch { return null }
}

export function projectBudgetEntry(entry: Pick<GroupBudgetEntry, 'status' | 'reservedCny' | 'settledCny' | 'snapshot' | 'reason'>): BudgetRequestDetail {
  const snapshot = object(entry.snapshot)
  const initial = amount(snapshot.initialEstimateCny)
  const extensions = Array.isArray(snapshot.extensions) ? snapshot.extensions.map(extension => amount(object(extension).amount)) : null
  const extended = extensions?.every(value => value !== null) ? extensions.reduce<Decimal>((sum, value) => sum.plus(value!), new Decimal(0)) : null
  return { status: entry.status, initialEstimateCny: initial?.toFixed(8) ?? null, extendedCny: extended?.toFixed(8) ?? null,
    cumulativeReservedCny: initial && extended ? initial.plus(extended).toFixed(8) : null,
    currentHeldCny: ['RESERVED', 'RECONCILIATION_REQUIRED'].includes(entry.status) ? entry.reservedCny.toFixed(8) : '0.00000000',
    settledCny: entry.settledCny.toFixed(8), manualFinal: snapshot.manualFinal === true, reason: entry.reason }
}

// Same historical fields as the allocation price key; no current-price lookup.
export function safePrice(value: unknown) {
  const snapshot = object(value)
  const rate = (key: string) => amount(snapshot[key])?.toString() ?? null
  const inputPerMillion = rate('inputPerMillion'), cachedPerMillion = rate('cachedPerMillion'), outputPerMillion = rate('outputPerMillion'), reasoningPerMillion = rate('reasoningPerMillion')
  if (inputPerMillion === null || cachedPerMillion === null || outputPerMillion === null || reasoningPerMillion === null) return null
  return { id: text(snapshot.id), source: text(snapshot.source), ruleName: text(snapshot.ruleName),
    inputPerMillion, cachedPerMillion, outputPerMillion, reasoningPerMillion, timezone: text(snapshot.timezone),
    daysOfWeek: Array.isArray(snapshot.daysOfWeek) && snapshot.daysOfWeek.every(value => Number.isInteger(value)) ? snapshot.daysOfWeek as number[] : null,
    startMinute: Number.isInteger(snapshot.startMinute) ? snapshot.startMinute as number : null, endMinute: Number.isInteger(snapshot.endMinute) ? snapshot.endMinute as number : null,
    validFrom: text(snapshot.validFrom), validTo: text(snapshot.validTo) ?? text(snapshot.validUntil) }
}

type RouteWithChannel = RouteAttempt & { channel?: { name: string } | null }
export function projectRoute(route: RouteWithChannel) {
  const snapshot = object(route.usageSnapshot), price = safePrice(snapshot.cost)
  const token = (key: string) => {
    const value = snapshot[key]
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null
    return typeof value === 'string' && /^\d+$/.test(value) ? value : null
  }
  const inputTokens = token('inputTokens'), cachedTokens = token('cachedTokens'), outputTokens = token('outputTokens'), reasoningTokens = token('reasoningTokens')
  const tokens = [inputTokens, cachedTokens, outputTokens, reasoningTokens]
  const formula = price && tokens.every(value => value !== null && Number.isSafeInteger(Number(value)))
    ? estimateProcurementCost(price, { inputTokens: Number(inputTokens), cachedTokens: Number(cachedTokens), outputTokens: Number(outputTokens), reasoningTokens: Number(reasoningTokens) }) : null
  return { attempt: route.attempt, channelId: route.channelId, channelName: route.channel?.name ?? route.channelId,
    startedAt: route.startedAt, durationMs: route.durationMs, statusCode: route.statusCode, errorType: route.errorType,
    billingState: route.billingState, costCny: route.costCny?.toFixed(8) ?? null, inputTokens, cachedTokens, outputTokens, reasoningTokens,
    tokenUsageIncomplete: tokens.some(value => value === null), price,
    formulaCosts: formula ? { ...formula, differenceCny: route.costCny === null ? null : new Decimal(route.costCny.toString()).minus(formula.totalCost).toFixed(8) } : null }
}

export function projectUsage(row: UsageLog & { channel?: { name: string } | null; routes?: RouteWithChannel[] }, requestState: string, matchedCost: unknown, priceKeys: string[] = []) {
  const actor = object(row.actorSnapshot), cost = object(row.costSnapshot)
  return { id: row.id, requestId: row.requestId, startedAt: row.startedAt, finishedAt: row.finishedAt,
    accountId: row.accountId, employeeName: text(actor.employeeName) ?? row.accountId,
    groupId: row.groupId, groupName: row.groupId ? text(actor.groupName) ?? row.groupId : '历史未归组',
    apiKeyId: row.apiKeyId, keyName: row.apiKeyId ? text(actor.keyName) ?? row.apiKeyId : '设备凭据', keyHint: text(actor.keyHint),
    credentialType: row.credentialType, publicModelId: row.publicModelId, channelId: row.channelId, channelName: row.channel?.name ?? row.channelId,
    upstreamModel: row.upstreamModel, inputTokens: String(row.inputTokens), outputTokens: String(row.outputTokens), cachedTokens: String(row.cachedTokens), reasoningTokens: String(row.reasoningTokens),
    costCny: row.costUsd.toFixed(8), costUsd: row.costUsd.toFixed(8), currency: 'CNY' as const,
    matchedCostCny: new Decimal(String(matchedCost ?? 0)).toFixed(8), priceKeys, requestPrice: safePrice(cost),
    usageSource: row.usageSource, requestState, billingState: text(cost.billingState) ?? (row.usageSource === 'ESTIMATED' ? 'ESTIMATED' : 'CONFIRMED'),
    statusCode: row.statusCode, errorCode: row.errorCode, durationMs: row.durationMs, firstTokenMs: row.firstTokenMs, routeAttempts: row.routeAttempts,
    routes: (row.routes ?? []).map(projectRoute) }
}

export type UsageRow = ReturnType<typeof projectUsage>
export type SafeRoute = ReturnType<typeof projectRoute>
export type UsageDetail = UsageRow & { budget: BudgetRequestDetail | null; budgetAvailability: 'AVAILABLE' | 'NOT_APPLICABLE' | 'NOT_FOUND'; unallocatedCostCny: string }
