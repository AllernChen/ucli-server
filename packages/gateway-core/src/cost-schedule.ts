import type { PriceSnapshot } from './cost.js'
import Decimal from 'decimal.js'

export interface ScheduledCost extends PriceSnapshot {
  id: string
  name?: string
  priority: number
  daysOfWeek: number[]
  startMinute: number
  endMinute: number
  validFrom: Date
  validUntil: Date | null
  createdAt: Date
  enabled: boolean
  currency: string
}

export interface ResolvedCost extends PriceSnapshot {
  id: string
  currency: 'CNY'
  source: 'CHANNEL_COST_RULE' | 'PUBLIC_MODEL_FALLBACK'
  timezone: string
  resolvedAt: string
  ruleName?: string
  daysOfWeek?: number[]
  startMinute?: number
  endMinute?: number
  priority?: number
}

export interface PublicModelFallbackCost extends PriceSnapshot {
  id: string
  currency: 'CNY'
}

export interface CostTransition {
  at: string
  cost: ResolvedCost | null
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

function localTime(at: Date, timezone: string): { weekday: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(at)
  } catch {
    throw new TypeError('Invalid IANA timezone')
  }
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value
  const weekday = WEEKDAYS[value('weekday') || '']
  const hour = Number(value('hour'))
  const minute = Number(value('minute'))
  if (!weekday || !Number.isInteger(hour) || !Number.isInteger(minute)) throw new TypeError('Invalid scheduled date')
  return { weekday, minute: hour * 60 + minute }
}

export function validateScheduledCost(rule: ScheduledCost): void {
  if (rule.currency !== 'CNY' || [rule.inputPerMillion, rule.outputPerMillion, rule.cachedPerMillion, rule.reasoningPerMillion]
    .some(value => !new Decimal(value).isFinite() || new Decimal(value).isNegative())) {
    throw new TypeError('Cost values must be non-negative CNY amounts')
  }
  if (!rule.daysOfWeek.length || rule.daysOfWeek.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new TypeError('Days of week must be ISO weekdays from 1 to 7')
  }
  if (![rule.startMinute, rule.endMinute].every(value => Number.isInteger(value) && value >= 0 && value <= 1439)) {
    throw new TypeError('Schedule minutes must be between 0 and 1439')
  }
}

export function validateCostTimezone(timezone: string): void {
  localTime(new Date(0), timezone)
}

function matchesLocalTime(rule: ScheduledCost, weekday: number, minute: number): boolean {
  if (rule.startMinute === rule.endMinute) return rule.daysOfWeek.includes(weekday)
  if (rule.startMinute < rule.endMinute) {
    return rule.daysOfWeek.includes(weekday) && minute >= rule.startMinute && minute < rule.endMinute
  }
  const previousWeekday = weekday === 1 ? 7 : weekday - 1
  return (rule.daysOfWeek.includes(weekday) && minute >= rule.startMinute) ||
    (rule.daysOfWeek.includes(previousWeekday) && minute < rule.endMinute)
}

export function resolveChannelCost(rules: ScheduledCost[], at: Date, timezone: string): ResolvedCost | null {
  if (!Number.isFinite(at.getTime())) throw new TypeError('Invalid scheduled date')
  for (const rule of rules) validateScheduledCost(rule)
  return resolveValidatedChannelCost(sortRules(rules), at, timezone)
}

function sortRules(rules: ScheduledCost[]): ScheduledCost[] {
  return [...rules].sort((left, right) => right.priority - left.priority || right.validFrom.getTime() - left.validFrom.getTime() ||
    right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id))
}

function resolveValidatedChannelCost(rules: ScheduledCost[], at: Date, timezone: string): ResolvedCost | null {
  const current = localTime(at, timezone)
  const rule = rules.find(item => item.enabled && item.validFrom <= at && (!item.validUntil || item.validUntil > at) &&
    matchesLocalTime(item, current.weekday, current.minute))
  if (!rule) return null
  return {
    id: rule.id, source: 'CHANNEL_COST_RULE', currency: 'CNY', inputPerMillion: rule.inputPerMillion,
    outputPerMillion: rule.outputPerMillion, cachedPerMillion: rule.cachedPerMillion,
    reasoningPerMillion: rule.reasoningPerMillion, timezone, resolvedAt: at.toISOString(),
    ruleName: rule.name, daysOfWeek: [...rule.daysOfWeek], startMinute: rule.startMinute,
    endMinute: rule.endMinute, priority: rule.priority
  }
}

function validateFallback(fallback: PublicModelFallbackCost | null): void {
  if (!fallback) return
  if (fallback.currency !== 'CNY' || [fallback.inputPerMillion, fallback.outputPerMillion, fallback.cachedPerMillion,
    fallback.reasoningPerMillion].some(value => !new Decimal(value).isFinite() || new Decimal(value).isNegative())) {
    throw new TypeError('Fallback cost values must be non-negative CNY amounts')
  }
}

function resolveWithPreparedRules(
  rules: ScheduledCost[], fallback: PublicModelFallbackCost | null, at: Date, timezone: string
): ResolvedCost | null {
  const scheduled = resolveValidatedChannelCost(rules, at, timezone)
  if (scheduled) return scheduled
  if (!fallback) return null
  return {
    ...fallback, source: 'PUBLIC_MODEL_FALLBACK', timezone, resolvedAt: at.toISOString()
  }
}

export function resolveChannelCostWithFallback(
  rules: ScheduledCost[], fallback: PublicModelFallbackCost | null, at: Date, timezone: string
): ResolvedCost | null {
  if (!Number.isFinite(at.getTime())) throw new TypeError('Invalid scheduled date')
  for (const rule of rules) validateScheduledCost(rule)
  validateFallback(fallback)
  validateCostTimezone(timezone)
  return resolveWithPreparedRules(sortRules(rules), fallback, at, timezone)
}

function sameEffectiveCost(left: ResolvedCost | null, right: ResolvedCost | null): boolean {
  return left?.id === right?.id && left?.source === right?.source
}

const WEEK_IN_MILLISECONDS = 8 * 24 * 60 * 60 * 1000
const MINUTE_IN_MILLISECONDS = 60 * 1000

function transitionCandidates(from: Date, until: Date, boundaries: Date[]): Date[] {
  const values = new Set<number>()
  const firstMinute = Math.floor(from.getTime() / MINUTE_IN_MILLISECONDS) * MINUTE_IN_MILLISECONDS + MINUTE_IN_MILLISECONDS
  for (let value = firstMinute; value <= until.getTime(); value += MINUTE_IN_MILLISECONDS) values.add(value)
  for (const boundary of boundaries) {
    if (boundary > from && boundary <= until) values.add(boundary.getTime())
  }
  return [...values].sort((left, right) => left - right).map(value => new Date(value))
}

export function nextCostTransition(
  rules: ScheduledCost[], fallback: PublicModelFallbackCost | null, at: Date, timezone: string
): CostTransition | null {
  if (!Number.isFinite(at.getTime())) throw new TypeError('Invalid scheduled date')
  for (const rule of rules) validateScheduledCost(rule)
  validateFallback(fallback)
  validateCostTimezone(timezone)
  const prepared = sortRules(rules)
  let current = resolveWithPreparedRules(prepared, fallback, at, timezone)
  const boundaries = rules.flatMap(rule => [rule.validFrom, rule.validUntil].filter((value): value is Date => Boolean(value)))
    .filter(value => value > at).sort((left, right) => left.getTime() - right.getTime())
  const enabledRules = rules.filter(rule => rule.enabled)
  if (!enabledRules.length) return null
  if (!boundaries.length && enabledRules.every(rule => rule.startMinute === rule.endMinute && rule.daysOfWeek.length === 7)) {
    return null
  }
  const validNow = enabledRules.filter(rule => rule.validFrom <= at && (!rule.validUntil || rule.validUntil > at))
  const firstFutureBoundary = boundaries[0]
  let cursor = validNow.length || !firstFutureBoundary ? at : new Date(firstFutureBoundary.getTime() - 1)
  let horizon = validNow.length || !firstFutureBoundary
    ? new Date(at.getTime() + WEEK_IN_MILLISECONDS)
    : new Date(firstFutureBoundary.getTime() + WEEK_IN_MILLISECONDS)
  if (cursor !== at) current = resolveWithPreparedRules(prepared, fallback, cursor, timezone)
  while (true) {
    for (const candidate of transitionCandidates(cursor, horizon, boundaries)) {
      const next = resolveWithPreparedRules(prepared, fallback, candidate, timezone)
      if (!sameEffectiveCost(current, next)) return { at: candidate.toISOString(), cost: next }
      current = next
    }
    const futureBoundary = boundaries.find(value => value > horizon)
    if (!futureBoundary) return null
    cursor = new Date(futureBoundary.getTime() - 1)
    current = resolveWithPreparedRules(prepared, fallback, cursor, timezone)
    horizon = new Date(futureBoundary.getTime() + WEEK_IN_MILLISECONDS)
  }
}

export function highestReservationCost(costs: PriceSnapshot[]): PriceSnapshot | null {
  if (!costs.length) return null
  const maximum = (field: keyof PriceSnapshot) => Decimal.max(...costs.map(cost => new Decimal(cost[field]))).toString()
  return {
    inputPerMillion: maximum('inputPerMillion'), outputPerMillion: maximum('outputPerMillion'),
    cachedPerMillion: maximum('cachedPerMillion'), reasoningPerMillion: maximum('reasoningPerMillion')
  }
}

function weeklyMinutes(rule: ScheduledCost): boolean[] {
  const result = Array<boolean>(7 * 1440).fill(false)
  const mark = (weekday: number, start: number, end: number) => {
    const offset = (weekday - 1) * 1440
    for (let minute = start; minute < end; minute++) result[offset + minute] = true
  }
  for (const weekday of rule.daysOfWeek) {
    if (rule.startMinute === rule.endMinute) mark(weekday, 0, 1440)
    else if (rule.startMinute < rule.endMinute) mark(weekday, rule.startMinute, rule.endMinute)
    else {
      mark(weekday, rule.startMinute, 1440)
      mark(weekday === 7 ? 1 : weekday + 1, 0, rule.endMinute)
    }
  }
  return result
}

export function costRulesOverlap(left: ScheduledCost, right: ScheduledCost): boolean {
  validateScheduledCost(left)
  validateScheduledCost(right)
  if (!left.enabled || !right.enabled) return false
  if ((left.validUntil && left.validUntil <= right.validFrom) || (right.validUntil && right.validUntil <= left.validFrom)) return false
  const leftMinutes = weeklyMinutes(left)
  const rightMinutes = weeklyMinutes(right)
  return leftMinutes.some((active, index) => active && rightMinutes[index])
}
