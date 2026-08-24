<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { withLifecycle } from '../catalog-lifecycle'
import {
  bindingModeForId,
  buildModelBindingPayload,
  costArchiveNotice,
  exactArchivedPublicModelMatch,
  exactPublicModelMatch,
  nextModelFormError,
  nextPublicModelIdForUpstreamInput,
  suggestManufacturer,
  type ModelBindingForm
} from '../model-binding'
import { toast } from '../toast'
import { formatCny } from '../currency'
import { effectiveChannelCost } from '../model-cost-alignment'
import { procurementCostRoute } from '../procurement-costs'
import type { CatalogLifecycle, ChannelDetail, ChannelKey, ChannelModel, ModelProbe, ModelTestResult, Page, PublicModel } from '../types/catalog'
import StatusBadge from '../components/StatusBadge.vue'
import Drawer from '../components/Drawer.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

const route = useRoute(); const router = useRouter(); const channelId = String(route.params.id)
const supportedTabs = ['overview', 'models', 'keys', 'health', 'settings'] as const
const requestedTab = String(route.query.tab || 'overview')
const loading = ref(true); const error = ref(''); const tab = ref(supportedTabs.includes(requestedTab as typeof supportedTabs[number]) ? requestedTab : 'overview')
const channel = ref<ChannelDetail | null>(null)
const models = ref<Page<ChannelModel>>({ items: [], total: 0, limit: 100, offset: 0 })
type BindablePublicModel = PublicModel & { manufacturer?: string; manufacturerKey?: string }
type BindingResponse = {
  publicModelCreated: boolean
  publicModel: BindablePublicModel
  channelModel: ChannelModel
  costRulesArchived: number
}
const publicModels = ref<BindablePublicModel[]>([])
const modelDrawer = ref(false); const busy = ref(false)
const modelFormError = ref('')
const editingModelId = ref(''); const keyDrawer = ref(false); const editingKeyId = ref('')
const keyLifecycle = ref<CatalogLifecycle>('ACTIVE'); const modelLifecycle = ref<CatalogLifecycle>('ACTIVE')
const testingModelId = ref(''); const batchTesting = ref(false)
const discovered = ref<Array<{ upstreamModel: string; alreadyMapped: boolean }>>([])
const probes = ref<Page<ModelProbe>>({ items: [], total: 0, limit: 50, offset: 0 }); const probeModelId = ref('')
const keyInput = ref('')
const modelForm = reactive<ModelBindingForm>({ publicModelId: '', publicModelDisplayName: '', manufacturer: '', contextSize: null,
  upstreamModel: '', protocol: 'OPENAI_CHAT', supportsStream: true, supportsTools: true, probeEnabled: true, probeIntervalMinutes: 15 })
const keyForm = reactive({ priority: 0, weight: 1, remainingUsd: '', expiresAt: '' })
const settings = reactive({ name: '', provider: '', protocol: 'OPENAI', baseUrl: '', modelDiscoveryUrl: '', costTimezone: 'UTC', priority: 0, weight: 1, timeoutMs: 300000, maxRetries: 1, keySelection: 'WEIGHTED_RANDOM', autoDisable: true })
const isArchived = computed(() => Boolean(channel.value?.deletedAt))
const visibleKeys = computed(() => (channel.value?.keys || []).filter(item => keyLifecycle.value === 'ARCHIVED' ? item.deletedAt : !item.deletedAt))
const visibleModels = computed(() => models.value.items.filter(item => modelLifecycle.value === 'ARCHIVED' ? item.deletedAt : !item.deletedAt))
const matchedPublicModel = computed(() => exactPublicModelMatch(modelForm.publicModelId, publicModels.value))
const archivedPublicModel = computed(() => exactArchivedPublicModelMatch(modelForm.publicModelId, publicModels.value))
const bindingMode = computed(() => bindingModeForId(modelForm.publicModelId, publicModels.value))
const modelSaveDisabled = computed(() => busy.value || isArchived.value || !modelForm.upstreamModel.trim() || !modelForm.publicModelId.trim()
  || Boolean(archivedPublicModel.value)
  || (bindingMode.value === 'CREATE' && (!modelForm.publicModelDisplayName.trim() || !modelForm.manufacturer.trim())))
type ArchiveTarget = { type: 'channel' | 'key' | 'model'; id: string; name: string }
const pendingArchive = ref<ArchiveTarget | null>(null)
const archiveMessage = computed(() => {
  const target = pendingArchive.value
  if (!target) return ''
  if (target.type === 'channel') return `确认删除“${target.name}”？该渠道及所有 Key、模型和成本规则会停止参与路由；历史统计会保留，并可恢复。`
  if (target.type === 'key') return `确认删除 Key ••••${target.name}？它将立即停止参与路由；历史使用记录会保留，并可恢复。`
  return `确认删除渠道模型“${target.name}”？模型测试、自动探测和路由将停止；历史统计会保留，并可恢复。`
})

async function load() {
  loading.value = true; error.value = ''
  try {
    const [detail, modelPage, catalog] = await Promise.all([
      api<ChannelDetail>(withLifecycle(`/api/v1/admin/channels/${channelId}`, 'ALL')),
      api<Page<ChannelModel>>(withLifecycle(`/api/v1/admin/channels/${channelId}/models?limit=100&offset=0`, 'ALL')),
      api<BindablePublicModel[]>('/api/v1/admin/models?lifecycle=ALL')
    ])
    channel.value = detail; models.value = modelPage; publicModels.value = catalog
    Object.assign(settings, { name: detail.name, provider: detail.provider, protocol: detail.protocol, baseUrl: detail.baseUrl,
      modelDiscoveryUrl: detail.modelDiscoveryUrl || '',
      costTimezone: detail.costTimezone, priority: detail.priority, weight: detail.weight, timeoutMs: detail.timeoutMs,
      maxRetries: detail.maxRetries, keySelection: detail.keySelection, autoDisable: detail.autoDisable })
  } catch (value: any) { error.value = value.message } finally { loading.value = false }
}
function resetModelForm() {
  editingModelId.value = ''
  modelFormError.value = nextModelFormError(modelFormError.value, { type: 'OPEN' })
  Object.assign(modelForm, { publicModelId: '', publicModelDisplayName: '', manufacturer: '', contextSize: null,
    upstreamModel: '', protocol: 'OPENAI_CHAT', supportsStream: true, supportsTools: true, probeEnabled: true, probeIntervalMinutes: 15 })
}
function openAddModel() { resetModelForm(); modelDrawer.value = true }
function openEditModel(model: ChannelModel) {
  editingModelId.value = model.id
  modelFormError.value = nextModelFormError(modelFormError.value, { type: 'OPEN' })
  const publicModel = exactPublicModelMatch(model.publicModelId, publicModels.value)
  Object.assign(modelForm, { publicModelId: model.publicModelId, publicModelDisplayName: publicModel?.displayName || model.publicModelId,
    manufacturer: publicModel?.manufacturer || suggestManufacturer(model.publicModelId, channel.value?.provider || ''),
    contextSize: publicModel?.contextSize ?? null, upstreamModel: model.upstreamModel, protocol: model.protocol,
    supportsStream: model.supportsStream, supportsTools: model.supportsTools, probeEnabled: model.probeEnabled,
    probeIntervalMinutes: model.probeIntervalMinutes })
  modelDrawer.value = true
}
async function discover() {
  try { discovered.value = await api(`/api/v1/admin/channels/${channelId}/discover-models`, { method: 'POST' }); toast(`发现 ${discovered.value.length} 个上游模型`) }
  catch (value: any) { error.value = value.message }
}
function handleUpstreamModelInput() {
  const editing = Boolean(editingModelId.value)
  const id = nextPublicModelIdForUpstreamInput(modelForm.upstreamModel, modelForm.publicModelId, editing)
  if (editing) return
  modelForm.publicModelId = id
  const match = exactPublicModelMatch(id, publicModels.value)
  if (match) {
    modelForm.publicModelDisplayName = match.displayName
    modelForm.manufacturer = match.manufacturer || ''
    modelForm.contextSize = match.contextSize
    return
  }
  modelForm.publicModelDisplayName = id
  modelForm.manufacturer = suggestManufacturer(id, channel.value?.provider || '')
  modelForm.contextSize = null
}
function chooseDiscovered(name: string) {
  resetModelForm()
  modelForm.upstreamModel = name
  handleUpstreamModelInput()
  modelDrawer.value = true
}
async function saveModel() {
  busy.value = true; modelFormError.value = ''
  try {
    const path = editingModelId.value
      ? `/api/v1/admin/channel-models/${editingModelId.value}/bind`
      : `/api/v1/admin/channels/${channelId}/models/bind`
    const result = await api<BindingResponse>(path, {
      method: editingModelId.value ? 'PATCH' : 'POST',
      body: JSON.stringify(buildModelBindingPayload(modelForm, bindingMode.value))
    })
    toast(result.publicModelCreated
      ? `已创建公共模型 ${result.publicModel.displayName} 并${editingModelId.value ? '重新绑定' : '绑定'}`
      : `渠道模型已${editingModelId.value ? '更新' : '添加'}`)
    const costNotice = costArchiveNotice(result.costRulesArchived)
    if (costNotice) toast(costNotice)
    modelFormError.value = nextModelFormError(modelFormError.value, { type: 'SUCCESS' })
    modelDrawer.value = false; await load()
  }
  catch (value: any) {
    modelFormError.value = nextModelFormError(modelFormError.value, { type: 'FAILURE', message: value?.message || '保存渠道模型失败' })
  } finally { busy.value = false }
}
async function toggleModel(model: ChannelModel) {
  try { await api(`/api/v1/admin/channel-models/${model.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !model.enabled }) }); toast(model.enabled ? '渠道模型已停用' : '渠道模型已启用'); await load() }
  catch (value: any) { error.value = value.message }
}
async function addKey() {
  if (!keyInput.value.trim()) return
  try { await api(`/api/v1/admin/channels/${channelId}/keys`, { method: 'POST', body: JSON.stringify({ key: keyInput.value }) }); keyInput.value = ''; toast('Key 已添加'); await load() }
  catch (value: any) { error.value = value.message }
}
async function toggleKey(key: any) {
  try { await api(`/api/v1/admin/channels/${channelId}/keys/${key.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !key.enabled }) }); await load() }
  catch (value: any) { error.value = value.message }
}
function localDateTime(value: string | null) {
  if (!value) return ''
  const date = new Date(value); const offset = date.getTimezoneOffset() * 60000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}
function openEditKey(key: ChannelKey) {
  editingKeyId.value = key.id
  Object.assign(keyForm, { priority: key.priority, weight: key.weight, remainingUsd: key.remainingUsd ?? '', expiresAt: localDateTime(key.expiresAt) })
  keyDrawer.value = true
}
async function saveKey() {
  busy.value = true; error.value = ''
  try {
    await api(`/api/v1/admin/channels/${channelId}/keys/${editingKeyId.value}`, { method: 'PATCH', body: JSON.stringify({
      priority: Number(keyForm.priority), weight: Number(keyForm.weight), remainingUsd: keyForm.remainingUsd.trim() || null,
      expiresAt: keyForm.expiresAt ? new Date(keyForm.expiresAt).toISOString() : null
    }) })
    keyDrawer.value = false; toast('Key 设置已更新'); await load()
  } catch (value: any) { error.value = value.message } finally { busy.value = false }
}
async function saveSettings() {
  try { await api(`/api/v1/admin/channels/${channelId}`, {
    method: 'PATCH', body: JSON.stringify({ ...settings, modelDiscoveryUrl: settings.modelDiscoveryUrl.trim() || null })
  }); toast('渠道设置已保存'); await load() }
  catch (value: any) { error.value = value.message }
}
async function loadProbes(modelId: string) {
  probeModelId.value = modelId
  try { probes.value = await api(`/api/v1/admin/channel-models/${modelId}/probes?limit=50&offset=0`) }
  catch (value: any) { error.value = value.message }
}
async function testModel(modelId: string) {
  testingModelId.value = modelId; error.value = ''
  try {
    const result = await api<ModelTestResult>(`/api/v1/admin/channel-models/${modelId}/test`, { method: 'POST' })
    toast(result.ok ? `测试成功 · ${result.latencyMs}ms` : `测试失败 · ${result.errorCode || result.statusCode}`)
    await load()
  } catch (value: any) { error.value = value.message } finally { testingModelId.value = '' }
}
async function testAllModels() {
  batchTesting.value = true; error.value = ''
  try {
    const results = await api<ModelTestResult[]>(`/api/v1/admin/channels/${channelId}/models/test-batch`, {
      method: 'POST', body: JSON.stringify({ channelModelIds: visibleModels.value.slice(0, 20).map(model => model.id) })
    })
    toast(`测试完成：${results.filter(item => item.ok).length}/${results.length} 成功`)
    await load()
  } catch (value: any) { error.value = value.message } finally { batchTesting.value = false }
}
async function confirmArchive() {
  const target = pendingArchive.value
  if (!target) return
  pendingArchive.value = null; error.value = ''
  try {
    if (target.type === 'channel') {
      await api(`/api/v1/admin/channels/${channelId}`, { method: 'DELETE' })
      toast('渠道已删除，可在“已归档”中恢复')
      await router.push({ path: '/channels', query: { lifecycle: 'ARCHIVED' } }); return
    }
    const path = target.type === 'key' ? `/api/v1/admin/channels/${channelId}/keys/${target.id}`
      : `/api/v1/admin/channel-models/${target.id}`
    await api(path, { method: 'DELETE' })
    toast(`${target.type === 'key' ? 'Key' : '渠道模型'}已删除，可恢复`)
    await load()
  } catch (value: any) { error.value = value.message }
}
async function restoreChannel() {
  try { await api(`/api/v1/admin/channels/${channelId}/restore`, { method: 'POST' }); toast('渠道已恢复并保持停用，请逐项恢复配置并测试后启用'); await load() }
  catch (value: any) { error.value = value.message }
}
async function restoreKey(key: ChannelKey) {
  try { await api(`/api/v1/admin/channels/${channelId}/keys/${key.id}/restore`, { method: 'POST' }); toast('Key 已恢复并保持停用'); await load() }
  catch (value: any) { error.value = value.message }
}
async function restoreModel(model: ChannelModel) {
  try { await api(`/api/v1/admin/channel-models/${model.id}/restore`, { method: 'POST' }); toast('渠道模型已恢复并保持停用'); await load() }
  catch (value: any) { error.value = value.message }
}
onMounted(load)
</script>

<template>
  <header class="page-header"><div><button class="back-link" @click="router.push({ path: '/channels', query: { lifecycle: isArchived ? 'ARCHIVED' : 'ACTIVE' } })">← 返回渠道</button><p>CHANNEL DETAIL</p><h1>{{ channel?.name || '渠道详情' }}</h1><span v-if="channel" class="subtitle">{{ channel.provider }} · {{ channel.baseUrl }}</span></div>
    <div v-if="channel" class="actions"><StatusBadge :status="channel.enabled ? channel.health : 'DISABLED'" /><button @click="load">刷新</button><button v-if="isArchived" class="primary" @click="restoreChannel">恢复渠道</button><button v-else class="danger-link" @click="pendingArchive = { type: 'channel', id: channel.id, name: channel.name }">删除渠道</button></div></header>
  <p v-if="loading" class="state">正在加载…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <template v-if="channel && !loading"><div v-if="isArchived" class="warning-panel"><strong>该渠道已归档</strong><span>不会参与路由、测试、模型发现或自动探测。恢复后仍保持停用，子配置需要逐项恢复。</span></div><div class="tabs"><button v-for="item in [['overview','概览'],['models','渠道模型'],['keys','Key'],['health','健康记录'],['settings','设置']]" :key="item[0]" :class="{ active: tab === item[0] }" @click="tab = item[0]">{{ item[1] }}</button></div>
    <section v-if="tab === 'overview'" class="detail-grid"><article class="panel metric-block"><span>渠道状态</span><StatusBadge :status="channel.health" /><small>最近成功：{{ channel.lastSuccessAt ? new Date(channel.lastSuccessAt).toLocaleString() : '—' }}</small></article><article class="panel metric-block"><span>渠道模型</span><strong>{{ models.total }}</strong><small>{{ models.items.filter(m => m.health === 'HEALTHY').length }} 个健康</small></article><article class="panel metric-block"><span>可用 Key</span><strong>{{ channel.keys.filter(k => k.enabled).length }}</strong><small>共 {{ channel.keys.length }} 个</small></article><article class="panel metric-block"><span>成本时区</span><strong class="small-strong">{{ channel.costTimezone }}</strong><small>峰谷规则按此时区匹配</small></article></section>

    <section v-else-if="tab === 'models'" class="panel"><div class="section-header"><div><h2>渠道模型</h2><p class="muted">维护这个渠道提供的上游模型、协议能力、健康和采购成本。没有命中渠道分时价格时，自动使用公共模型兜底价。</p><div class="tabs"><button :class="{ active: modelLifecycle === 'ACTIVE' }" @click="modelLifecycle = 'ACTIVE'">使用中</button><button :class="{ active: modelLifecycle === 'ARCHIVED' }" @click="modelLifecycle = 'ARCHIVED'">已归档</button></div></div><div class="actions"><button :disabled="isArchived || batchTesting || !visibleModels.length || modelLifecycle === 'ARCHIVED'" @click="testAllModels">{{ batchTesting ? '测试中…' : '全部测试' }}</button><button :disabled="isArchived" @click="discover">从上游发现</button><button class="primary" :disabled="isArchived" @click="openAddModel">添加模型</button></div></div>
      <div v-if="discovered.length" class="discovery-list"><button v-for="item in discovered" :key="item.upstreamModel" :disabled="item.alreadyMapped" @click="chooseDiscovered(item.upstreamModel)">{{ item.upstreamModel }} {{ item.alreadyMapped ? '· 已映射' : '· 添加' }}</button></div>
<table v-if="visibleModels.length"><thead><tr><th>公共模型</th><th>上游模型 / 协议</th><th>能力</th><th>健康</th><th>当前生效价格</th><th>操作</th></tr></thead><tbody><tr v-for="model in visibleModels" :key="model.id"><td><strong>{{ model.publicModelId }}</strong><small>{{ model.deletedAt ? '已归档' : model.enabled ? '参与路由' : '已停用' }}</small></td><td><span class="mono">{{ model.upstreamModel }}</span><small>{{ model.protocol }}</small></td><td><span class="chip">{{ model.supportsStream ? '流式' : '非流式' }}</span> <span v-if="model.supportsTools" class="chip">工具</span></td><td><StatusBadge :status="model.health" /><small>{{ model.lastTestedAt ? new Date(model.lastTestedAt).toLocaleString() : '尚未测试' }}</small></td><td><strong>{{ effectiveChannelCost(model.currentCost).priceLabel }}</strong><small>{{ effectiveChannelCost(model.currentCost).sourceLabel }} · {{ model.costRules.length }} 条渠道规则 · {{ model.costTimezone }}</small></td><td><div class="actions"><template v-if="model.deletedAt"><button class="primary" :disabled="isArchived" @click="restoreModel(model)">恢复</button></template><template v-else><button :disabled="isArchived || testingModelId === model.id" @click="testModel(model.id)">{{ testingModelId === model.id ? '测试中…' : '测试' }}</button><button :disabled="isArchived" @click="openEditModel(model)">编辑</button><button :disabled="isArchived" @click="toggleModel(model)">{{ model.enabled ? '停用' : '启用' }}</button><button :disabled="isArchived" @click="router.push(procurementCostRoute({ channelId, channelModelId: model.id, publicModelId: model.publicModelId }))">采购成本</button><button class="danger-link" :disabled="isArchived" @click="pendingArchive = { type: 'model', id: model.id, name: `${model.publicModelId} → ${model.upstreamModel}` }">删除</button></template></div></td></tr></tbody></table><p v-else class="empty">{{ modelLifecycle === 'ARCHIVED' ? '没有已归档的渠道模型' : '尚未配置渠道模型' }}</p></section>

<section v-else-if="tab === 'keys'" class="panel"><div class="section-header"><div><h2>API Keys</h2><p class="muted">密钥只显示后四位，密文不会返回浏览器。</p><div class="tabs"><button :class="{ active: keyLifecycle === 'ACTIVE' }" @click="keyLifecycle = 'ACTIVE'">使用中</button><button :class="{ active: keyLifecycle === 'ARCHIVED' }" @click="keyLifecycle = 'ARCHIVED'">已归档</button></div></div><div class="inline"><input v-model="keyInput" :disabled="isArchived" type="password" placeholder="粘贴新 API Key"><button class="primary" :disabled="isArchived" @click="addKey">添加 Key</button></div></div><table v-if="visibleKeys.length"><thead><tr><th>Key</th><th>健康</th><th>优先级 / 权重</th><th>余额 / 到期</th><th>最近使用</th><th>操作</th></tr></thead><tbody><tr v-for="key in visibleKeys" :key="key.id"><td class="mono">••••{{ key.suffix }}<small v-if="key.deletedAt">已归档</small></td><td><StatusBadge :status="key.enabled ? key.health : 'DISABLED'" /></td><td>{{ key.priority }} / {{ key.weight }}</td><td>{{ formatCny(key.remainingUsd) }} / {{ key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : '长期' }}</td><td>{{ key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : '—' }}</td><td><div class="actions"><template v-if="key.deletedAt"><button class="primary" :disabled="isArchived" @click="restoreKey(key)">恢复</button></template><template v-else><button :disabled="isArchived" @click="openEditKey(key)">编辑</button><button :disabled="isArchived" @click="toggleKey(key)">{{ key.enabled ? '停用' : '启用' }}</button><button class="danger-link" :disabled="isArchived" @click="pendingArchive = { type: 'key', id: key.id, name: key.suffix }">删除</button></template></div></td></tr></tbody></table><p v-else class="empty">{{ keyLifecycle === 'ARCHIVED' ? '没有已归档的 Key' : '尚未添加 Key' }}</p></section>

    <section v-else-if="tab === 'health'" class="panel"><div class="section-header"><div><h2>模型健康记录</h2><p class="muted">选择渠道模型查看最近探测结果。</p></div><select v-model="probeModelId" :disabled="isArchived" @change="loadProbes(probeModelId)"><option value="">选择渠道模型</option><option v-for="model in models.items.filter(item => !item.deletedAt)" :key="model.id" :value="model.id">{{ model.publicModelId }} → {{ model.upstreamModel }}</option></select></div><table v-if="probes.items.length"><thead><tr><th>时间</th><th>来源</th><th>状态</th><th>HTTP</th><th>延迟 / 首字</th><th>错误</th></tr></thead><tbody><tr v-for="probe in probes.items" :key="probe.id"><td>{{ new Date(probe.testedAt).toLocaleString() }}</td><td>{{ probe.source }}</td><td><StatusBadge :status="probe.health" /></td><td>{{ probe.statusCode ?? '—' }}</td><td>{{ probe.latencyMs }} / {{ probe.firstTokenMs ?? '—' }} ms</td><td>{{ probe.errorCode || '—' }}</td></tr></tbody></table><p v-else class="empty">选择模型后查看探测记录</p></section>

    <section v-else class="panel"><h2>渠道设置</h2><fieldset :disabled="isArchived"><div class="stack-form two-column"><label>名称<input v-model="settings.name"></label><label>供应商<input v-model="settings.provider"></label><label>协议<select v-model="settings.protocol"><option>OPENAI</option><option>ANTHROPIC</option><option>GEMINI</option></select></label><label>Base URL<input v-model="settings.baseUrl"></label><label>成本时区<input v-model="settings.costTimezone"></label><label>Key 策略<select v-model="settings.keySelection"><option value="WEIGHTED_RANDOM">加权随机</option><option value="ROUND_ROBIN">轮询</option></select></label><label>优先级<input v-model.number="settings.priority" type="number"></label><label>权重<input v-model.number="settings.weight" type="number"></label><label>超时 ms<input v-model.number="settings.timeoutMs" type="number"></label><label>重试次数<input v-model.number="settings.maxRetries" type="number"></label></div><details><summary>高级设置</summary><div class="stack-form"><label>模型发现 URL（可选）<input v-model="settings.modelDiscoveryUrl" placeholder="https://api.example.com/v1/models"><small class="muted">填写完整地址后，“从上游发现”将优先请求该 URL；留空使用协议默认地址。</small></label></div></details><button class="primary" :disabled="isArchived" @click="saveSettings">保存设置</button></fieldset></section>
  </template>

  <Drawer :open="modelDrawer" :title="editingModelId ? '编辑渠道模型' : '添加渠道模型'" width="640px" @close="modelDrawer = false">
    <div class="stack-form">
      <label>上游模型 ID<input v-model="modelForm.upstreamModel" placeholder="例如 deepseek-chat" @input="handleUpstreamModelInput"></label>
      <p v-if="modelFormError" class="error binding-form-error">{{ modelFormError }}</p>
      <div v-if="modelForm.publicModelId.trim() && matchedPublicModel" class="binding-result matched">
        <strong>已匹配平台模型</strong>
        <span>{{ matchedPublicModel.displayName }} · {{ matchedPublicModel.id }}</span>
        <small>{{ matchedPublicModel.manufacturer || '未分类' }}</small>
      </div>
      <div v-else-if="modelForm.publicModelId.trim() && archivedPublicModel" class="binding-result archived">
        <strong>平台模型已归档</strong>
        <span>{{ archivedPublicModel.displayName }} · {{ archivedPublicModel.id }}</span>
        <small>请先到模型模块恢复该模型，再返回绑定；系统不会创建重复 ID。</small>
      </div>
      <div v-else-if="modelForm.publicModelId.trim()" class="binding-result creating">
        <strong>平台中不存在该模型</strong>
        <span>保存时将先创建公共模型，再绑定到当前渠道。</span>
      </div>

      <label v-if="matchedPublicModel">绑定平台模型
        <select v-model="modelForm.publicModelId">
          <option v-for="model in publicModels.filter(item => !item.deletedAt)" :key="model.id" :value="model.id">
            {{ model.displayName }} · {{ model.id }} · {{ model.manufacturer || '未分类' }}
          </option>
        </select>
        <small class="muted">可选择其他现有模型完成重新绑定。</small>
      </label>
      <template v-else-if="modelForm.publicModelId.trim() && !archivedPublicModel">
        <label>平台模型 ID<input v-model="modelForm.publicModelId" placeholder="默认与上游模型 ID 相同"></label>
        <label>显示名称<input v-model="modelForm.publicModelDisplayName" placeholder="例如 DeepSeek Chat"></label>
        <label>模型厂家<input v-model="modelForm.manufacturer" placeholder="例如 DeepSeek"></label>
        <label>上下文长度（可选）<input v-model.number="modelForm.contextSize" type="number" min="1" placeholder="例如 64000"></label>
      </template>

      <label>协议<select v-model="modelForm.protocol"><option>OPENAI_CHAT</option><option>OPENAI_RESPONSES</option><option>ANTHROPIC_MESSAGES</option><option>GEMINI</option></select></label>
      <label class="check-row"><input v-model="modelForm.supportsStream" type="checkbox">支持流式</label>
      <label class="check-row"><input v-model="modelForm.supportsTools" type="checkbox">支持工具</label>
      <label class="check-row"><input v-model="modelForm.probeEnabled" type="checkbox">启用自动探测</label>
      <label>自动探测间隔（分钟）<input v-model.number="modelForm.probeIntervalMinutes" type="number" min="5"></label>
    </div>
    <template #footer><button @click="modelDrawer = false">取消</button><button class="primary" :disabled="modelSaveDisabled" @click="saveModel">{{ editingModelId ? '保存修改' : '添加模型' }}</button></template>
  </Drawer>
  <Drawer :open="keyDrawer" title="编辑 Key 设置" @close="keyDrawer = false"><div class="stack-form"><p class="muted">不会显示或回填明文 Key。</p><label>优先级<input v-model.number="keyForm.priority" type="number"></label><label>权重<input v-model.number="keyForm.weight" type="number" min="1"></label><label>剩余采购余额（CNY，可选）<input v-model="keyForm.remainingUsd" inputmode="decimal" placeholder="留空表示未知"></label><label>到期时间（可选）<input v-model="keyForm.expiresAt" type="datetime-local"></label></div><template #footer><button @click="keyDrawer = false">取消</button><button class="primary" :disabled="busy || isArchived" @click="saveKey">保存修改</button></template></Drawer>
  <ConfirmDialog :open="Boolean(pendingArchive)" :title="pendingArchive?.type === 'channel' ? '删除渠道' : pendingArchive?.type === 'key' ? '删除 Key' : '删除渠道模型'" :message="archiveMessage" confirm-label="确认删除" danger @confirm="confirmArchive" @cancel="pendingArchive = null" />
</template>

<style scoped>
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
fieldset:disabled { opacity: .65; }
.binding-result { display: grid; gap: 4px; padding: 12px 14px; border: 1px solid #29445c; border-radius: 8px; background: #0a1420; }
.binding-result span, .binding-result small { color: #8293aa; }
.binding-result.matched strong { color: #76e6c8; }
.binding-result.creating strong { color: #f8c66a; }
.binding-result.archived strong { color: #ff9d8f; }
.binding-form-error { margin: 0; }
</style>
