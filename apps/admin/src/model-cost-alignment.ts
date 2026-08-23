import { formatCny } from './currency.js'

export interface EffectiveChannelCost {
  source: 'CHANNEL_COST_RULE' | 'PUBLIC_MODEL_FALLBACK'
  inputPerMillion: string
  outputPerMillion: string
  cachedPerMillion: string
  reasoningPerMillion: string
  currency: 'CNY'
}

export function effectiveChannelCost(cost: EffectiveChannelCost | null | undefined) {
  if (!cost) return { sourceLabel: '未配置成本', priceLabel: '—' }
  return {
    sourceLabel: cost.source === 'CHANNEL_COST_RULE' ? '渠道分时价格' : '公共模型兜底价',
    priceLabel: `输入 ${formatCny(cost.inputPerMillion)} / 输出 ${formatCny(cost.outputPerMillion)} / M`
  }
}

export function scheduledCostLabel(
  rule: { daysOfWeek: number[]; startMinute: number; endMinute: number },
  timezone: string
): string {
  const days = [...new Set(rule.daysOfWeek)].sort((left, right) => left - right)
  const dayLabel = days.length === 7 ? '每天'
    : days.join(',') === '1,2,3,4,5' ? '周一至周五'
      : days.join(',') === '6,7' ? '周末'
        : days.map(day => `周${'一二三四五六日'[day - 1] || day}`).join('、')
  const minuteLabel = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  const period = rule.startMinute === rule.endMinute
    ? '全天'
    : `${minuteLabel(rule.startMinute)}–${minuteLabel(rule.endMinute)}`
  return `${dayLabel} · ${period} · ${timezone}`
}
