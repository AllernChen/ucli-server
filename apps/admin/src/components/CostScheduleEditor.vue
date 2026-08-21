<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { api } from '../api'
import type { CostRule } from '../types/catalog'

interface CostRuleInput {
  name: string
  daysOfWeek: number[]
  startMinute: number
  endMinute: number
  priority: number
  inputPerMillion: string
  outputPerMillion: string
  cachedPerMillion: string
  reasoningPerMillion: string
  validFrom: string
  validUntil?: string
}

const props = defineProps<{ modelId: string; rules: CostRule[]; timezone: string; busy?: boolean }>()
const emit = defineEmits<{ save: [rule: CostRuleInput & { id?: string }]; remove: [id: string]; toggle: [id: string, enabled: boolean] }>()
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const form = reactive({
  name: '基础成本', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '00:00', priority: 0,
  inputPerMillion: '', outputPerMillion: '', cachedPerMillion: '0', reasoningPerMillion: '0',
  validFrom: new Date().toISOString().slice(0, 10), validUntil: ''
})
const editingId = ref(''); const validationError = ref(''); const previewing = ref(false); const conflictIds = ref<string[]>([])

const previewAt = computed(() => new Date(`${form.validFrom}T12:00:00Z`))
const activeRules = computed(() => props.rules.filter(rule => rule.enabled && rule.id !== editingId.value &&
  new Date(rule.validFrom) <= previewAt.value && (!rule.validUntil || new Date(rule.validUntil) > previewAt.value)))
const draftRule = computed(() => form.daysOfWeek.length && form.inputPerMillion !== '' && form.outputPerMillion !== '' ? {
  id: 'draft', channelModelId: props.modelId, name: form.name || '待保存规则', daysOfWeek: form.daysOfWeek,
  startMinute: minute(form.start), endMinute: minute(form.end), priority: Number(form.priority),
  inputPerMillion: form.inputPerMillion, outputPerMillion: form.outputPerMillion,
  cachedPerMillion: form.cachedPerMillion || '0', reasoningPerMillion: form.reasoningPerMillion || '0',
  currency: 'USD' as const, enabled: true, validFrom: `${form.validFrom}T00:00:00.000Z`,
  validUntil: form.validUntil ? `${form.validUntil}T00:00:00.000Z` : null, createdAt: new Date().toISOString()
} : null)
function minute(value: string) { const [hour, minutes] = value.split(':').map(Number); return hour * 60 + minutes }
function toggleDay(day: number) {
  form.daysOfWeek = form.daysOfWeek.includes(day) ? form.daysOfWeek.filter(value => value !== day) : [...form.daysOfWeek, day].sort()
}
function payload(): CostRuleInput {
  return {
    name: form.name, daysOfWeek: form.daysOfWeek, startMinute: minute(form.start), endMinute: minute(form.end),
    priority: Number(form.priority), inputPerMillion: form.inputPerMillion, outputPerMillion: form.outputPerMillion,
    cachedPerMillion: form.cachedPerMillion || '0', reasoningPerMillion: form.reasoningPerMillion || '0',
    validFrom: new Date(`${form.validFrom}T00:00:00Z`).toISOString(),
    ...(form.validUntil ? { validUntil: new Date(`${form.validUntil}T00:00:00Z`).toISOString() } : {})
  }
}
async function submit() {
  if (!form.daysOfWeek.length || form.inputPerMillion === '' || form.outputPerMillion === '') return
  previewing.value = true; validationError.value = ''; conflictIds.value = []
  try {
    const rule = payload()
    const preview = await api<any>(`/api/v1/admin/channel-models/${props.modelId}/cost-rules/preview`, {
      method: 'POST', body: JSON.stringify({ ...rule, ...(editingId.value ? { id: editingId.value } : {}) })
    })
    if (!preview.valid) {
      conflictIds.value = preview.conflicts.map((item: any) => item.id)
      validationError.value = `与同优先级规则冲突：${preview.conflicts.map((item: any) => item.name).join('、')}`
      return
    }
    emit('save', { ...rule, ...(editingId.value ? { id: editingId.value } : {}) })
  } catch (error: any) { validationError.value = error.message } finally { previewing.value = false }
}
function edit(rule: CostRule) {
  editingId.value = rule.id; validationError.value = ''; conflictIds.value = []
  Object.assign(form, {
    name: rule.name, daysOfWeek: [...rule.daysOfWeek], start: clock(rule.startMinute), end: clock(rule.endMinute),
    priority: rule.priority, inputPerMillion: rule.inputPerMillion, outputPerMillion: rule.outputPerMillion,
    cachedPerMillion: rule.cachedPerMillion, reasoningPerMillion: rule.reasoningPerMillion,
    validFrom: rule.validFrom.slice(0, 10), validUntil: rule.validUntil?.slice(0, 10) || ''
  })
}
function resetForm() {
  editingId.value = ''; validationError.value = ''; conflictIds.value = []
  Object.assign(form, { name: '基础成本', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '00:00',
    priority: 0, inputPerMillion: '', outputPerMillion: '', cachedPerMillion: '0', reasoningPerMillion: '0',
    validFrom: new Date().toISOString().slice(0, 10), validUntil: '' })
}
function covers(rule: CostRule, day: number, hour: number) {
  const current = hour * 60
  if (rule.startMinute === rule.endMinute) return rule.daysOfWeek.includes(day)
  if (rule.startMinute < rule.endMinute) return rule.daysOfWeek.includes(day) && current >= rule.startMinute && current < rule.endMinute
  const previous = day === 1 ? 7 : day - 1
  return (rule.daysOfWeek.includes(day) && current >= rule.startMinute) || (rule.daysOfWeek.includes(previous) && current < rule.endMinute)
}
function ruleAt(day: number, hour: number) {
  return [...activeRules.value, ...(draftRule.value ? [draftRule.value] : [])]
    .filter(rule => covers(rule, day, hour)).sort((a, b) => b.priority - a.priority)[0]
}
function hasConflict(day: number, hour: number) {
  return Boolean(draftRule.value && covers(draftRule.value, day, hour) && activeRules.value.some(rule =>
    conflictIds.value.includes(rule.id) && rule.priority === draftRule.value!.priority && covers(rule, day, hour)))
}
function clock(value: number) { return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` }
</script>

<template>
  <div class="cost-editor">
    <p class="muted">时区：{{ timezone }}。周视图按 {{ form.validFrom }} 的有效规则预览；相同优先级冲突会在保存前校验。</p>
    <div class="schedule-grid">
      <div></div><small v-for="hour in 24" :key="hour">{{ hour - 1 }}</small>
      <template v-for="day in 7" :key="day"><strong>周{{ weekdays[day - 1] }}</strong>
        <span v-for="hour in 24" :key="hour" :class="{ covered: ruleAt(day, hour - 1), peak: (ruleAt(day, hour - 1)?.priority || 0) > 0, conflict: hasConflict(day, hour - 1) }" :title="hasConflict(day, hour - 1) ? '同优先级冲突' : ruleAt(day, hour - 1)?.name || '未配置'"></span>
      </template>
    </div>
    <div v-if="rules.length" class="rule-list">
      <article v-for="rule in rules" :key="rule.id" :class="{ muted: !rule.enabled }"><div><strong>{{ rule.name }}{{ rule.enabled ? '' : ' · 已停用' }}</strong><small>优先级 {{ rule.priority }} · {{ clock(rule.startMinute) }}–{{ clock(rule.endMinute) }} · in ${{ rule.inputPerMillion }} / out ${{ rule.outputPerMillion }}</small></div>
        <div class="actions"><button @click="edit(rule)">编辑</button><button @click="emit('toggle', rule.id, !rule.enabled)">{{ rule.enabled ? '停用' : '启用' }}</button><button class="danger-link" @click="emit('remove', rule.id)">删除</button></div></article>
    </div>
    <section class="sub-panel"><h3>{{ editingId ? '编辑成本规则' : '新增成本规则' }}</h3>
      <div class="day-selector"><button v-for="day in 7" :key="day" :class="{ active: form.daysOfWeek.includes(day) }" @click="toggleDay(day)">周{{ weekdays[day - 1] }}</button></div>
      <div class="form-row"><input v-model="form.name" placeholder="规则名称"><input v-model="form.start" type="time"><input v-model="form.end" type="time"><input v-model.number="form.priority" type="number" min="0" placeholder="优先级"></div>
      <div class="form-row"><input v-model="form.inputPerMillion" inputmode="decimal" placeholder="输入成本 $/M"><input v-model="form.outputPerMillion" inputmode="decimal" placeholder="输出成本 $/M"><input v-model="form.cachedPerMillion" inputmode="decimal" placeholder="缓存成本 $/M"><input v-model="form.reasoningPerMillion" inputmode="decimal" placeholder="推理成本 $/M"></div>
      <p v-if="validationError" class="state error">{{ validationError }}</p>
      <div class="form-row"><label>生效日期<input v-model="form.validFrom" type="date"></label><label>失效日期（可选）<input v-model="form.validUntil" type="date"></label><button v-if="editingId" @click="resetForm">取消编辑</button><button class="primary" :disabled="busy || previewing" @click="submit">{{ previewing ? '校验中…' : editingId ? '保存修改' : '添加规则' }}</button></div>
    </section>
  </div>
</template>
