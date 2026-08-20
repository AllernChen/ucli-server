import type { PriceSnapshot } from './cost.js'
import Decimal from 'decimal.js'

export interface ScheduledCost extends PriceSnapshot {
  id: string
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
  currency: 'USD'
  source: 'CHANNEL_COST_RULE'
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

function validateRule(rule: ScheduledCost): void {
  if (rule.currency !== 'USD' || [rule.inputPerMillion, rule.outputPerMillion, rule.cachedPerMillion, rule.reasoningPerMillion]
    .some(value => !new Decimal(value).isFinite() || new Decimal(value).isNegative())) {
    throw new TypeError('Cost values must be non-negative USD amounts')
  }
  if (!rule.daysOfWeek.length || rule.daysOfWeek.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new TypeError('Days of week must be ISO weekdays from 1 to 7')
  }
  if (![rule.startMinute, rule.endMinute].every(value => Number.isInteger(value) && value >= 0 && value <= 1439)) {
    throw new TypeError('Schedule minutes must be between 0 and 1439')
  }
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
  const current = localTime(at, timezone)
  for (const rule of rules) validateRule(rule)
  const rule = rules.filter(item => item.enabled && item.validFrom <= at && (!item.validUntil || item.validUntil > at) &&
      matchesLocalTime(item, current.weekday, current.minute))
    .sort((left, right) => right.priority - left.priority || right.validFrom.getTime() - left.validFrom.getTime() ||
      right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id))[0]
  if (!rule) return null
  return {
    id: rule.id, source: 'CHANNEL_COST_RULE', currency: 'USD', inputPerMillion: rule.inputPerMillion,
    outputPerMillion: rule.outputPerMillion, cachedPerMillion: rule.cachedPerMillion,
    reasoningPerMillion: rule.reasoningPerMillion
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
  validateRule(left)
  validateRule(right)
  if (!left.enabled || !right.enabled) return false
  if ((left.validUntil && left.validUntil <= right.validFrom) || (right.validUntil && right.validUntil <= left.validFrom)) return false
  const leftMinutes = weeklyMinutes(left)
  const rightMinutes = weeklyMinutes(right)
  return leftMinutes.some((active, index) => active && rightMinutes[index])
}
