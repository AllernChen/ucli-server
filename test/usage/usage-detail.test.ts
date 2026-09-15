import { BudgetEntryStatus, Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { projectBudgetEntry, projectRoute, projectUsage, safePrice } from '../../apps/api/src/usage-detail.js'

describe('safe request detail', () => {
  it('projects only whitelisted request historical prices without inventing route prices or current costs', () => {
    const snapshot = { inputPerMillion: '1', cachedPerMillion: '2', outputPerMillion: '3', reasoningPerMillion: '4', ruleName: '请求历史价格', internalSecret: 'DO_NOT_EXPOSE', request: { secretHash: 'DO_NOT_EXPOSE' } }
    const row = { costSnapshot: snapshot, costUsd: new Prisma.Decimal('1.5'), inputTokens: 1, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0,
      channel: { name: '渠道', inputPerMillion: '999' }, routes: [] } as any
    const result = projectUsage(row, 'SUCCESS', '1.5')
    expect(result).toMatchObject({ requestPrice: safePrice(snapshot), costCny: '1.50000000', routes: [] })
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EXPOSE|internalSecret|secretHash|999|costSnapshot/)
    for (const costSnapshot of [null, {}, { cost: snapshot }, { ...snapshot, inputPerMillion: 'NaN' }]) {
      expect(projectUsage({ ...row, costSnapshot }, 'SUCCESS', '1.5')).toHaveProperty('requestPrice', null)
    }
  })
  it('projects historical reservations separately from a settled current hold without internal snapshots', () => {
    const result = projectBudgetEntry({ status: BudgetEntryStatus.SETTLED, reservedCny: new Prisma.Decimal('4'),
      settledCny: new Prisma.Decimal('1'), reason: null, snapshot: { initialEstimateCny: '3', extensions: [{ amount: '1' }],
        request: { redis: { internalSecret: 'DO_NOT_EXPOSE' } } } })
    expect(result).toEqual({ status: 'SETTLED', initialEstimateCny: '3.00000000', extendedCny: '1.00000000',
      cumulativeReservedCny: '4.00000000', currentHeldCny: '0.00000000', settledCny: '1.00000000', manualFinal: false, reason: null })
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE')
  })
  it('keeps missing or invalid budget history unknown even after a hold shrinks the reservation', () => {
    const entry = { status: BudgetEntryStatus.RECONCILIATION_REQUIRED, reservedCny: new Prisma.Decimal('0.5'), settledCny: new Prisma.Decimal('1'), reason: 'pending',
      snapshot: { initialEstimateCny: '3', extensions: [{ amount: '1' }], manualFinal: true } }
    expect(projectBudgetEntry(entry)).toMatchObject({ cumulativeReservedCny: '4.00000000', currentHeldCny: '0.50000000', manualFinal: true })
    for (const snapshot of [{}, { initialEstimateCny: '3' }, { initialEstimateCny: '3', extensions: [{ amount: 'NaN' }] }]) {
      expect(projectBudgetEntry({ ...entry, snapshot })).toMatchObject({ cumulativeReservedCny: null, extendedCny: null })
    }
    expect(projectBudgetEntry({ ...entry, snapshot: { extensions: [] } })).toMatchObject({ initialEstimateCny: null, extendedCny: '0.00000000', cumulativeReservedCny: null })
  })
  it('projects route prices and formula deltas only from complete, safe historical evidence', () => {
    const cost = { id: 'rule', source: 'CHANNEL_COST_RULE', ruleName: '旧价格', inputPerMillion: '1', cachedPerMillion: '0.5', outputPerMillion: '2', reasoningPerMillion: '3', internalSecret: 'DO_NOT_EXPOSE' }
    const route = { attempt: 1, channelId: 'channel', channel: { name: 'A' }, costCny: new Prisma.Decimal('1'),
      usageSnapshot: { inputTokens: 100, cachedTokens: 20, outputTokens: 10, reasoningTokens: 5, cost, internalSecret: 'DO_NOT_EXPOSE' } } as any
    const result = projectRoute(route)
    expect(result).toMatchObject({ price: { ruleName: '旧价格' }, tokenUsageIncomplete: false, formulaCosts: { totalCost: '0.00011500', differenceCny: '0.99988500' } })
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE')
    for (const inputTokens of [undefined, '9007199254740993', -1, 1.5]) {
      expect(projectRoute({ ...route, usageSnapshot: { ...route.usageSnapshot, inputTokens } }).formulaCosts).toBeNull()
    }
    const huge = projectRoute({ ...route, usageSnapshot: { ...route.usageSnapshot, inputTokens: '9007199254740993' } })
    expect(huge.inputTokens).toBe('9007199254740993')
    const numericHuge = projectRoute({ ...route, usageSnapshot: { ...route.usageSnapshot, inputTokens: Number.MAX_SAFE_INTEGER + 1 } })
    expect(numericHuge).toMatchObject({ inputTokens: null, tokenUsageIncomplete: true, formulaCosts: null, costCny: '1.00000000' })
    expect(projectRoute({ ...route, usageSnapshot: { ...route.usageSnapshot, cost: { ...cost, inputPerMillion: 'NaN' } } }).formulaCosts).toBeNull()
    expect(projectRoute({ ...route, usageSnapshot: {} })).toMatchObject({ price: null, formulaCosts: null, tokenUsageIncomplete: true })
  })
})
