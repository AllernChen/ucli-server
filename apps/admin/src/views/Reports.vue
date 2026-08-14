<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const loading = ref(true)
const error = ref('')
const reports = ref<any[]>([])
const gen = ref({ period: 'DAY', scope: 'PLATFORM', scopeId: '', rangeStart: '', rangeEnd: '' })

async function load() {
  loading.value = true; error.value = ''
  try { reports.value = await api('/api/v1/reports') }
  catch (value: any) { error.value = value.message } finally { loading.value = false }
}
async function generate() {
  if (!gen.value.rangeStart || !gen.value.rangeEnd) return error.value = '请选择起止时间'
  const body: Record<string, any> = {
    period: gen.value.period, scope: gen.value.scope,
    rangeStart: new Date(gen.value.rangeStart).toISOString(),
    rangeEnd: new Date(gen.value.rangeEnd).toISOString()
  }
  if (gen.value.scope !== 'PLATFORM' && gen.value.scopeId) body.scopeId = gen.value.scopeId
  try {
    await api('/api/v1/reports/generate', { method: 'POST', body: JSON.stringify(body) })
    await load()
  } catch (value: any) { error.value = value.message }
}
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>运营报告</h1></div><button @click="load">刷新数据</button></header>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <section class="panel form-panel">
      <h2>生成报告</h2>
      <div class="form-row">
        <select v-model="gen.period"><option value="DAY">日</option><option value="WEEK">周</option><option value="MONTH">月</option><option value="QUARTER">季度</option><option value="YEAR">年</option></select>
        <select v-model="gen.scope"><option value="PLATFORM">平台</option><option value="ORGANIZATION">组织</option><option value="ACCOUNT">账号</option><option value="MODEL">模型</option><option value="CHANNEL">渠道</option></select>
        <input v-if="gen.scope !== 'PLATFORM'" v-model="gen.scopeId" placeholder="scopeId（组织/账号/模型/渠道 id）">
        <input v-model="gen.rangeStart" type="datetime-local">
        <input v-model="gen.rangeEnd" type="datetime-local">
        <button class="primary" @click="generate">生成报告</button>
      </div>
    </section>
    <section class="panel">
      <h2>报告列表</h2>
      <table v-if="reports.length">
        <thead><tr><th>周期</th><th>范围</th><th>时间范围</th><th>请求数</th><th>费用</th><th>创建时间</th></tr></thead>
        <tbody><tr v-for="report in reports" :key="report.id"><td>{{ report.period }}</td><td>{{ report.scope }}</td><td>{{ report.rangeStart?.slice(0, 10) }} ~ {{ report.rangeEnd?.slice(0, 10) }}</td><td>{{ report.metrics?.requests }}</td><td>${{ report.metrics?.costUsd }}</td><td>{{ report.createdAt }}</td></tr></tbody>
      </table>
      <p v-else class="empty">暂无报告</p>
    </section>
  </template>
</template>
