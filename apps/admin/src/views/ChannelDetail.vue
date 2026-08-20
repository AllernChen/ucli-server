<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { toast } from '../toast'
import type { ChannelDetail, ChannelModel, CostRule, ModelProbe, ModelTestResult, Page, PublicModel } from '../types/catalog'
import StatusBadge from '../components/StatusBadge.vue'
import Drawer from '../components/Drawer.vue'
import CostScheduleEditor from '../components/CostScheduleEditor.vue'

const route = useRoute(); const router = useRouter(); const channelId = String(route.params.id)
const loading = ref(true); const error = ref(''); const tab = ref('overview')
const channel = ref<ChannelDetail | null>(null)
const models = ref<Page<ChannelModel>>({ items: [], total: 0, limit: 100, offset: 0 })
const publicModels = ref<PublicModel[]>([])
const modelDrawer = ref(false); const costModelId = ref(''); const costDrawer = ref(false); const busy = ref(false)
const testingModelId = ref(''); const batchTesting = ref(false)
const discovered = ref<Array<{ upstreamModel: string; alreadyMapped: boolean }>>([])
const probes = ref<Page<ModelProbe>>({ items: [], total: 0, limit: 50, offset: 0 }); const probeModelId = ref('')
const keyInput = ref('')
const modelForm = reactive({ publicModelId: '', upstreamModel: '', protocol: 'OPENAI_CHAT', supportsStream: true, supportsTools: true, probeEnabled: true, probeIntervalMinutes: 15 })
const settings = reactive({ name: '', provider: '', protocol: 'OPENAI', baseUrl: '', costTimezone: 'UTC', priority: 0, weight: 1, timeoutMs: 300000, maxRetries: 1, keySelection: 'WEIGHTED_RANDOM', autoDisable: true })
const selectedCostModel = computed(() => models.value.items.find(model => model.id === costModelId.value))

async function load() {
  loading.value = true; error.value = ''
  try {
    const [detail, modelPage, catalog] = await Promise.all([
      api<ChannelDetail>(`/api/v1/admin/channels/${channelId}`),
      api<Page<ChannelModel>>(`/api/v1/admin/channels/${channelId}/models?limit=100&offset=0`),
      api<PublicModel[]>('/api/v1/admin/models')
    ])
    channel.value = detail; models.value = modelPage; publicModels.value = catalog
    Object.assign(settings, { name: detail.name, provider: detail.provider, protocol: detail.protocol, baseUrl: detail.baseUrl,
      costTimezone: detail.costTimezone, priority: detail.priority, weight: detail.weight, timeoutMs: detail.timeoutMs,
      maxRetries: detail.maxRetries, keySelection: detail.keySelection, autoDisable: detail.autoDisable })
    if (!modelForm.publicModelId) modelForm.publicModelId = catalog[0]?.id || ''
  } catch (value: any) { error.value = value.message } finally { loading.value = false }
}
async function discover() {
  try { discovered.value = await api(`/api/v1/admin/channels/${channelId}/discover-models`, { method: 'POST' }); toast(`发现 ${discovered.value.length} 个上游模型`) }
  catch (value: any) { error.value = value.message }
}
function chooseDiscovered(name: string) { modelForm.upstreamModel = name; modelDrawer.value = true }
async function addModel() {
  busy.value = true
  try { await api(`/api/v1/admin/channels/${channelId}/models`, { method: 'POST', body: JSON.stringify(modelForm) }); modelDrawer.value = false; toast('渠道模型已添加'); await load() }
  catch (value: any) { error.value = value.message } finally { busy.value = false }
}
async function removeModel(id: string) {
  if (!window.confirm('确认停用或删除这个渠道模型？历史用量不会被删除。')) return
  try { await api(`/api/v1/admin/channel-models/${id}`, { method: 'DELETE' }); toast('渠道模型已移除'); await load() }
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
function openCosts(model: ChannelModel) { costModelId.value = model.id; costDrawer.value = true }
async function saveCost(rule: any) {
  busy.value = true
  try { await api(`/api/v1/admin/channel-models/${costModelId.value}/cost-rules`, { method: 'POST', body: JSON.stringify(rule) }); toast('采购成本规则已添加'); await load() }
  catch (value: any) { error.value = value.message } finally { busy.value = false }
}
async function removeCost(id: string) {
  try { await api(`/api/v1/admin/channel-model-cost-rules/${id}`, { method: 'DELETE' }); toast('成本规则已停用'); await load() }
  catch (value: any) { error.value = value.message }
}
async function saveSettings() {
  try { await api(`/api/v1/admin/channels/${channelId}`, { method: 'PATCH', body: JSON.stringify(settings) }); toast('渠道设置已保存'); await load() }
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
      method: 'POST', body: JSON.stringify({ channelModelIds: models.value.items.slice(0, 20).map(model => model.id) })
    })
    toast(`测试完成：${results.filter(item => item.ok).length}/${results.length} 成功`)
    await load()
  } catch (value: any) { error.value = value.message } finally { batchTesting.value = false }
}
onMounted(load)
</script>

<template>
  <header class="page-header"><div><button class="back-link" @click="router.push('/channels')">← 返回渠道</button><p>CHANNEL DETAIL</p><h1>{{ channel?.name || '渠道详情' }}</h1><span v-if="channel" class="subtitle">{{ channel.provider }} · {{ channel.baseUrl }}</span></div>
    <div v-if="channel" class="actions"><StatusBadge :status="channel.enabled ? channel.health : 'DISABLED'" /><button @click="load">刷新</button></div></header>
  <p v-if="loading" class="state">正在加载…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <template v-if="channel && !loading"><div class="tabs"><button v-for="item in [['overview','概览'],['models','渠道模型'],['keys','Key'],['health','健康记录'],['settings','设置']]" :key="item[0]" :class="{ active: tab === item[0] }" @click="tab = item[0]">{{ item[1] }}</button></div>
    <section v-if="tab === 'overview'" class="detail-grid"><article class="panel metric-block"><span>渠道状态</span><StatusBadge :status="channel.health" /><small>最近成功：{{ channel.lastSuccessAt ? new Date(channel.lastSuccessAt).toLocaleString() : '—' }}</small></article><article class="panel metric-block"><span>渠道模型</span><strong>{{ models.total }}</strong><small>{{ models.items.filter(m => m.health === 'HEALTHY').length }} 个健康</small></article><article class="panel metric-block"><span>可用 Key</span><strong>{{ channel.keys.filter(k => k.enabled).length }}</strong><small>共 {{ channel.keys.length }} 个</small></article><article class="panel metric-block"><span>成本时区</span><strong class="small-strong">{{ channel.costTimezone }}</strong><small>峰谷规则按此时区匹配</small></article></section>

    <section v-else-if="tab === 'models'" class="panel"><div class="section-header"><div><h2>渠道模型</h2><p class="muted">维护这个渠道提供的上游模型、协议能力、健康和采购成本。</p></div><div class="actions"><button :disabled="batchTesting || !models.items.length" @click="testAllModels">{{ batchTesting ? '测试中…' : '全部测试' }}</button><button @click="discover">从上游发现</button><button class="primary" @click="modelDrawer = true">添加模型</button></div></div>
      <div v-if="discovered.length" class="discovery-list"><button v-for="item in discovered" :key="item.upstreamModel" :disabled="item.alreadyMapped" @click="chooseDiscovered(item.upstreamModel)">{{ item.upstreamModel }} {{ item.alreadyMapped ? '· 已映射' : '· 添加' }}</button></div>
      <table v-if="models.items.length"><thead><tr><th>公共模型</th><th>上游模型 / 协议</th><th>能力</th><th>健康</th><th>当前成本</th><th>操作</th></tr></thead><tbody><tr v-for="model in models.items" :key="model.id"><td><strong>{{ model.publicModelId }}</strong><small>{{ model.enabled ? '参与路由' : '已停用' }}</small></td><td><span class="mono">{{ model.upstreamModel }}</span><small>{{ model.protocol }}</small></td><td><span class="chip">{{ model.supportsStream ? '流式' : '非流式' }}</span> <span v-if="model.supportsTools" class="chip">工具</span></td><td><StatusBadge :status="model.health" /><small>{{ model.lastTestedAt ? new Date(model.lastTestedAt).toLocaleString() : '尚未测试' }}</small></td><td><strong v-if="model.costRules[0]">in ${{ model.costRules[0].inputPerMillion }} / out ${{ model.costRules[0].outputPerMillion }}</strong><small>{{ model.costRules.length }} 条规则</small></td><td><div class="actions"><button :disabled="testingModelId === model.id" @click="testModel(model.id)">{{ testingModelId === model.id ? '测试中…' : '测试' }}</button><button @click="openCosts(model)">成本</button><button class="danger-link" @click="removeModel(model.id)">移除</button></div></td></tr></tbody></table><p v-else class="empty">尚未配置渠道模型</p></section>

    <section v-else-if="tab === 'keys'" class="panel"><div class="section-header"><div><h2>API Keys</h2><p class="muted">密钥只显示后四位，密文不会返回浏览器。</p></div><div class="inline"><input v-model="keyInput" type="password" placeholder="粘贴新 API Key"><button class="primary" @click="addKey">添加 Key</button></div></div><table v-if="channel.keys.length"><thead><tr><th>Key</th><th>健康</th><th>优先级 / 权重</th><th>余额 / 到期</th><th>最近使用</th><th>操作</th></tr></thead><tbody><tr v-for="key in channel.keys" :key="key.id"><td class="mono">••••{{ key.suffix }}</td><td><StatusBadge :status="key.enabled ? key.health : 'DISABLED'" /></td><td>{{ key.priority }} / {{ key.weight }}</td><td>{{ key.remainingUsd ?? '—' }} / {{ key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : '长期' }}</td><td>{{ key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : '—' }}</td><td><button @click="toggleKey(key)">{{ key.enabled ? '停用' : '启用' }}</button></td></tr></tbody></table></section>

    <section v-else-if="tab === 'health'" class="panel"><div class="section-header"><div><h2>模型健康记录</h2><p class="muted">选择渠道模型查看最近探测结果。</p></div><select v-model="probeModelId" @change="loadProbes(probeModelId)"><option value="">选择渠道模型</option><option v-for="model in models.items" :key="model.id" :value="model.id">{{ model.publicModelId }} → {{ model.upstreamModel }}</option></select></div><table v-if="probes.items.length"><thead><tr><th>时间</th><th>来源</th><th>状态</th><th>HTTP</th><th>延迟 / 首字</th><th>错误</th></tr></thead><tbody><tr v-for="probe in probes.items" :key="probe.id"><td>{{ new Date(probe.testedAt).toLocaleString() }}</td><td>{{ probe.source }}</td><td><StatusBadge :status="probe.health" /></td><td>{{ probe.statusCode ?? '—' }}</td><td>{{ probe.latencyMs }} / {{ probe.firstTokenMs ?? '—' }} ms</td><td>{{ probe.errorCode || '—' }}</td></tr></tbody></table><p v-else class="empty">选择模型后查看探测记录</p></section>

    <section v-else class="panel"><h2>渠道设置</h2><div class="stack-form two-column"><label>名称<input v-model="settings.name"></label><label>供应商<input v-model="settings.provider"></label><label>协议<select v-model="settings.protocol"><option>OPENAI</option><option>ANTHROPIC</option><option>GEMINI</option></select></label><label>Base URL<input v-model="settings.baseUrl"></label><label>成本时区<input v-model="settings.costTimezone"></label><label>Key 策略<select v-model="settings.keySelection"><option value="WEIGHTED_RANDOM">加权随机</option><option value="ROUND_ROBIN">轮询</option></select></label><label>优先级<input v-model.number="settings.priority" type="number"></label><label>权重<input v-model.number="settings.weight" type="number"></label><label>超时 ms<input v-model.number="settings.timeoutMs" type="number"></label><label>重试次数<input v-model.number="settings.maxRetries" type="number"></label></div><button class="primary" @click="saveSettings">保存设置</button></section>
  </template>

  <Drawer :open="modelDrawer" title="添加渠道模型" @close="modelDrawer = false"><div class="stack-form"><label>公共模型<select v-model="modelForm.publicModelId"><option v-for="model in publicModels" :key="model.id" :value="model.id">{{ model.displayName }} · {{ model.id }}</option></select></label><label>上游模型名<input v-model="modelForm.upstreamModel"></label><label>协议<select v-model="modelForm.protocol"><option>OPENAI_CHAT</option><option>OPENAI_RESPONSES</option><option>ANTHROPIC_MESSAGES</option><option>GEMINI</option></select></label><label class="check-row"><input v-model="modelForm.supportsStream" type="checkbox">支持流式</label><label class="check-row"><input v-model="modelForm.supportsTools" type="checkbox">支持工具</label><label>自动探测间隔（分钟）<input v-model.number="modelForm.probeIntervalMinutes" type="number" min="5"></label></div><template #footer><button @click="modelDrawer = false">取消</button><button class="primary" :disabled="busy" @click="addModel">添加模型</button></template></Drawer>
  <Drawer :open="costDrawer" :title="`${selectedCostModel?.publicModelId || ''} · 采购成本`" width="880px" @close="costDrawer = false"><CostScheduleEditor :rules="selectedCostModel?.costRules || []" :timezone="channel?.costTimezone || 'UTC'" :busy="busy" @save="saveCost" @remove="removeCost" /></Drawer>
</template>
