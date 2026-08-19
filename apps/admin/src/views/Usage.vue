<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const loading = ref(true)
const error = ref('')
const rows = ref<any[]>([])
const expanded = ref<string | null>(null)
const filters = ref({ model: '', accountId: '', channelId: '', start: '', end: '', limit: '50' })
const offset = ref(0)

const pageSize = () => Math.min(200, Math.max(1, Number(filters.value.limit) || 50))

async function load() {
  loading.value = true; error.value = ''
  const params = new URLSearchParams()
  if (filters.value.model) params.set('model', filters.value.model)
  if (filters.value.accountId) params.set('accountId', filters.value.accountId)
  if (filters.value.channelId) params.set('channelId', filters.value.channelId)
  if (filters.value.start) params.set('start', new Date(filters.value.start).toISOString())
  if (filters.value.end) params.set('end', new Date(filters.value.end).toISOString())
  params.set('limit', String(pageSize()))
  params.set('offset', String(offset.value))
  try { rows.value = await api('/api/v1/usage/logs?' + params.toString()) }
  catch (value: any) { error.value = value.message } finally { loading.value = false }
}
function search() { offset.value = 0; load() }
function prev() { if (offset.value > 0) { offset.value = Math.max(0, offset.value - pageSize()); load() } }
function next() { if (rows.value.length === pageSize()) { offset.value += pageSize(); load() } }
function toggle(id: string) { expanded.value = expanded.value === id ? null : id }
const fmt = (n: any) => Number(n || 0).toLocaleString()
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>使用日志</h1></div><button @click="load">刷新数据</button></header>
  <section class="panel form-panel">
    <div class="form-row">
      <input v-model="filters.model" placeholder="模型 id">
      <input v-model="filters.accountId" placeholder="账号 id">
      <input v-model="filters.channelId" placeholder="渠道 id">
      <input v-model="filters.start" type="datetime-local">
      <input v-model="filters.end" type="datetime-local">
      <input v-model="filters.limit" type="number" min="1" max="200" placeholder="每页条数">
      <button class="primary" @click="search">查询</button>
    </div>
  </section>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <section class="panel">
      <table v-if="rows.length">
        <thead><tr><th>时间</th><th>模型</th><th>上游</th><th>输入/输出 tokens</th><th>费用</th><th>延迟</th><th>状态</th><th>切换</th><th>路由</th></tr></thead>
        <tbody>
          <template v-for="row in rows" :key="row.requestId">
            <tr>
              <td>{{ row.startedAt?.slice(0, 19).replace('T', ' ') }}</td>
              <td class="mono">{{ row.publicModelId }}</td>
              <td class="mono">{{ row.upstreamModel }}</td>
              <td>{{ fmt(row.inputTokens) }} / {{ fmt(row.outputTokens) }}</td>
              <td>${{ row.costUsd }}</td>
              <td>{{ row.durationMs }}ms<template v-if="row.firstTokenMs"> / 首字 {{ row.firstTokenMs }}ms</template></td>
              <td><i :class="row.statusCode < 400 ? 'ok' : 'bad'"></i>{{ row.statusCode }}<template v-if="row.errorCode"> ({{ row.errorCode }})</template></td>
              <td>{{ row.switched ? '是' : '—' }}</td>
              <td><button @click="toggle(row.requestId)">{{ row.routeAttempts || 1 }} 次</button></td>
            </tr>
            <tr v-if="expanded === row.requestId">
              <td colspan="9">
                <div class="keys">
                  <span v-for="(attempt, i) in (row.routes || [])" :key="i" class="key-chip">#{{ attempt.attempt }} 渠道 {{ (attempt.channelId || '').slice(0, 8) }} · {{ attempt.durationMs }}ms · {{ attempt.statusCode ?? '—' }}</span>
                  <span v-if="!row.routes?.length" class="mono">无路由详情</span>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <p v-else class="empty">暂无日志</p>
      <div v-if="rows.length" class="actions">
        <button @click="prev">上一页</button>
        <button @click="next">下一页</button>
      </div>
    </section>
  </template>
</template>
