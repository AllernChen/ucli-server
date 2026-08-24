<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { api } from '../api'
import {
  buildWeeklyCostTimeline, costRulePayload, createCostRuleDraft, dateInTimezone, draftFromCostRule,
  type CostRuleDraft, type CostRuleTemplate
} from '../procurement-costs'
import type { CostRule, ProcurementFallbackCost } from '../types/catalog'

type CostRulePayload = ReturnType<typeof costRulePayload> & { id?: string }
const props = defineProps<{
  channelModelId: string
  timezone: string
  rules: CostRule[]
  fallback: ProcurementFallbackCost | null
  mode: 'CREATE' | 'EDIT' | 'DUPLICATE'
  rule?: CostRule | null
  busy?: boolean
}>()
const emit = defineEmits<{ save: [payload: CostRulePayload, keepOpen: boolean]; cancel: [] }>()
const templates: Array<{ id: CostRuleTemplate; label: string }> = [
  { id: 'BASE', label: '全天基础价' }, { id: 'WORKDAY_PEAK', label: '工作日高峰' },
  { id: 'DAILY_EVENING', label: '每日晚高峰' }, { id: 'WEEKEND', label: '周末价' }, { id: 'CUSTOM', label: '自定义' }
]
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const draft = reactive<CostRuleDraft>(createCostRuleDraft('BASE', dateInTimezone(new Date(), props.timezone)))
const previewing = ref(false)
const error = ref('')
const preview = ref<any>(null)

function reset() {
  const value = props.rule && props.mode !== 'CREATE'
    ? draftFromCostRule(props.rule, props.timezone)
    : createCostRuleDraft('BASE', dateInTimezone(new Date(), props.timezone))
  if (props.mode === 'DUPLICATE') value.name = `${value.name}（复制）`
  Object.assign(draft, value); error.value = ''; preview.value = null
}
watch(() => [props.rule?.id, props.mode, props.timezone], reset, { immediate: true })
function applyTemplate(template: CostRuleTemplate) {
  const next = createCostRuleDraft(template, draft.validFrom)
  Object.assign(next, {
    inputPerMillion: draft.inputPerMillion, outputPerMillion: draft.outputPerMillion,
    cachedPerMillion: draft.cachedPerMillion, reasoningPerMillion: draft.reasoningPerMillion,
    validUntil: draft.validUntil
  })
  Object.assign(draft, next); error.value = ''; preview.value = null
}
function toggleDay(day: number) {
  draft.daysOfWeek = draft.daysOfWeek.includes(day)
    ? draft.daysOfWeek.filter(value => value !== day)
    : [...draft.daysOfWeek, day].sort((left, right) => left - right)
}
const crossesMidnight = computed(() => !draft.allDay && draft.start > draft.end)
const coverage = computed(() => {
  try {
    const payload = costRulePayload(draft, props.timezone)
    const candidate: CostRule = {
      id: 'candidate', channelModelId: props.channelModelId, deletedAt: null, enabled: true, createdAt: new Date().toISOString(),
      currency: 'CNY', ...payload
    }
    const rules = [...props.rules.filter(rule => props.mode !== 'EDIT' || rule.id !== props.rule?.id), candidate]
    const slots = buildWeeklyCostTimeline(rules, props.fallback, new Date(payload.validFrom), props.timezone)
    const minutes = (kind: string) => slots.filter(slot => slot.kind === kind).length * 30
    return {
      channel: minutes('CHANNEL_BASE') + minutes('CHANNEL_OVERRIDE'), fallback: minutes('PUBLIC_FALLBACK'),
      uncovered: minutes('UNCOVERED')
    }
  } catch { return null }
})
function hours(value: number) { return `${(value / 60).toFixed(value % 60 ? 1 : 0)}h` }
async function submit(keepOpen: boolean) {
  error.value = ''; preview.value = null
  let payload: ReturnType<typeof costRulePayload>
  try { payload = costRulePayload(draft, props.timezone) } catch (value: any) { error.value = value.message; return }
  previewing.value = true
  try {
    const id = props.mode === 'EDIT' ? props.rule?.id : undefined
    const result = await api<any>(`/api/v1/admin/channel-models/${props.channelModelId}/cost-rules/preview`, {
      method: 'POST', body: JSON.stringify({ ...payload, ...(id ? { id } : {}) })
    })
    preview.value = result
    if (!result.valid) {
      error.value = `与同优先级规则冲突：${result.conflicts.map((item: any) => item.name).join('、')}`
      return
    }
    emit('save', { ...payload, ...(id ? { id } : {}) }, keepOpen)
  } catch (value: any) { error.value = value.message } finally { previewing.value = false }
}
</script>

<template>
  <form class="structured-cost-form" @submit.prevent="submit(false)">
    <section><header><b>1</b><div><h3>规则用途</h3><p>选择常用模板后仍可调整具体内容。</p></div></header><div class="cost-template-grid"><button v-for="item in templates" :key="item.id" type="button" :class="{ active: draft.template === item.id }" @click="applyTemplate(item.id)">{{ item.label }}</button></div><label>规则名称<input v-model="draft.name" maxlength="80" required></label></section>
    <section><header><b>2</b><div><h3>时间范围</h3><p>所有星期和时间均按 {{ timezone }} 解释。</p></div></header><div class="day-selector"><button v-for="day in 7" :key="day" type="button" :class="{ active: draft.daysOfWeek.includes(day) }" @click="toggleDay(day)">周{{ weekdays[day - 1] }}</button></div><label class="check-row"><input v-model="draft.allDay" type="checkbox"><span>全天生效</span></label><div v-if="!draft.allDay" class="form-row"><label>开始时间<input v-model="draft.start" type="time"></label><label>结束时间<input v-model="draft.end" type="time"></label></div><p v-if="crossesMidnight" class="form-hint">该规则跨午夜，结束时间属于次日。</p></section>
    <section><header><b>3</b><div><h3>采购单价</h3><p>固定单位：CNY / 1M Token。</p></div></header><div class="form-row"><label>输入单价<input v-model="draft.inputPerMillion" inputmode="decimal" placeholder="例如 3" required></label><label>输出单价<input v-model="draft.outputPerMillion" inputmode="decimal" placeholder="例如 6" required></label></div><details><summary>可选价格项</summary><div class="form-row"><label>缓存单价<input v-model="draft.cachedPerMillion" inputmode="decimal"></label><label>推理单价<input v-model="draft.reasoningPerMillion" inputmode="decimal"></label></div></details></section>
    <section><header><b>4</b><div><h3>生效周期</h3><p>日期从 {{ timezone }} 当日 00:00 开始。</p></div></header><div class="form-row"><label>生效日期<input v-model="draft.validFrom" type="date" required></label><label>失效日期（可选）<input v-model="draft.validUntil" type="date"></label></div><details><summary>高级优先级</summary><label>优先级<input v-model.number="draft.priority" type="number" min="0" max="1000" step="1"><small>基础价默认 0，分时覆盖价默认 10；数值越大越优先。</small></label></details></section>
    <section><header><b>5</b><div><h3>保存前预览</h3><p>服务端仍会执行最终冲突校验。</p></div></header><div v-if="coverage" class="draft-coverage"><span>渠道规则 {{ hours(coverage.channel) }}</span><span>公共兜底 {{ hours(coverage.fallback) }}</span><span :class="{ danger: coverage.uncovered }">成本缺口 {{ hours(coverage.uncovered) }}</span></div><p v-if="preview?.valid" class="state success-text">校验通过{{ preview.candidateActiveNow ? '，该规则当前可生效' : '' }}</p><p v-if="error" class="state error">{{ error }}</p></section>
    <div class="structured-cost-actions"><button type="button" @click="emit('cancel')">取消</button><button v-if="mode !== 'EDIT'" type="button" :disabled="previewing || busy" @click="submit(true)">保存并继续新建</button><button class="primary" :disabled="previewing || busy">{{ busy ? '保存中…' : previewing ? '校验中…' : mode === 'EDIT' ? '保存修改' : '保存规则' }}</button></div>
  </form>
</template>
