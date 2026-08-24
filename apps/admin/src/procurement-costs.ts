import { formatCny } from './currency.js'
import type { CostRule, ProcurementCostStatus, ResolvedProcurementCost } from './types/catalog.js'

const STATUS_META: Record<ProcurementCostStatus, { label: string; tone: string; description: string }> = {
  CHANNEL_RULE_ACTIVE: { label: '渠道规则生效中', tone: 'success', description: '渠道规则已覆盖全部时段' },
  PARTIAL_FALLBACK: { label: '部分时段使用公共兜底', tone: 'warning', description: '未覆盖时段使用公共模型价格' },
  FALLBACK_ONLY: { label: '仅使用公共兜底', tone: 'neutral', description: '尚未配置渠道采购成本规则' },
  NO_COST: { label: '存在无成本时段', tone: 'danger', description: '部分或全部时段没有可用采购成本' },
  UPCOMING: { label: '成本规则即将生效', tone: 'info', description: '当前无渠道规则，已有未来规则' },
  DISABLED: { label: '渠道模型已停用', tone: 'muted', description: '停用状态不参与模型路由' }
}

export function costStatusMeta(status: ProcurementCostStatus) { return STATUS_META[status] }

export function costRuleLifecycle(rule: CostRule, at = new Date()) {
  if (rule.deletedAt) return { code: 'ARCHIVED' as const, label: '已归档' }
  if (!rule.enabled) return { code: 'DISABLED' as const, label: '已停用' }
  if (new Date(rule.validFrom) > at) return { code: 'UPCOMING' as const, label: '未来生效' }
  if (rule.validUntil && new Date(rule.validUntil) <= at) return { code: 'EXPIRED' as const, label: '已过期' }
  return { code: 'CURRENT' as const, label: '当前有效' }
}

function firstQueryValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? String(value[0] ?? '') : ''
  return typeof value === 'string' ? value : ''
}

export function parseCostWorkspaceSelection(query: Record<string, unknown>) {
  return {
    channelId: firstQueryValue(query.channelId),
    channelModelId: firstQueryValue(query.channelModelId),
    publicModelId: firstQueryValue(query.publicModelId)
  }
}

export function formatProcurementPrice(cost: Pick<ResolvedProcurementCost, 'inputPerMillion' | 'outputPerMillion'> | null | undefined) {
  if (!cost) return '未配置采购成本'
  return `输入 ${formatCny(cost.inputPerMillion)} / 输出 ${formatCny(cost.outputPerMillion)} / 1M Token`
}

export function effectiveCostSource(cost: ResolvedProcurementCost | null | undefined) {
  if (!cost) return '无可用成本'
  return cost.source === 'CHANNEL_COST_RULE' ? cost.ruleName || '渠道成本规则' : '公共模型兜底价'
}
