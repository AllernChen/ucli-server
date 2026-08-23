<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { toast } from '../toast'
import type { CatalogLifecycle, ChannelProtocol, ChannelSummary, Page } from '../types/catalog'
import Drawer from '../components/Drawer.vue'
import Pagination from '../components/Pagination.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

const route = useRoute()
const router = useRouter()
const loading = ref(true)
const error = ref('')
const result = ref<Page<ChannelSummary>>({ items: [], total: 0, limit: 20, offset: 0 })
const createOpen = ref(false)
const pendingToggle = ref<ChannelSummary | null>(null)
const pendingArchive = ref<ChannelSummary | null>(null)
const filters = reactive({
  q: String(route.query.q || ''), provider: String(route.query.provider || ''), protocol: String(route.query.protocol || ''),
  health: String(route.query.health || ''), enabled: String(route.query.enabled || ''),
  lifecycle: (route.query.lifecycle === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE') as CatalogLifecycle,
  limit: 20, offset: Number(route.query.offset || 0)
})
const form = reactive({
  name: '', provider: '', protocol: 'OPENAI' as ChannelProtocol, baseUrl: '', modelDiscoveryUrl: '', keySelection: 'WEIGHTED_RANDOM',
  priority: 0, weight: 1, timeoutMs: 300000, maxRetries: 1, costTimezone: 'UTC'
})

async function load() {
  const requestId = ++latestRequest
  loading.value = true; error.value = ''
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => { if (value !== '') params.set(key, String(value)) })
  try {
    const next = await api<Page<ChannelSummary>>(`/api/v1/admin/channels?${params}`)
    if (requestId !== latestRequest) return
    result.value = next
    await router.replace({ query: Object.fromEntries([...params].filter(([key]) => key !== 'limit')) })
  } catch (value: any) { if (requestId === latestRequest) error.value = value.message } finally {
    if (requestId === latestRequest) loading.value = false
  }
}
async function create() {
  error.value = ''
  try {
    await api('/api/v1/admin/channels', {
      method: 'POST', body: JSON.stringify({ ...form, modelDiscoveryUrl: form.modelDiscoveryUrl.trim() || undefined })
    })
    createOpen.value = false; toast('渠道已创建'); await load()
  } catch (value: any) { error.value = value.message }
}
async function confirmToggle() {
  if (!pendingToggle.value) return
  const channel = pendingToggle.value; pendingToggle.value = null
  try {
    await api(`/api/v1/admin/channels/${channel.id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled: !channel.enabled }) })
    toast(channel.enabled ? '渠道已停用' : '渠道已启用'); await load()
  } catch (value: any) { error.value = value.message }
}
async function archiveChannel() {
  const target = pendingArchive.value
  if (!target) return
  pendingArchive.value = null
  try {
    await api(`/api/v1/admin/channels/${target.id}`, { method: 'DELETE' })
    toast('渠道已删除，可在“已归档”中恢复')
    await load()
  } catch (value: any) { error.value = value.message }
}
async function restoreChannel(channel: ChannelSummary) {
  try {
    await api(`/api/v1/admin/channels/${channel.id}/restore`, { method: 'POST' })
    toast('渠道已恢复并保持停用，请检查配置后再启用')
    await load()
  } catch (value: any) { error.value = value.message }
}
function showLifecycle(lifecycle: CatalogLifecycle) {
  filters.lifecycle = lifecycle; filters.offset = 0
  if (lifecycle === 'ARCHIVED') { filters.enabled = ''; filters.health = '' }
}
function setOffset(offset: number) { filters.offset = offset; load() }
let timer: number | undefined; let latestRequest = 0
watch(() => [filters.q, filters.provider, filters.protocol, filters.health, filters.enabled, filters.lifecycle], () => {
  filters.offset = 0; window.clearTimeout(timer); timer = window.setTimeout(load, 250)
})
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>MODEL SUPPLY</p><h1>渠道管理</h1><span class="subtitle">维护供应商连接、渠道模型、Key 与健康状态</span></div>
    <div class="actions"><button @click="load">刷新</button><button class="primary" @click="createOpen = true">创建渠道</button></div></header>
  <div class="tabs"><button :class="{ active: filters.lifecycle === 'ACTIVE' }" @click="showLifecycle('ACTIVE')">使用中</button><button :class="{ active: filters.lifecycle === 'ARCHIVED' }" @click="showLifecycle('ARCHIVED')">已归档</button></div>
  <section class="panel toolbar"><input v-model="filters.q" placeholder="搜索渠道名称或供应商"><input v-model="filters.provider" placeholder="供应商">
    <select v-model="filters.protocol"><option value="">全部协议</option><option>OPENAI</option><option>ANTHROPIC</option><option>GEMINI</option></select>
    <select v-model="filters.health"><option value="">全部健康状态</option><option>HEALTHY</option><option>DEGRADED</option><option>UNHEALTHY</option><option>DISABLED</option></select>
    <select v-model="filters.enabled"><option value="">全部启停状态</option><option value="true">已启用</option><option value="false">已停用</option></select></section>
  <p v-if="loading" class="state">正在加载渠道…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <section v-else class="panel table-panel"><table v-if="result.items.length"><thead><tr><th>渠道</th><th>协议 / 地址</th><th>健康</th><th>资源</th><th>近 24 小时</th><th>操作</th></tr></thead>
    <tbody><tr v-for="channel in result.items" :key="channel.id" class="clickable-row" @click="router.push(`/channels/${channel.id}`)">
      <td><strong>{{ channel.name }}</strong><small>{{ channel.provider }} · 优先级 {{ channel.priority }} / 权重 {{ channel.weight }}</small></td>
      <td><span class="chip">{{ channel.protocol }}</span><small class="mono truncate">{{ channel.baseUrl }}</small></td>
      <td><StatusBadge :status="channel.enabled ? channel.health : 'DISABLED'" /><small>{{ channel.lastTestedAt ? `检测于 ${new Date(channel.lastTestedAt).toLocaleString()}` : '尚未检测' }}</small></td>
      <td><strong>{{ channel.healthyModels }}/{{ channel.modelCount }} 模型</strong><small>{{ channel.availableKeys }} 个可用 Key</small></td>
      <td><strong>{{ channel.usage24h.requests.toLocaleString() }} 请求</strong><small>成功率 {{ (channel.usage24h.successRate * 100).toFixed(1) }}% · P95 {{ channel.usage24h.p95LatencyMs ?? '—' }}ms</small></td>
      <td><div class="actions" @click.stop><template v-if="!channel.deletedAt"><button @click="router.push(`/channels/${channel.id}`)">查看</button><button @click="router.push({ path: `/channels/${channel.id}`, query: { tab: 'settings' } })">编辑</button><button @click="pendingToggle = channel">{{ channel.enabled ? '停用' : '启用' }}</button><button class="danger-link" @click="pendingArchive = channel">删除</button></template><template v-else><button @click="router.push(`/channels/${channel.id}`)">查看</button><button class="primary" @click="restoreChannel(channel)">恢复</button></template></div></td>
    </tr></tbody></table><p v-else class="empty">没有符合条件的渠道</p><Pagination v-bind="result" @change="setOffset" /></section>

  <Drawer :open="createOpen" title="创建渠道" @close="createOpen = false"><div class="stack-form"><label>渠道名称<input v-model="form.name" placeholder="例如 OpenAI 主渠道"></label><label>供应商<input v-model="form.provider" placeholder="例如 openai"></label>
    <label>协议<select v-model="form.protocol"><option>OPENAI</option><option>ANTHROPIC</option><option>GEMINI</option></select></label><label>Base URL<input v-model="form.baseUrl" placeholder="https://api.example.com"></label>
    <label>成本时区<input v-model="form.costTimezone" placeholder="UTC / Asia/Shanghai"></label><details><summary>高级路由设置</summary><div class="stack-form"><label>模型发现 URL（可选）<input v-model="form.modelDiscoveryUrl" placeholder="https://api.example.com/v1/models"><small class="muted">填写完整地址后，获取上游模型时优先使用该 URL。</small></label><div class="form-row"><label>优先级<input v-model.number="form.priority" type="number"></label><label>权重<input v-model.number="form.weight" type="number" min="1"></label><label>超时 ms<input v-model.number="form.timeoutMs" type="number"></label><label>重试次数<input v-model.number="form.maxRetries" type="number"></label></div></div></details></div>
    <template #footer><button @click="createOpen = false">取消</button><button class="primary" @click="create">创建渠道</button></template></Drawer>
  <ConfirmDialog :open="Boolean(pendingToggle)" :title="pendingToggle?.enabled ? '停用渠道' : '启用渠道'" :message="pendingToggle?.enabled ? '停用后该渠道不会参与新请求路由。' : '启用后健康的渠道模型可以参与路由。'" :danger="pendingToggle?.enabled" @confirm="confirmToggle" @cancel="pendingToggle = null" />
  <ConfirmDialog :open="Boolean(pendingArchive)" title="删除渠道" :message="`确认删除“${pendingArchive?.name || ''}”？该渠道及其所有 Key、渠道模型和成本规则将停止参与路由；历史统计会保留，并可从已归档列表恢复。`" confirm-label="删除渠道" danger @confirm="archiveChannel" @cancel="pendingArchive = null" />
</template>
