<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, optional } from '../api'
import { toast } from '../toast'
import { formatCny } from '../currency'

const loading = ref(true)
const error = ref('')
const reports = ref<any[]>([])
const orgs = ref<any[]>([])
const models = ref<any[]>([])
const channels = ref<any[]>([])
const gen = ref({ period: 'DAY', scope: 'PLATFORM', scopeId: '', rangeStart: '', rangeEnd: '' })
const offset = ref(0)
const limit = ref('50')

async function load() {
  loading.value = true; error.value = ''
  try {
    reports.value = await api(`/api/v1/reports?limit=${Number(limit.value) || 50}&offset=${offset.value}`)
    const [o, m, c] = await Promise.all([
      optional('/api/v1/admin/organizations'),
      optional('/api/v1/admin/models'),
      optional('/api/v1/admin/channels')
    ])
    orgs.value = o; models.value = m; channels.value = c
  }
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
    toast('报告已生成')
    offset.value = 0
    await load()
  } catch (value: any) { error.value = value.message }
}
function prev() { if (offset.value > 0) { offset.value = Math.max(0, offset.value - (Number(limit.value) || 50)); load() } }
function next() { if (reports.value.length === (Number(limit.value) || 50)) { offset.value += (Number(limit.value) || 50); load() } }
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
                <select v-if="gen.scope === 'ORGANIZATION'" v-model="gen.scopeId"><option value="">本组织</option><option v-for="o in orgs" :key="o.id" :value="o.id">{{ o.name }}</option></select>
        <select v-else-if="gen.scope === 'MODEL'" v-model="gen.scopeId"><option value="">全部</option><option v-for="m in models" :key="m.id" :value="m.id">{{ m.displayName || m.id }}</option></select>
        <select v-else-if="gen.scope === 'CHANNEL'" v-model="gen.scopeId"><option value="">全部</option><option v-for="c in channels" :key="c.id" :value="c.id">{{ c.name }}</option></select>
        <input v-else-if="gen.scope === 'ACCOUNT'" v-model="gen.scopeId" placeholder="账号 id">
        <input v-model="gen.rangeStart" type="datetime-local">
        <input v-model="gen.rangeEnd" type="datetime-local">
        <button class="primary" @click="generate">生成报告</button>
      </div>
    </section>
    <section class="panel">
      <h2>报告列表</h2>
      <table v-if="reports.length">
        <thead><tr><th>周期</th><th>范围</th><th>时间范围</th><th>请求数</th><th>费用</th><th>创建时间</th></tr></thead>
          <tbody><tr v-for="report in reports" :key="report.id"><td>{{ report.period }}</td><td>{{ report.scope }}</td><td>{{ report.rangeStart?.slice(0, 10) }} ~ {{ report.rangeEnd?.slice(0, 10) }}</td><td>{{ report.metrics?.requests }}</td><td>{{ formatCny(report.metrics?.costUsd) }}</td><td>{{ report.createdAt }}</td></tr></tbody>
      </table>
      <p v-else class="empty">暂无报告</p>
      <div v-if="reports.length" class="actions">
        <input v-model="limit" type="number" min="1" max="200" placeholder="每页条数" style="width:120px">
        <button @click="prev">上一页</button>
        <button @click="next">下一页</button>
      </div>
    </section>
  </template>
</template>
