<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import {
  costStatusMeta, effectiveCostSource, formatProcurementPrice, parseCostWorkspaceSelection
} from '../procurement-costs'
import type { Page, ProcurementCostStatus, ProcurementCostWorkspaceItem } from '../types/catalog'
import CostTimeline from '../components/CostTimeline.vue'
import CostEvaluationPanel from '../components/CostEvaluationPanel.vue'
import type { CostTimelineSlot } from '../procurement-costs'

const route = useRoute()
const router = useRouter()
const initial = parseCostWorkspaceSelection(route.query)
const allowedStatuses: ProcurementCostStatus[] = [
  'CHANNEL_RULE_ACTIVE', 'PARTIAL_FALLBACK', 'FALLBACK_ONLY', 'NO_COST', 'UPCOMING', 'DISABLED'
]
const loading = ref(true)
const error = ref('')
const selectedId = ref(initial.channelModelId)
const selectedAt = ref(new Date().toISOString())
const inspectedSlot = ref<CostTimelineSlot | null>(null)
const result = ref<Page<ProcurementCostWorkspaceItem>>({ items: [], total: 0, limit: 200, offset: 0 })
const filters = reactive({
  manufacturer: '', publicModelId: initial.publicModelId, channelId: initial.channelId,
  status: (allowedStatuses.includes(route.query.status as ProcurementCostStatus) ? route.query.status : '') as ProcurementCostStatus | '',
  search: String(route.query.search || '')
})

const selected = computed(() => result.value.items.find(item => item.channelModelId === selectedId.value) || result.value.items[0] || null)
const manufacturers = computed(() => [...new Map(result.value.items.map(item => [item.manufacturerKey, item.manufacturer])).entries()])
const models = computed(() => [...new Map(result.value.items.map(item => [item.publicModelId, item.publicModelName])).entries()])
const channels = computed(() => [...new Map(result.value.items.map(item => [item.channelId, item.channelName])).entries()])
const grouped = computed(() => {
  const groups = new Map<string, { key: string; name: string; models: Map<string, { id: string; name: string; items: ProcurementCostWorkspaceItem[] }> }>()
  for (const item of result.value.items) {
    if (!groups.has(item.manufacturerKey)) groups.set(item.manufacturerKey, { key: item.manufacturerKey, name: item.manufacturer, models: new Map() })
    const group = groups.get(item.manufacturerKey)!
    if (!group.models.has(item.publicModelId)) group.models.set(item.publicModelId, { id: item.publicModelId, name: item.publicModelName, items: [] })
    group.models.get(item.publicModelId)!.items.push(item)
  }
  return [...groups.values()].map(group => ({ ...group, models: [...group.models.values()] }))
})

function queryString() {
  const params = new URLSearchParams({ limit: '200', offset: '0' })
  Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value) })
  return params
}
let requestToken = 0
async function load() {
  const current = ++requestToken
  loading.value = true; error.value = ''
  try {
    const next = await api<Page<ProcurementCostWorkspaceItem>>(`/api/v1/admin/procurement-costs?${queryString()}`)
    if (current !== requestToken) return
    result.value = next
    if (!next.items.some(item => item.channelModelId === selectedId.value)) selectedId.value = next.items[0]?.channelModelId || ''
    await syncRoute()
  } catch (value: any) {
    if (current === requestToken) error.value = value.message
  } finally { if (current === requestToken) loading.value = false }
}
async function syncRoute() {
  const query: Record<string, string> = {}
  Object.entries(filters).forEach(([key, value]) => { if (value) query[key] = value })
  if (selectedId.value) query.channelModelId = selectedId.value
  await router.replace({ query })
}
function select(item: ProcurementCostWorkspaceItem) { selectedId.value = item.channelModelId; void syncRoute() }
function evaluated(value: { at: string }) { selectedAt.value = value.at }
function hours(minutes: number) { return `${(minutes / 60).toFixed(minutes % 60 ? 1 : 0)}h` }
function nextChange(item: ProcurementCostWorkspaceItem) {
  if (!item.nextTransition) return '未来 7 天无价格切换'
  return `${new Date(item.nextTransition.at).toLocaleString()} · ${effectiveCostSource(item.nextTransition.cost)}`
}
let timer: number | undefined
watch(() => [filters.manufacturer, filters.publicModelId, filters.channelId, filters.status, filters.search], () => {
  window.clearTimeout(timer); timer = window.setTimeout(load, 250)
})
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>PROCUREMENT COST</p><h1>采购成本</h1><span class="subtitle">统一维护公共兜底价与渠道分时成本，仅用于公司内部成本统计。</span></div><div class="actions"><button @click="load">刷新</button><button class="primary" :disabled="!selected">新建成本规则</button></div></header>
  <section class="panel cost-workspace-filters">
    <input v-model="filters.search" placeholder="搜索模型、渠道或上游模型">
    <select v-model="filters.manufacturer"><option value="">全部厂家</option><option v-for="item in manufacturers" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select>
    <select v-model="filters.publicModelId"><option value="">全部模型</option><option v-for="item in models" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select>
    <select v-model="filters.channelId"><option value="">全部渠道</option><option v-for="item in channels" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select>
    <select v-model="filters.status"><option value="">全部配置状态</option><option v-for="status in allowedStatuses" :key="status" :value="status">{{ costStatusMeta(status).label }}</option></select>
  </section>
  <p v-if="loading" class="state">正在加载采购成本配置…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <section v-else-if="!result.items.length" class="panel empty">没有符合条件的渠道模型</section>
  <div v-else class="cost-workspace">
    <section class="panel cost-object-tree">
      <section v-for="group in grouped" :key="group.key"><h2>{{ group.name }}</h2>
        <div v-for="model in group.models" :key="model.id" class="cost-model-group"><strong>{{ model.name }}</strong><small>{{ model.id }}</small>
          <button v-for="item in model.items" :key="item.channelModelId" :class="{ active: selected?.channelModelId === item.channelModelId }" @click="select(item)">
            <span>{{ item.channelName }}</span><small>{{ costStatusMeta(item.status).label }}</small>
          </button>
        </div>
      </section>
    </section>
    <main v-if="selected" class="cost-workspace-detail">
      <section class="panel cost-summary"><div class="section-header"><div><p class="muted">{{ selected.manufacturer }} · {{ selected.publicModelId }}</p><h2>{{ selected.publicModelName }} / {{ selected.channelName }}</h2><p class="muted">上游 {{ selected.upstreamModel }} · {{ selected.timezone }}</p></div><span class="chip" :class="costStatusMeta(selected.status).tone">{{ costStatusMeta(selected.status).label }}</span></div>
        <div class="detail-grid"><article class="metric-block"><span>当前生效成本</span><strong class="small-strong">{{ formatProcurementPrice(selected.currentCost) }}</strong><small>{{ effectiveCostSource(selected.currentCost) }}</small></article><article class="metric-block"><span>下次价格切换</span><strong class="small-strong">{{ nextChange(selected) }}</strong><small>按 {{ selected.timezone }} 解释</small></article><article class="metric-block"><span>渠道规则覆盖</span><strong>{{ hours(selected.coverage.channelRuleMinutes) }}</strong><small>公共兜底 {{ hours(selected.coverage.fallbackMinutes) }} · 缺口 {{ hours(selected.coverage.uncoveredMinutes) }}</small></article><article class="metric-block"><span>规则数量</span><strong>{{ selected.ruleCounts.active }}</strong><small>未来 {{ selected.ruleCounts.future }} · 停用 {{ selected.ruleCounts.disabled }}</small></article></div>
      </section>
      <section class="panel"><div class="section-header"><div><h2>周价格时间轴</h2><p class="muted">30 分钟显示粒度；实际保存与试算保持分钟级精度。</p></div></div><CostTimeline :rules="selected.rules" :fallback="selected.fallback" :timezone="selected.timezone" :selected-at="selectedAt" @select="inspectedSlot = $event" /><CostEvaluationPanel :channel-model-id="selected.channelModelId" :timezone="selected.timezone" @evaluated="evaluated" /></section>
    </main>
  </div>
</template>
