import { describe, expect, it } from 'vitest'
import type { CostRule } from '../../apps/admin/src/types/catalog.js'
import {
  costRuleLifecycle, costStatusMeta, formatProcurementPrice, parseCostWorkspaceSelection
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
})
