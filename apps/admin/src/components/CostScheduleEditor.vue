<script setup lang="ts">
import { computed, reactive } from 'vue'
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

const props = defineProps<{ rules: CostRule[]; timezone: string; busy?: boolean }>()
const emit = defineEmits<{ save: [rule: CostRuleInput]; remove: [id: string] }>()
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const form = reactive({
  name: '基础成本', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '00:00', priority: 0,
  inputPerMillion: '', outputPerMillion: '', cachedPerMillion: '0', reasoningPerMillion: '0',
  validFrom: new Date().toISOString().slice(0, 10), validUntil: ''
})

const activeRules = computed(() => props.rules.filter(rule => rule.enabled))
function minute(value: string) { const [hour, minutes] = value.split(':').map(Number); return hour * 60 + minutes }
function toggleDay(day: number) {
  form.daysOfWeek = form.daysOfWeek.includes(day) ? form.daysOfWeek.filter(value => value !== day) : [...form.daysOfWeek, day].sort()
}
function submit() {
  if (!form.daysOfWeek.length || form.inputPerMillion === '' || form.outputPerMillion === '') return
  emit('save', {
    name: form.name, daysOfWeek: form.daysOfWeek, startMinute: minute(form.start), endMinute: minute(form.end),
    priority: Number(form.priority), inputPerMillion: form.inputPerMillion, outputPerMillion: form.outputPerMillion,
    cachedPerMillion: form.cachedPerMillion || '0', reasoningPerMillion: form.reasoningPerMillion || '0',
    validFrom: new Date(`${form.validFrom}T00:00:00Z`).toISOString(),
    ...(form.validUntil ? { validUntil: new Date(`${form.validUntil}T00:00:00Z`).toISOString() } : {})
  })
}
function covers(rule: CostRule, day: number, hour: number) {
  const current = hour * 60
  if (rule.startMinute === rule.endMinute) return rule.daysOfWeek.includes(day)
  if (rule.startMinute < rule.endMinute) return rule.daysOfWeek.includes(day) && current >= rule.startMinute && current < rule.endMinute
  const previous = day === 1 ? 7 : day - 1
  return (rule.daysOfWeek.includes(day) && current >= rule.startMinute) || (rule.daysOfWeek.includes(previous) && current < rule.endMinute)
}
function ruleAt(day: number, hour: number) {
  return activeRules.value.filter(rule => covers(rule, day, hour)).sort((a, b) => b.priority - a.priority)[0]
}
function clock(value: number) { return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` }
</script>

<template>
  <div class="cost-editor">
    <p class="muted">时区：{{ timezone }}。相同优先级的重叠规则会被服务端拒绝；高优先级覆盖基础成本。</p>
    <div class="schedule-grid">
      <div></div><small v-for="hour in 24" :key="hour">{{ hour - 1 }}</small>
      <template v-for="day in 7" :key="day"><strong>周{{ weekdays[day - 1] }}</strong>
        <span v-for="hour in 24" :key="hour" :class="{ covered: ruleAt(day, hour - 1), peak: (ruleAt(day, hour - 1)?.priority || 0) > 0 }" :title="ruleAt(day, hour - 1)?.name || '未配置'"></span>
      </template>
    </div>
    <div v-if="rules.length" class="rule-list">
      <article v-for="rule in rules" :key="rule.id"><div><strong>{{ rule.name }}</strong><small>优先级 {{ rule.priority }} · {{ clock(rule.startMinute) }}–{{ clock(rule.endMinute) }} · in ${{ rule.inputPerMillion }} / out ${{ rule.outputPerMillion }}</small></div>
        <button class="danger-link" @click="emit('remove', rule.id)">停用</button></article>
    </div>
    <section class="sub-panel"><h3>新增成本规则</h3>
      <div class="day-selector"><button v-for="day in 7" :key="day" :class="{ active: form.daysOfWeek.includes(day) }" @click="toggleDay(day)">周{{ weekdays[day - 1] }}</button></div>
      <div class="form-row"><input v-model="form.name" placeholder="规则名称"><input v-model="form.start" type="time"><input v-model="form.end" type="time"><input v-model.number="form.priority" type="number" min="0" placeholder="优先级"></div>
      <div class="form-row"><input v-model="form.inputPerMillion" inputmode="decimal" placeholder="输入成本 $/M"><input v-model="form.outputPerMillion" inputmode="decimal" placeholder="输出成本 $/M"><input v-model="form.cachedPerMillion" inputmode="decimal" placeholder="缓存成本 $/M"><input v-model="form.reasoningPerMillion" inputmode="decimal" placeholder="推理成本 $/M"></div>
      <div class="form-row"><label>生效日期<input v-model="form.validFrom" type="date"></label><label>失效日期（可选）<input v-model="form.validUntil" type="date"></label><button class="primary" :disabled="busy" @click="submit">添加规则</button></div>
    </section>
  </div>
</template>
