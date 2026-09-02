<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { toast } from '../toast'
import { formatCny, PLATFORM_CURRENCY } from '../currency'
import { effectiveChannelCost, scheduledCostLabel } from '../model-cost-alignment'
import { procurementCostRoute } from '../procurement-costs'
import type { ChannelSummary, Page, PublicModel, PublicModelPrice, PublishCheck } from '../types/catalog'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import Drawer from '../components/Drawer.vue'
import StatusBadge from '../components/StatusBadge.vue'

const route = useRoute()
const router = useRouter()
const id = String(route.params.id)
const model = ref<PublicModel | null>(null)
const channels = ref<ChannelSummary[]>([])
const check = ref<PublishCheck | null>(null)
const loading = ref(true)
const error = ref('')
const modelDrawer = ref(false)
const priceDrawer = ref(false)
const editingPriceId = ref('')
const priceLifecycle = ref<'ACTIVE' | 'ARCHIVED'>('ACTIVE')
const pendingArchive = ref<{ type: 'model' | 'price'; price?: PublicModelPrice } | null>(null)
const modelFormError = ref('')
const modelForm = reactive({ displayName: '', manufacturer: '', contextSize: '' })
const priceForm = reactive({
  inputPerMillion: '', outputPerMillion: '', cachedPerMillion: '0', reasoningPerMillion: '0',
  currency: PLATFORM_CURRENCY, validFrom: '', validUntil: ''
})
const blockers: Record<string, string> = {
  MODEL_CONTEXT_SIZE_REQUIRED: '未配置有效的上下文长度',
  NO_HEALTHY_CHANNEL_MODEL: '没有健康的渠道模型',
  NO_CURRENT_COST: '没有当前有效的采购成本',
  LATEST_TEST_FAILED: '最近一次模型测试失败'
}
const channelName = (channelId: string) => channels.value.find(channel => channel.id === channelId)?.name || channelId
const isArchived = computed(() => Boolean(model.value?.deletedAt))
const visiblePrices = computed(() => (model.value?.prices || []).filter(price => priceLifecycle.value === 'ARCHIVED'
  ? Boolean(price.deletedAt) : !price.deletedAt))
const health = computed(() => isArchived.value ? 'DISABLED'
  : model.value?.abilities.some(item => item.health === 'HEALTHY') ? 'HEALTHY'
    : model.value?.abilities.some(item => item.health === 'DEGRADED') ? 'DEGRADED' : 'UNHEALTHY')

function localDateTime(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [catalog, channelPage] = await Promise.all([
      api<PublicModel[]>('/api/v1/admin/models?lifecycle=ALL'),
      api<Page<ChannelSummary>>('/api/v1/admin/channels?limit=200&offset=0&lifecycle=ALL')
    ])
    model.value = catalog.find(item => item.id === id) || null
    channels.value = channelPage.items
    if (!model.value) throw new Error('模型不存在')
    if (!model.value.deletedAt) {
      check.value = await api(`/api/v1/admin/models/${encodeURIComponent(id)}/publish-check`, { method: 'POST' })
    } else {
      check.value = null
    }
  } catch (value: any) {
    error.value = value.message
  } finally {
    loading.value = false
  }
}

function openModelEdit() {
  if (!model.value) return
  modelFormError.value = ''
  Object.assign(modelForm, {
    displayName: model.value.displayName,
    manufacturer: model.value.manufacturer,
    contextSize: model.value.contextSize === null ? '' : String(model.value.contextSize)
  })
  modelDrawer.value = true
}

async function saveModel() {
  modelFormError.value = ''
  try {
    await api(`/api/v1/admin/models/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({
        displayName: modelForm.displayName.trim(),
        manufacturer: modelForm.manufacturer.trim(),
        contextSize: modelForm.contextSize === '' ? null : Number(modelForm.contextSize)
      })
    })
    modelFormError.value = ''
    modelDrawer.value = false
    toast('公共模型已更新')
    await load()
  } catch (value: any) {
    modelFormError.value = value.message
  }
}

async function togglePublish() {
  if (!model.value || model.value.deletedAt) return
  try {
    await api(`/api/v1/admin/models/${encodeURIComponent(id)}/${model.value.enabled ? 'unpublish' : 'publish'}`, { method: 'POST' })
    toast(model.value.enabled ? '模型已下线' : '模型已发布')
    await load()
  } catch (value: any) {
    error.value = value.message
  }
}

async function archive() {
  const target = pendingArchive.value
  if (!target) return
  pendingArchive.value = null
  try {
    if (target.type === 'model') {
      await api(`/api/v1/admin/models/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast('公共模型已删除，可恢复；历史统计不受影响')
    } else if (target.price) {
      await api(`/api/v1/admin/models/${encodeURIComponent(id)}/prices/${target.price.id}`, { method: 'DELETE' })
      toast('兜底采购成本已删除，可在“已归档”中恢复')
    }
    await load()
  } catch (value: any) {
    error.value = value.message
  }
}

async function restoreModel() {
  try {
    await api(`/api/v1/admin/models/${encodeURIComponent(id)}/restore`, { method: 'POST' })
    toast('公共模型已恢复为草稿，请逐项检查并恢复配置')
    await load()
  } catch (value: any) {
    error.value = value.message
  }
}

function openCreatePrice() {
  editingPriceId.value = ''
  Object.assign(priceForm, {
    inputPerMillion: '', outputPerMillion: '', cachedPerMillion: '0', reasoningPerMillion: '0',
    currency: PLATFORM_CURRENCY, validFrom: localDateTime(new Date().toISOString()), validUntil: ''
  })
  priceDrawer.value = true
}

function openEditPrice(price: PublicModelPrice) {
  if (price.used) {
    error.value = '该价格已产生用量记录，请新增价格版本'
    return
  }
  editingPriceId.value = price.id
  Object.assign(priceForm, {
    inputPerMillion: price.inputPerMillion,
    outputPerMillion: price.outputPerMillion,
    cachedPerMillion: price.cachedPerMillion,
    reasoningPerMillion: price.reasoningPerMillion,
    currency: price.currency,
    validFrom: localDateTime(price.validFrom),
    validUntil: localDateTime(price.validUntil)
  })
  priceDrawer.value = true
}

async function savePrice() {
  try {
    if (!priceForm.validFrom) throw new Error('请填写兜底采购成本生效时间')
    const body = JSON.stringify({
      inputPerMillion: priceForm.inputPerMillion,
      outputPerMillion: priceForm.outputPerMillion,
      cachedPerMillion: priceForm.cachedPerMillion || '0',
      reasoningPerMillion: priceForm.reasoningPerMillion || '0',
      currency: priceForm.currency,
      validFrom: new Date(priceForm.validFrom).toISOString(),
      validUntil: priceForm.validUntil ? new Date(priceForm.validUntil).toISOString() : null
    })
    await api(editingPriceId.value
      ? `/api/v1/admin/models/${encodeURIComponent(id)}/prices/${editingPriceId.value}`
      : `/api/v1/admin/models/${encodeURIComponent(id)}/prices`, {
      method: editingPriceId.value ? 'PATCH' : 'POST', body
    })
    priceDrawer.value = false
    toast(editingPriceId.value ? '兜底采购成本已更新' : '兜底采购成本已添加')
    await load()
  } catch (value: any) {
    error.value = /used|immutable|用量/i.test(value.message)
      ? '该价格已产生用量记录，请新增价格版本'
      : value.message
  }
}

async function restorePrice(price: PublicModelPrice) {
  try {
    await api(`/api/v1/admin/models/${encodeURIComponent(id)}/prices/${price.id}/restore`, { method: 'POST' })
    toast('兜底采购成本已恢复')
    await load()
  } catch (value: any) {
    error.value = value.message
  }
}

async function togglePriceEnabled(price: PublicModelPrice) {
  try {
    await api(`/api/v1/admin/models/${encodeURIComponent(id)}/prices/${price.id}/${price.enabled ? 'disable' : 'enable'}`, {
      method: 'POST'
    })
    toast(price.enabled ? '兜底采购成本已停用' : '兜底采购成本已启用')
    await load()
  } catch (value: any) {
    error.value = value.message
  }
}

onMounted(load)
</script>

<template>
  <header class="page-header"><div><button class="back-link" @click="router.push({ path: '/models', query: { lifecycle: isArchived ? 'ARCHIVED' : 'ACTIVE' } })">← 返回模型目录</button><p>MODEL DETAIL</p><h1>{{ model?.displayName || id }}</h1><span class="subtitle">{{ model?.manufacturer || '未分类' }} · <span class="mono">{{ id }}</span></span></div>
    <div v-if="model" class="actions"><StatusBadge :status="health" /><button @click="load">刷新</button><template v-if="isArchived"><button class="primary" @click="restoreModel">恢复模型</button></template><template v-else><button @click="openModelEdit">编辑</button><button :class="model.enabled ? 'danger-button' : 'primary'" :disabled="!model.enabled && !check?.ready" @click="togglePublish">{{ model.enabled ? '下线模型' : '发布模型' }}</button><button class="danger-link" @click="pendingArchive = { type: 'model' }">删除模型</button></template></div>
  </header>
  <p v-if="loading" class="state">正在加载…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <template v-if="model && !loading">
    <div v-if="isArchived" class="warning-panel"><strong>该公共模型已归档</strong><span>不会出现在员工模型目录或参与路由。恢复后为草稿，渠道映射与兜底采购成本需逐项恢复。</span></div>
    <section v-else-if="check && !check.ready" class="warning-panel"><strong>发布前需要处理</strong><span v-for="item in check.blockers" :key="item">{{ blockers[item] }}</span></section>
    <div class="detail-grid"><article class="panel metric-block"><span>发布状态</span><strong class="small-strong">{{ isArchived ? '已归档' : model.enabled ? '已发布' : '草稿' }}</strong></article><article class="panel metric-block"><span>健康渠道模型</span><strong>{{ check?.healthyChannelModels || 0 }}</strong></article><article class="panel metric-block"><span>采购成本可用</span><strong class="small-strong">{{ check?.hasCurrentCost ? '已配置' : '缺失' }}</strong></article><article class="panel metric-block"><span>上下文长度</span><strong>{{ model.contextSize?.toLocaleString() || '—' }}</strong></article></div>

    <section class="panel"><div class="section-header"><div><h2>渠道实际采购价格</h2><p class="muted">渠道分时规则优先，未命中时使用下方公共模型兜底价；完整维护统一在采购成本工作台完成。</p></div><button class="primary" @click="router.push(procurementCostRoute({ publicModelId: model.id }))">进入采购成本工作台</button></div><table v-if="model.abilities.length"><thead><tr><th>渠道</th><th>上游模型 / 协议</th><th>健康</th><th>当前生效价格</th><th>分时价格</th><th>操作</th></tr></thead><tbody><tr v-for="ability in model.abilities" :key="ability.id"><td>{{ channelName(ability.channelId) }}</td><td><span class="mono">{{ ability.upstreamModel }}</span><small>{{ ability.protocol }}</small></td><td><StatusBadge :status="ability.health" /></td><td><strong>{{ effectiveChannelCost(ability.currentCost).priceLabel }}</strong><small>{{ effectiveChannelCost(ability.currentCost).sourceLabel }} · {{ ability.costTimezone }}</small></td><td><div v-if="ability.costRules?.length" class="rule-list"><div v-for="rule in ability.costRules" :key="rule.id"><strong>{{ rule.name }} · 输入 {{ formatCny(rule.inputPerMillion) }} / 输出 {{ formatCny(rule.outputPerMillion) }} / M</strong><small>{{ scheduledCostLabel(rule, ability.costTimezone) }} · 优先级 {{ rule.priority }}{{ rule.enabled ? '' : ' · 已停用' }}</small></div></div><span v-else class="muted">未设置渠道规则</span></td><td><button @click="router.push(procurementCostRoute({ channelId: ability.channelId, channelModelId: ability.id, publicModelId: model.id }))">管理采购成本</button></td></tr></tbody></table><p v-else class="empty">尚无渠道供应映射，请前往渠道详情添加。</p></section>

    <section class="panel"><div class="section-header"><div><h2>公共模型兜底采购成本</h2><p class="muted">仅在渠道模型没有匹配采购成本规则时使用；已产生用量的版本不可编辑，以保留历史采购成本。</p><div class="tabs"><button :class="{ active: priceLifecycle === 'ACTIVE' }" @click="priceLifecycle = 'ACTIVE'">使用中</button><button :class="{ active: priceLifecycle === 'ARCHIVED' }" @click="priceLifecycle = 'ARCHIVED'">已归档</button></div></div><button class="primary" :disabled="isArchived" @click="openCreatePrice">新增采购成本版本</button></div>
      <table v-if="visiblePrices.length"><thead><tr><th>状态</th><th>有效期</th><th>输入采购成本 ¥/M</th><th>输出采购成本 ¥/M</th><th>缓存采购成本 ¥/M</th><th>推理采购成本 ¥/M</th><th>币种</th><th>操作</th></tr></thead><tbody><tr v-for="price in visiblePrices" :key="price.id"><td><StatusBadge :status="price.deletedAt ? 'ARCHIVED' : price.enabled ? 'ENABLED' : 'DISABLED'" /></td><td>{{ new Date(price.validFrom).toLocaleString() }}<small>至 {{ price.validUntil ? new Date(price.validUntil).toLocaleString() : '长期' }}</small></td><td>{{ price.inputPerMillion }}</td><td>{{ price.outputPerMillion }}</td><td>{{ price.cachedPerMillion }}</td><td>{{ price.reasoningPerMillion }}</td><td>{{ price.currency }}</td><td><div class="actions" @click.stop><template v-if="price.deletedAt"><button class="primary" :disabled="isArchived" @click="restorePrice(price)">恢复为停用</button></template><template v-else><button v-if="!price.used" :disabled="isArchived" @click="openEditPrice(price)">编辑</button><span v-else class="muted">已产生用量，不可编辑</span><button :class="price.enabled ? 'danger-button' : 'primary'" :disabled="isArchived" @click="togglePriceEnabled(price)">{{ price.enabled ? '停用' : '启用' }}</button><button class="danger-link" :disabled="isArchived" @click="pendingArchive = { type: 'price', price }">删除</button></template></div></td></tr></tbody></table><p v-else class="empty">{{ priceLifecycle === 'ARCHIVED' ? '没有已归档的兜底采购成本' : '未配置兜底采购成本' }}</p>
    </section>
  </template>

  <Drawer :open="modelDrawer" title="编辑公共模型" @close="modelDrawer = false"><div class="stack-form"><label>显示名称<input v-model="modelForm.displayName"></label><label>模型厂家<input v-model="modelForm.manufacturer" required placeholder="例如 DeepSeek / Anthropic"></label><label>上下文长度<input v-model="modelForm.contextSize" type="number" min="1"></label><p v-if="modelFormError" class="state error">{{ modelFormError }}</p></div><template #footer><button @click="modelDrawer = false">取消</button><button class="primary" @click="saveModel">保存修改</button></template></Drawer>
  <Drawer :open="priceDrawer" :title="editingPriceId ? '编辑兜底采购成本' : '新增兜底采购成本版本'" @close="priceDrawer = false"><div class="stack-form"><div class="form-row"><label>输入采购成本（CNY / M Token）<input v-model="priceForm.inputPerMillion" inputmode="decimal"></label><label>输出采购成本（CNY / M Token）<input v-model="priceForm.outputPerMillion" inputmode="decimal"></label></div><div class="form-row"><label>缓存采购成本（CNY / M Token）<input v-model="priceForm.cachedPerMillion" inputmode="decimal"></label><label>推理采购成本（CNY / M Token）<input v-model="priceForm.reasoningPerMillion" inputmode="decimal"></label></div><label>币种<input v-model="priceForm.currency" maxlength="3" readonly></label><label>生效时间<input v-model="priceForm.validFrom" type="datetime-local"></label><label>失效时间（可选）<input v-model="priceForm.validUntil" type="datetime-local"></label></div><template #footer><button @click="priceDrawer = false">取消</button><button class="primary" @click="savePrice">{{ editingPriceId ? '保存修改' : '添加版本' }}</button></template></Drawer>
  <ConfirmDialog :open="Boolean(pendingArchive)" :title="pendingArchive?.type === 'model' ? '删除公共模型' : '删除兜底采购成本'" :message="pendingArchive?.type === 'model' ? '模型将从员工目录下线，渠道映射和兜底采购成本一并归档；历史用量与采购成本统计不受影响。' : '该兜底采购成本版本将不再参与采购成本解析；历史采购成本记录会保留，并可恢复。'" confirm-label="确认删除" danger @confirm="archive" @cancel="pendingArchive = null" />
</template>
