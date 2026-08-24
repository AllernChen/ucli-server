<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import {
  costRuleLifecycle, costStatusMeta, effectiveCostSource, formatProcurementPrice, parseCostWorkspaceSelection
} from '../procurement-costs'
import type { CostRule, Page, ProcurementCostStatus, ProcurementCostWorkspaceItem } from '../types/catalog'
import CostTimeline from '../components/CostTimeline.vue'
import CostEvaluationPanel from '../components/CostEvaluationPanel.vue'
import type { CostTimelineSlot } from '../procurement-costs'
import CostRuleForm from '../components/CostRuleForm.vue'
import Drawer from '../components/Drawer.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { toast } from '../toast'
import { scheduledCostLabel } from '../model-cost-alignment'

const route = useRoute()
const router = useRouter()
const initial = parseCostWorkspaceSelection(route.query)
const allowedStatuses: ProcurementCostStatus[] = [
  'CHANNEL_RULE_ACTIVE', 'PARTIAL_FALLBACK', 'FALLBACK_ONLY', 'NO_COST', 'UPCOMING', 'DISABLED'
]
const loading = ref(true)
const error = ref('')
const objectListCollapsed = ref(false)
const selectedId = ref(initial.channelModelId)
const selectedAt = ref(new Date().toISOString())
const inspectedSlot = ref<CostTimelineSlot | null>(null)
const editorOpen = ref(false)
const editorMode = ref<'CREATE' | 'EDIT' | 'DUPLICATE'>('CREATE')
const editingRule = ref<CostRule | null>(null)
const editorVersion = ref(0)
const pendingArchive = ref<CostRule | null>(null)
const rulesTab = ref<'ACTIVE' | 'ARCHIVED'>('ACTIVE')
const archivedRules = ref<CostRule[]>([])
const archivedLoading = ref(false)
const saving = ref(false)
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
    if (rulesTab.value === 'ARCHIVED') await loadArchivedRules()
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
function select(item: ProcurementCostWorkspaceItem) {
  selectedId.value = item.channelModelId; archivedRules.value = []; void syncRoute()
  if (rulesTab.value === 'ARCHIVED') void loadArchivedRules()
}
function evaluated(value: { at: string }) { selectedAt.value = value.at }
function hours(minutes: number) { return `${(minutes / 60).toFixed(minutes % 60 ? 1 : 0)}h` }
function nextChange(item: ProcurementCostWorkspaceItem) {
  if (!item.nextTransition) return '未来 7 天无价格切换'
  return `${new Date(item.nextTransition.at).toLocaleString()} · ${effectiveCostSource(item.nextTransition.cost)}`
}
function openEditor(mode: 'CREATE' | 'EDIT' | 'DUPLICATE', rule: CostRule | null = null) {
  editorMode.value = mode; editingRule.value = rule; editorVersion.value++; editorOpen.value = true
}
async function saveRule(payload: any, keepOpen: boolean) {
  if (!selected.value) return
  saving.value = true
  try {
    const { id, ...body } = payload
    await api(id ? `/api/v1/admin/channel-model-cost-rules/${id}` : `/api/v1/admin/channel-models/${selected.value.channelModelId}/cost-rules`, {
      method: id ? 'PATCH' : 'POST', body: JSON.stringify(body)
    })
    toast(id ? '成本规则已更新' : '成本规则已创建')
    await load()
    if (keepOpen) { editorMode.value = 'CREATE'; editingRule.value = null; editorVersion.value++ } else editorOpen.value = false
  } catch (value: any) { error.value = value.message } finally { saving.value = false }
}
async function toggleRule(rule: CostRule) {
  try {
    await api(`/api/v1/admin/channel-model-cost-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) })
    toast(rule.enabled ? '成本规则已停用' : '成本规则已启用'); await load()
  } catch (value: any) { error.value = value.message }
}
async function archiveRule() {
  const rule = pendingArchive.value
  if (!rule) return
  pendingArchive.value = null
  try {
    await api(`/api/v1/admin/channel-model-cost-rules/${rule.id}`, { method: 'DELETE' })
    toast('成本规则已删除，可在“已归档”中恢复'); await load()
  } catch (value: any) { error.value = value.message }
}
async function loadArchivedRules() {
  if (!selected.value) return
  archivedLoading.value = true
  try { archivedRules.value = await api<CostRule[]>(`/api/v1/admin/channel-models/${selected.value.channelModelId}/cost-rules?lifecycle=ARCHIVED`) }
  catch (value: any) { error.value = value.message } finally { archivedLoading.value = false }
}
async function showRulesTab(tab: 'ACTIVE' | 'ARCHIVED') { rulesTab.value = tab; if (tab === 'ARCHIVED') await loadArchivedRules() }
async function restoreRule(rule: CostRule) {
  try {
    await api(`/api/v1/admin/channel-model-cost-rules/${rule.id}/restore`, { method: 'POST' })
    toast('成本规则已恢复并保持停用，请确认后再启用'); await load()
  } catch (value: any) { error.value = value.message }
}
let timer: number | undefined
watch(() => [filters.manufacturer, filters.publicModelId, filters.channelId, filters.status, filters.search], () => {
  window.clearTimeout(timer); timer = window.setTimeout(load, 250)
})
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>PROCUREMENT COST</p><h1>采购成本</h1><span class="subtitle">统一维护公共兜底价与渠道分时成本，仅用于公司内部成本统计。</span></div><div class="actions"><button @click="load">刷新</button><button class="primary" :disabled="!selected" @click="openEditor('CREATE')">新建成本规则</button></div></header>
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
    <button class="cost-tree-toggle" @click="objectListCollapsed = !objectListCollapsed">{{ objectListCollapsed ? '展开对象列表' : '收起对象列表' }}</button>
    <section v-if="!objectListCollapsed" class="panel cost-object-tree">
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
      <section class="panel"><div class="section-header"><div><h2>成本规则</h2><p class="muted">基础价与分时覆盖价统一在此维护。</p></div><button class="primary" @click="openEditor('CREATE')">新建规则</button></div><div class="tabs compact"><button :class="{ active: rulesTab === 'ACTIVE' }" @click="showRulesTab('ACTIVE')">当前配置</button><button :class="{ active: rulesTab === 'ARCHIVED' }" @click="showRulesTab('ARCHIVED')">已归档</button></div><p v-if="archivedLoading" class="state">正在加载归档规则…</p><div v-else class="cost-rule-table"><template v-if="rulesTab === 'ACTIVE'"><article v-for="rule in selected.rules" :key="rule.id"><div><span class="chip">{{ costRuleLifecycle(rule).label }}</span><strong>{{ rule.name }}</strong><small>{{ scheduledCostLabel(rule, selected.timezone) }} · 输入 ¥{{ rule.inputPerMillion }} / 输出 ¥{{ rule.outputPerMillion }} / 1M</small></div><div class="actions"><button @click="openEditor('EDIT', rule)">编辑</button><button @click="openEditor('DUPLICATE', rule)">复制</button><button @click="toggleRule(rule)">{{ rule.enabled ? '停用' : '启用' }}</button><button class="danger-link" @click="pendingArchive = rule">删除</button></div></article><p v-if="!selected.rules.length" class="empty">尚未配置渠道成本规则，当前将使用公共模型兜底价。</p></template><template v-else><article v-for="rule in archivedRules" :key="rule.id"><div><span class="chip">已归档</span><strong>{{ rule.name }}</strong><small>{{ scheduledCostLabel(rule, selected.timezone) }} · 输入 ¥{{ rule.inputPerMillion }} / 输出 ¥{{ rule.outputPerMillion }} / 1M</small></div><div class="actions"><button class="primary" @click="restoreRule(rule)">恢复</button></div></article><p v-if="!archivedRules.length" class="empty">没有已归档的成本规则</p></template></div></section>
    </main>
  </div>
  <Drawer :open="editorOpen" :title="editorMode === 'EDIT' ? '编辑采购成本规则' : editorMode === 'DUPLICATE' ? '复制采购成本规则' : '新建采购成本规则'" width="720px" @close="editorOpen = false"><CostRuleForm v-if="selected" :key="editorVersion" :channel-model-id="selected.channelModelId" :timezone="selected.timezone" :rules="selected.rules" :fallback="selected.fallback" :mode="editorMode" :rule="editingRule" :busy="saving" @save="saveRule" @cancel="editorOpen = false" /></Drawer>
  <ConfirmDialog :open="Boolean(pendingArchive)" title="删除成本规则" :message="`确认删除“${pendingArchive?.name || ''}”？规则将立即停止参与成本解析，历史用量记录保留，并可从已归档列表恢复。`" confirm-label="删除规则" danger @confirm="archiveRule" @cancel="pendingArchive = null" />
</template>
