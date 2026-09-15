<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { formatCny } from '../currency'

const loading = ref(true)
const error = ref('')
const rows = ref<any[]>([])
const expanded = ref<string | null>(null)
const props = defineProps<{ groupId?: string; embedded?: boolean }>()
const route = useRoute()
const filters = ref({ model: '', accountId: '', channelId: '', groupId: '', apiKeyId: '', credentialType: '', start: '', end: '', limit: '50' })
const offset = ref(0)
let generation = 0

const pageSize = () => Math.min(200, Math.max(1, Number(filters.value.limit) || 50))

async function load() {
  const current = ++generation
  loading.value = true; error.value = ''
  const params = new URLSearchParams()
  if (filters.value.model) params.set('model', filters.value.model)
  if (filters.value.accountId) params.set('accountId', filters.value.accountId)
  if (filters.value.channelId) params.set('channelId', filters.value.channelId)
  if (props.groupId || filters.value.groupId) params.set('groupId', props.groupId || filters.value.groupId)
  if (filters.value.apiKeyId) params.set('apiKeyId', filters.value.apiKeyId)
  if (filters.value.credentialType) params.set('credentialType', filters.value.credentialType)
  if (filters.value.start) params.set('start', new Date(filters.value.start).toISOString())
  if (filters.value.end) params.set('end', new Date(filters.value.end).toISOString())
  params.set('limit', String(pageSize()))
  params.set('offset', String(offset.value))
  try { const result = await api('/api/v1/usage/logs?' + params.toString()); if (current === generation) rows.value = result }
  catch (value: any) { if (current === generation) error.value = value.message } finally { if (current === generation) loading.value = false }
}
function search() { offset.value = 0; load() }
function prev() { if (offset.value > 0) { offset.value = Math.max(0, offset.value - pageSize()); load() } }
function next() { if (rows.value.length === pageSize()) { offset.value += pageSize(); load() } }
function toggle(id: string) { expanded.value = expanded.value === id ? null : id }
const fmt = (n: any) => Number(n || 0).toLocaleString()
watch(() => [props.groupId, route.query], () => {
  filters.value.groupId = props.groupId || String(route.query?.groupId || '')
  filters.value.accountId = String(route.query?.accountId || ''); filters.value.apiKeyId = String(route.query?.apiKeyId || '')
  offset.value = 0; rows.value = []; expanded.value = null; load()
}, { immediate: true })
onUnmounted(() => { generation++ })
</script>

<template>
  <header v-if="!embedded" class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>使用日志</h1></div><button @click="load">刷新数据</button></header>
  <section class="panel form-panel">
    <div class="form-row">
      <input v-model="filters.model" placeholder="模型 id">
      <input v-model="filters.accountId" placeholder="账号 id">
      <input v-model="filters.channelId" placeholder="渠道 id">
      <input v-model="filters.groupId" :disabled="Boolean(groupId)" placeholder="用量组 id" aria-label="用量组筛选">
      <input v-model="filters.apiKeyId" placeholder="员工 Key id" aria-label="Key 筛选">
      <select v-model="filters.credentialType" aria-label="凭据类型"><option value="">全部凭据</option><option value="API_KEY">员工 API Key</option><option value="DEVICE">UCLI 设备</option></select>
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
        <thead><tr><th>时间</th><th>员工 / 用量组</th><th>凭据</th><th>模型</th><th>实际渠道 / 上游</th><th>输入/输出 tokens</th><th>采购成本 CNY</th><th>延迟</th><th>状态</th><th>路由</th></tr></thead>
        <tbody>
          <template v-for="row in rows" :key="row.requestId">
            <tr>
              <td>{{ new Date(row.startedAt).toLocaleString() }}</td>
              <td><strong>{{ row.employeeName || row.account?.displayName || row.account?.email || row.accountId }}</strong><small>{{ row.groupName || '历史未归组' }}</small></td>
              <td>{{ row.credentialType === 'API_KEY' ? row.keyName || '员工 Key' : 'UCLI 设备' }}<small class="mono">{{ row.keyHint || row.deviceId }}</small></td>
              <td class="mono">{{ row.publicModelId }}</td>
              <td>{{ row.channel?.name || row.channelId }}<small class="mono">{{ row.upstreamModel }}</small></td>
              <td>{{ fmt(row.inputTokens) }} / {{ fmt(row.outputTokens) }}</td>
              <td>{{ formatCny(row.costCny ?? row.costUsd) }}<small>{{ row.billingState === 'UNKNOWN' ? '含待核对费用，非最终成本' : row.usageSource === 'ESTIMATED' ? '估算' : '已结算' }}</small><small>{{ row.costSnapshot?.ruleName || row.costSnapshot?.source || '历史价格' }} · {{ row.costSnapshot?.timezone || '—' }}</small></td>
              <td>{{ row.durationMs }}ms<template v-if="row.firstTokenMs"> / 首字 {{ row.firstTokenMs }}ms</template></td>
              <td><i :class="row.statusCode < 400 ? 'ok' : 'bad'"></i>{{ row.statusCode }}<template v-if="row.errorCode"> ({{ row.errorCode }})</template></td>
              <td><button @click="toggle(row.requestId)">{{ row.routeAttempts || 1 }} 次</button></td>
            </tr>
            <tr v-if="expanded === row.requestId">
              <td colspan="10">
                <div class="keys">
                  <span v-for="(attempt, i) in (row.routes || [])" :key="i" class="key-chip">#{{ attempt.attempt }} {{ attempt.channel?.name || attempt.channelId }} · {{ attempt.durationMs }}ms · {{ attempt.statusCode ?? '—' }} · {{ attempt.billingState === 'UNKNOWN' ? '费用待核对' : formatCny(attempt.costCny) }}</span>
                  <span v-if="!row.routes?.length" class="mono">无路由详情</span>
                </div>
                <details><summary>请求与价格快照</summary><p class="mono">{{ row.requestId }}</p><pre>{{ JSON.stringify(row.costSnapshot, null, 2) }}</pre></details>
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
