import { describe, expect, it } from 'vitest'
import type { CostRule } from '../../apps/admin/src/types/catalog.js'
import {
  buildWeeklyCostTimeline, costRuleLifecycle, costRulePayload, costStatusMeta, createCostRuleDraft,
  formatProcurementPrice, parseCostWorkspaceSelection
} from '../../apps/admin/src/procurement-costs.js'

const now = new Date('2026-08-24T10:00:00.000Z')

function rule(overrides: Partial<CostRule> = {}): CostRule {
  return {
    id: 'rule-1', deletedAt: null, channelModelId: 'model-1', name: '基础价', daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    startMinute: 0, endMinute: 0, priority: 0, inputPerMillion: '1', outputPerMillion: '2',
    cachedPerMillion: '0.1', reasoningPerMillion: '2', currency: 'CNY', enabled: true,
    validFrom: '2026-01-01T00:00:00.000Z', validUntil: null, createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('procurement cost workspace presentation', () => {
  it.each([
    ['CHANNEL_RULE_ACTIVE', '渠道规则生效中', 'success'],
    ['PARTIAL_FALLBACK', '部分时段使用公共兜底', 'warning'],
    ['FALLBACK_ONLY', '仅使用公共兜底', 'neutral'],
    ['NO_COST', '存在无成本时段', 'danger'],
    ['UPCOMING', '成本规则即将生效', 'info'],
    ['DISABLED', '渠道模型已停用', 'muted']
  ] as const)('maps %s to an operator-friendly status', (status, label, tone) => {
    expect(costStatusMeta(status)).toMatchObject({ label, tone })
  })

  it('derives current, upcoming, expired, disabled and archived rule lifecycle in precedence order', () => {
    expect(costRuleLifecycle(rule(), now)).toEqual({ code: 'CURRENT', label: '当前有效' })
    expect(costRuleLifecycle(rule({ validFrom: '2026-09-01T00:00:00.000Z' }), now)).toEqual({ code: 'UPCOMING', label: '未来生效' })
    expect(costRuleLifecycle(rule({ validUntil: '2026-08-24T10:00:00.000Z' }), now)).toEqual({ code: 'EXPIRED', label: '已过期' })
    expect(costRuleLifecycle(rule({ enabled: false }), now)).toEqual({ code: 'DISABLED', label: '已停用' })
    expect(costRuleLifecycle(rule({ enabled: false, deletedAt: '2026-08-24T00:00:00.000Z' }), now))
      .toEqual({ code: 'ARCHIVED', label: '已归档' })
  })

  it('normalizes route query values into one cost-workspace selection', () => {
    expect(parseCostWorkspaceSelection({
      channelId: ['channel-1', 'ignored'], channelModelId: 'ability-1', publicModelId: undefined
    })).toEqual({ channelId: 'channel-1', channelModelId: 'ability-1', publicModelId: '' })
  })

  it('formats the effective procurement price in RMB per million tokens', () => {
    expect(formatProcurementPrice({ inputPerMillion: '3', outputPerMillion: '6' }))
      .toBe('输入 ¥3 / 输出 ¥6 / 1M Token')
    expect(formatProcurementPrice(null)).toBe('未配置采购成本')
  })

  it('maps a higher-priority peak rule over the base rule at 30-minute visual granularity', () => {
    const slots = buildWeeklyCostTimeline([
      rule({ id: 'base', name: '基础价' }),
      rule({ id: 'peak', name: '晚高峰', priority: 10, daysOfWeek: [1], startMinute: 1080, endMinute: 1380 })
    ], null, now, 'UTC')

    expect(slots.find(slot => slot.weekday === 1 && slot.startMinute === 17 * 60 + 30)).toMatchObject({ kind: 'CHANNEL_BASE', ruleId: 'base' })
    expect(slots.find(slot => slot.weekday === 1 && slot.startMinute === 18 * 60)).toMatchObject({ kind: 'CHANNEL_OVERRIDE', ruleId: 'peak' })
  })

  it('carries a cross-midnight Friday rule into early Saturday', () => {
    const slots = buildWeeklyCostTimeline([
      rule({ id: 'night', priority: 10, daysOfWeek: [5], startMinute: 1380, endMinute: 120 })
    ], null, now, 'UTC')

    expect(slots.find(slot => slot.weekday === 5 && slot.startMinute === 23 * 60)).toMatchObject({ ruleId: 'night' })
    expect(slots.find(slot => slot.weekday === 6 && slot.startMinute === 90)).toMatchObject({ ruleId: 'night' })
    expect(slots.find(slot => slot.weekday === 6 && slot.startMinute === 120)).toMatchObject({ kind: 'UNCOVERED' })
  })

  it('marks public fallback, uncovered and the selected channel-timezone slot explicitly', () => {
    const fallback = { id: 'fallback', currency: 'CNY' as const, inputPerMillion: '3', outputPerMillion: '6', cachedPerMillion: '0', reasoningPerMillion: '6' }
    const fallbackSlots = buildWeeklyCostTimeline([], fallback, new Date('2026-08-24T10:15:00Z'), 'UTC')
    const emptySlots = buildWeeklyCostTimeline([], null, now, 'UTC')

    expect(fallbackSlots).toHaveLength(336)
    expect(fallbackSlots.find(slot => slot.weekday === 1 && slot.startMinute === 600))
      .toMatchObject({ kind: 'PUBLIC_FALLBACK', selected: true, ruleId: 'fallback' })
    expect(emptySlots[0]).toMatchObject({ kind: 'UNCOVERED', ruleId: null })
  })

  it.each([
    ['BASE', '全天基础价', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 0],
    ['WORKDAY_PEAK', '工作日高峰价', [1, 2, 3, 4, 5], '18:00', '23:00', 10],
    ['DAILY_EVENING', '每日晚高峰价', [1, 2, 3, 4, 5, 6, 7], '18:00', '23:00', 10],
    ['WEEKEND', '周末价', [6, 7], '00:00', '00:00', 10]
  ] as const)('creates safe defaults for the %s template', (template, name, daysOfWeek, start, end, priority) => {
    expect(createCostRuleDraft(template, '2026-08-24')).toMatchObject({
      template, name, daysOfWeek, start, end, priority, inputPerMillion: '', outputPerMillion: '',
      cachedPerMillion: '0', reasoningPerMillion: '0', validFrom: '2026-08-24'
    })
  })

  it('serializes an all-day rule at channel-local midnight with optional prices and an explicit open end', () => {
    const draft = createCostRuleDraft('BASE', '2026-08-24')
    Object.assign(draft, { inputPerMillion: '3', outputPerMillion: '6', cachedPerMillion: '', reasoningPerMillion: '' })

    expect(costRulePayload(draft, 'Asia/Shanghai')).toEqual({
      name: '全天基础价', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 0, priority: 0,
      inputPerMillion: '3', outputPerMillion: '6', cachedPerMillion: '0', reasoningPerMillion: '0',
      validFrom: '2026-08-23T16:00:00.000Z', validUntil: null
    })
  })

  it('rejects incomplete rule drafts before calling the preview endpoint', () => {
    expect(() => costRulePayload(createCostRuleDraft('CUSTOM', '2026-08-24'), 'UTC'))
      .toThrow('请至少选择一个生效日')
  })

  it('does not silently turn an equal-time custom window into an all-day rule', () => {
    const draft = createCostRuleDraft('CUSTOM', '2026-08-24')
    Object.assign(draft, {
      daysOfWeek: [1], start: '09:00', end: '09:00', inputPerMillion: '1', outputPerMillion: '2'
    })

    expect(() => costRulePayload(draft, 'UTC')).toThrow('全天规则请开启“全天”')
  })
})
