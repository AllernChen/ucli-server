import { describe, expect, it } from 'vitest'
import {
  costRulesOverlap,
  highestReservationCost,
  nextCostTransition,
  resolveChannelCost,
  resolveChannelCostWithFallback,
  type ScheduledCost
} from '../../packages/gateway-core/src/cost-schedule.js'
import { estimateProcurementCost } from '../../packages/gateway-core/src/cost.js'

const base: ScheduledCost = {
  id: 'base', priority: 0, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 0,
  validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: null, createdAt: new Date('2026-01-01T00:00:00Z'),
  enabled: true, currency: 'CNY', inputPerMillion: '1', outputPerMillion: '2',
  cachedPerMillion: '0.2', reasoningPerMillion: '3'
}

describe('channel model cost schedules', () => {
  it('accepts CNY procurement costs and rejects USD schedules', () => {
    const usd = { ...base, currency: 'USD' }

    expect(resolveChannelCost([base], new Date('2026-08-20T00:00:00Z'), 'UTC')).toMatchObject({ currency: 'CNY' })
    expect(() => resolveChannelCost([usd], new Date('2026-08-20T00:00:00Z'), 'UTC'))
      .toThrow('CNY')
  })

  it('uses the higher-priority peak cost in the channel timezone', () => {
    const peak: ScheduledCost = {
      ...base, id: 'peak', priority: 10, daysOfWeek: [1, 2, 3, 4, 5], startMinute: 20 * 60,
      endMinute: 23 * 60, inputPerMillion: '1.5', outputPerMillion: '3'
    }

    expect(resolveChannelCost([base, peak], new Date('2026-08-20T12:30:00Z'), 'Asia/Shanghai')?.id).toBe('peak')
    expect(resolveChannelCost([base, peak], new Date('2026-08-20T15:30:00Z'), 'Asia/Shanghai')?.id).toBe('base')
  })

  it('treats a cross-midnight rule weekday as the day on which the window starts', () => {
    const fridayNight: ScheduledCost = {
      ...base, id: 'night', priority: 10, daysOfWeek: [5], startMinute: 23 * 60, endMinute: 2 * 60
    }

    expect(resolveChannelCost([base, fridayNight], new Date('2026-08-21T15:30:00Z'), 'Asia/Shanghai')?.id).toBe('night')
    expect(resolveChannelCost([base, fridayNight], new Date('2026-08-21T17:30:00Z'), 'Asia/Shanghai')?.id).toBe('night')
    expect(resolveChannelCost([base, fridayNight], new Date('2026-08-22T17:30:00Z'), 'Asia/Shanghai')?.id).toBe('base')
  })

  it('treats equal start and end minutes as an all-day rule', () => {
    const thursday: ScheduledCost = { ...base, id: 'thursday', priority: 5, daysOfWeek: [4], startMinute: 480, endMinute: 480 }
    expect(resolveChannelCost([base, thursday], new Date('2026-08-20T03:00:00Z'), 'Asia/Shanghai')?.id).toBe('thursday')
  })

  it('ignores disabled and expired rules and uses newest validFrom to break a priority tie', () => {
    const oldRule: ScheduledCost = { ...base, id: 'old', priority: 5 }
    const newest: ScheduledCost = { ...oldRule, id: 'new', validFrom: new Date('2026-08-01T00:00:00Z') }
    const expired: ScheduledCost = { ...newest, id: 'expired', validUntil: new Date('2026-08-10T00:00:00Z') }
    const disabled: ScheduledCost = { ...newest, id: 'disabled', enabled: false }

    expect(resolveChannelCost([oldRule, newest, expired, disabled], new Date('2026-08-20T00:00:00Z'), 'UTC')?.id).toBe('new')
  })

  it('rejects invalid timezone and negative procurement costs', () => {
    expect(() => resolveChannelCost([base], new Date('2026-08-20T00:00:00Z'), 'Mars/Olympus')).toThrow('Invalid IANA timezone')
    expect(() => resolveChannelCost([{ ...base, inputPerMillion: '-1' }], new Date('2026-08-20T00:00:00Z'), 'UTC'))
      .toThrow('Cost values must be non-negative CNY amounts')
  })

  it('builds a conservative reservation snapshot from the maximum of every token category', () => {
    expect(highestReservationCost([
      { inputPerMillion: '2', outputPerMillion: '4', cachedPerMillion: '0.1', reasoningPerMillion: '8' },
      { inputPerMillion: '3', outputPerMillion: '1', cachedPerMillion: '0.5', reasoningPerMillion: '2' }
    ])).toEqual({ inputPerMillion: '3', outputPerMillion: '4', cachedPerMillion: '0.5', reasoningPerMillion: '8' })
    expect(highestReservationCost([])).toBeNull()
  })

  it('detects date, weekday and minute overlap including cross-midnight windows', () => {
    const peak = { ...base, daysOfWeek: [5], startMinute: 20 * 60, endMinute: 23 * 60 }
    const overlaps = { ...base, daysOfWeek: [5], startMinute: 22 * 60, endMinute: 60 }
    const saturday = { ...base, daysOfWeek: [6], startMinute: 10 * 60, endMinute: 11 * 60 }
    expect(costRulesOverlap(peak, overlaps)).toBe(true)
    expect(costRulesOverlap(peak, saturday)).toBe(false)
  })

  it('does not report a conflict when validity date ranges do not overlap', () => {
    const historical = { ...base, validUntil: new Date('2026-07-01T00:00:00Z') }
    const future = { ...base, validFrom: new Date('2026-08-01T00:00:00Z') }
    expect(costRulesOverlap(historical, future)).toBe(false)
  })

  it('falls back to the public model price only when no channel rule matches', () => {
    const fallback = {
      id: 'public-price', currency: 'CNY' as const, inputPerMillion: '0.8', outputPerMillion: '1.6',
      cachedPerMillion: '0.08', reasoningPerMillion: '1.6'
    }
    const future = { ...base, validFrom: new Date('2026-09-01T00:00:00Z') }

    expect(resolveChannelCostWithFallback([base], fallback, new Date('2026-08-24T00:00:00Z'), 'UTC'))
      .toMatchObject({ id: 'base', source: 'CHANNEL_COST_RULE' })
    expect(resolveChannelCostWithFallback([future], fallback, new Date('2026-08-24T00:00:00Z'), 'UTC'))
      .toMatchObject({ id: 'public-price', source: 'PUBLIC_MODEL_FALLBACK', currency: 'CNY' })
    expect(resolveChannelCostWithFallback([future], null, new Date('2026-08-24T00:00:00Z'), 'UTC')).toBeNull()
  })

  it('finds the next instant at which the effective rule changes', () => {
    const peak: ScheduledCost = {
      ...base, id: 'evening-peak', name: '工作日晚高峰', priority: 10, daysOfWeek: [1, 2, 3, 4, 5],
      startMinute: 18 * 60, endMinute: 23 * 60, inputPerMillion: '1.5', outputPerMillion: '3'
    }

    expect(nextCostTransition([base, peak], null, new Date('2026-08-24T09:59:00Z'), 'Asia/Shanghai'))
      .toEqual({ at: '2026-08-24T10:00:00.000Z', cost: expect.objectContaining({ id: 'evening-peak' }) })
  })

  it('honors exact validity boundaries when finding the next transition', () => {
    const expiring = { ...base, id: 'expiring', priority: 10, validUntil: new Date('2026-08-24T10:00:30Z') }

    expect(nextCostTransition([base, expiring], null, new Date('2026-08-24T10:00:00Z'), 'UTC'))
      .toEqual({ at: '2026-08-24T10:00:30.000Z', cost: expect.objectContaining({ id: 'base' }) })
  })

  it('calculates an auditable four-part CNY estimate without double charging included token totals', () => {
    expect(estimateProcurementCost(
      { inputPerMillion: '2', outputPerMillion: '4', cachedPerMillion: '0.5', reasoningPerMillion: '8' },
      { inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 200_000, reasoningTokens: 100_000 }
    )).toEqual({
      inputCost: '1.60000000', outputCost: '1.60000000', cachedCost: '0.10000000',
      reasoningCost: '0.80000000', totalCost: '4.10000000', currency: 'CNY'
    })
  })
})
