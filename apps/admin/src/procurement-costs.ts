import { formatCny } from './currency.js'
import type {
  CostRule, ProcurementCostStatus, ProcurementFallbackCost, ResolvedProcurementCost
} from './types/catalog.js'

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

export function procurementCostRoute(selection: { channelId?: string; channelModelId?: string; publicModelId?: string }) {
  const query: Record<string, string> = {}
  if (selection.channelId) query.channelId = selection.channelId
  if (selection.channelModelId) query.channelModelId = selection.channelModelId
  if (selection.publicModelId) query.publicModelId = selection.publicModelId
  return { path: '/procurement-costs', query }
}

export function formatProcurementPrice(cost: Pick<ResolvedProcurementCost, 'inputPerMillion' | 'outputPerMillion'> | null | undefined) {
  if (!cost) return '未配置采购成本'
  return `输入 ${formatCny(cost.inputPerMillion)} / 输出 ${formatCny(cost.outputPerMillion)} / 1M Token`
}

export function effectiveCostSource(cost: ResolvedProcurementCost | null | undefined) {
  if (!cost) return '无可用成本'
  return cost.source === 'CHANNEL_COST_RULE' ? cost.ruleName || '渠道成本规则' : '公共模型兜底价'
}

export type CostTimelineKind = 'CHANNEL_BASE' | 'CHANNEL_OVERRIDE' | 'PUBLIC_FALLBACK' | 'UNCOVERED'

export interface CostTimelineSlot {
  weekday: number
  startMinute: number
  endMinute: number
  kind: CostTimelineKind
  ruleId: string | null
  label: string
  selected: boolean
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

function selectedLocalSlot(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || ''
  const minute = Number(value('hour')) * 60 + Number(value('minute'))
  return { weekday: WEEKDAYS[value('weekday')], startMinute: Math.floor(minute / 30) * 30 }
}

function coversSlot(rule: CostRule, weekday: number, minute: number) {
  if (rule.startMinute === rule.endMinute) return rule.daysOfWeek.includes(weekday)
  if (rule.startMinute < rule.endMinute) {
    return rule.daysOfWeek.includes(weekday) && minute >= rule.startMinute && minute < rule.endMinute
  }
  const previous = weekday === 1 ? 7 : weekday - 1
  return (rule.daysOfWeek.includes(weekday) && minute >= rule.startMinute) ||
    (rule.daysOfWeek.includes(previous) && minute < rule.endMinute)
}

export function buildWeeklyCostTimeline(
  rules: CostRule[], fallback: ProcurementFallbackCost | null, selectedAt: Date, timezone: string
): CostTimelineSlot[] {
  const active = rules.filter(rule => costRuleLifecycle(rule, selectedAt).code === 'CURRENT')
    .sort((left, right) => right.priority - left.priority || new Date(right.validFrom).getTime() - new Date(left.validFrom).getTime() ||
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime() || left.id.localeCompare(right.id))
  const selected = selectedLocalSlot(selectedAt, timezone)
  const slots: CostTimelineSlot[] = []
  for (let weekday = 1; weekday <= 7; weekday++) {
    for (let startMinute = 0; startMinute < 1440; startMinute += 30) {
      const winner = active.find(rule => coversSlot(rule, weekday, startMinute))
      slots.push({
        weekday, startMinute, endMinute: startMinute + 30,
        kind: winner ? (winner.priority > 0 ? 'CHANNEL_OVERRIDE' : 'CHANNEL_BASE') : fallback ? 'PUBLIC_FALLBACK' : 'UNCOVERED',
        ruleId: winner?.id || fallback?.id || null,
        label: winner?.name || (fallback ? '公共模型兜底价' : '无可用成本'),
        selected: selected.weekday === weekday && selected.startMinute === startMinute
      })
    }
  }
  return slots
}

export type CostRuleTemplate = 'BASE' | 'WORKDAY_PEAK' | 'DAILY_EVENING' | 'WEEKEND' | 'CUSTOM'

export interface CostRuleDraft {
  template: CostRuleTemplate
  name: string
  daysOfWeek: number[]
  allDay: boolean
  start: string
  end: string
  priority: number
  inputPerMillion: string
  outputPerMillion: string
  cachedPerMillion: string
  reasoningPerMillion: string
  validFrom: string
  validUntil: string
}

const RULE_TEMPLATES: Record<CostRuleTemplate, Pick<CostRuleDraft, 'name' | 'daysOfWeek' | 'allDay' | 'start' | 'end' | 'priority'>> = {
  BASE: { name: '全天基础价', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], allDay: true, start: '00:00', end: '00:00', priority: 0 },
  WORKDAY_PEAK: { name: '工作日高峰价', daysOfWeek: [1, 2, 3, 4, 5], allDay: false, start: '18:00', end: '23:00', priority: 10 },
  DAILY_EVENING: { name: '每日晚高峰价', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], allDay: false, start: '18:00', end: '23:00', priority: 10 },
  WEEKEND: { name: '周末价', daysOfWeek: [6, 7], allDay: true, start: '00:00', end: '00:00', priority: 10 },
  CUSTOM: { name: '自定义成本规则', daysOfWeek: [], allDay: false, start: '09:00', end: '18:00', priority: 10 }
}

export function createCostRuleDraft(template: CostRuleTemplate, validFrom: string): CostRuleDraft {
  const preset = RULE_TEMPLATES[template]
  return {
    template, ...preset, daysOfWeek: [...preset.daysOfWeek], inputPerMillion: '', outputPerMillion: '',
    cachedPerMillion: '0', reasoningPerMillion: '0', validFrom, validUntil: ''
  }
}

function dateParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23'
  }).formatToParts(at)
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') }
}

export function dateInTimezone(at: Date, timezone: string) {
  const parts = dateParts(at, timezone)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function zonedMidnight(date: string, timezone: string) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!matched) throw new Error('请选择有效的生效日期')
  const desired = Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
  let candidate = desired
  for (let attempt = 0; attempt < 3; attempt++) {
    const local = dateParts(new Date(candidate), timezone)
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
    candidate = desired - (represented - candidate)
  }
  const result = new Date(candidate)
  const local = dateParts(result, timezone)
  if (`${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}` !== date || local.hour !== 0 || local.minute !== 0) {
    throw new Error('该时区日期无法换算为有效时间')
  }
  return result
}

function minute(value: string) {
  const matched = /^(\d{2}):(\d{2})$/.exec(value)
  if (!matched) throw new Error('请选择有效的起止时间')
  const result = Number(matched[1]) * 60 + Number(matched[2])
  if (result < 0 || result > 1439) throw new Error('请选择有效的起止时间')
  return result
}

const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

export function costRulePayload(draft: CostRuleDraft, timezone: string) {
  if (!draft.daysOfWeek.length) throw new Error('请至少选择一个生效日')
  if (!draft.name.trim()) throw new Error('请填写规则名称')
  if (!NON_NEGATIVE_DECIMAL.test(draft.inputPerMillion) || !NON_NEGATIVE_DECIMAL.test(draft.outputPerMillion)) {
    throw new Error('请填写有效的输入和输出采购单价')
  }
  const cached = draft.cachedPerMillion || '0'
  const reasoning = draft.reasoningPerMillion || '0'
  if (!NON_NEGATIVE_DECIMAL.test(cached) || !NON_NEGATIVE_DECIMAL.test(reasoning)) throw new Error('可选采购单价不能为负数')
  const validFrom = zonedMidnight(draft.validFrom, timezone)
  const validUntil = draft.validUntil ? zonedMidnight(draft.validUntil, timezone) : null
  if (validUntil && validUntil <= validFrom) throw new Error('失效日期必须晚于生效日期')
  const startMinute = draft.allDay ? 0 : minute(draft.start)
  const endMinute = draft.allDay ? 0 : minute(draft.end)
  if (!draft.allDay && startMinute === endMinute) throw new Error('全天规则请开启“全天”')
  return {
    name: draft.name.trim(), daysOfWeek: [...draft.daysOfWeek].sort((left, right) => left - right),
    startMinute, endMinute,
    priority: Number(draft.priority), inputPerMillion: draft.inputPerMillion, outputPerMillion: draft.outputPerMillion,
    cachedPerMillion: cached, reasoningPerMillion: reasoning,
    validFrom: validFrom.toISOString(), validUntil: validUntil?.toISOString() || null
  }
}

export function draftFromCostRule(rule: CostRule, timezone: string): CostRuleDraft {
  return {
    template: 'CUSTOM', name: rule.name, daysOfWeek: [...rule.daysOfWeek], allDay: rule.startMinute === rule.endMinute,
    start: `${String(Math.floor(rule.startMinute / 60)).padStart(2, '0')}:${String(rule.startMinute % 60).padStart(2, '0')}`,
    end: `${String(Math.floor(rule.endMinute / 60)).padStart(2, '0')}:${String(rule.endMinute % 60).padStart(2, '0')}`,
    priority: rule.priority, inputPerMillion: rule.inputPerMillion, outputPerMillion: rule.outputPerMillion,
    cachedPerMillion: rule.cachedPerMillion, reasoningPerMillion: rule.reasoningPerMillion,
    validFrom: dateInTimezone(new Date(rule.validFrom), timezone),
    validUntil: rule.validUntil ? dateInTimezone(new Date(rule.validUntil), timezone) : ''
  }
}
