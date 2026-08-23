<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { toast } from '../toast'
import { groupModelsByManufacturer } from '../model-groups'
import { formatCny } from '../currency'
import type { CatalogLifecycle, PublicModel } from '../types/catalog'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import Drawer from '../components/Drawer.vue'
import StatusBadge from '../components/StatusBadge.vue'

const route = useRoute()
const router = useRouter()
const loading = ref(true)
const error = ref('')
const models = ref<PublicModel[]>([])
const q = ref('')
const lifecycle = ref<CatalogLifecycle>(route.query.lifecycle === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE')
const drawerOpen = ref(false)
const editingId = ref('')
const pendingArchive = ref<PublicModel | null>(null)
const formError = ref('')
const form = reactive({ id: '', displayName: '', manufacturer: '', contextSize: '' })
const visible = computed(() => models.value.filter(model => !q.value
  || `${model.id} ${model.displayName} ${model.manufacturer}`.toLowerCase().includes(q.value.toLowerCase())))
const grouped = computed(() => {
  try { return { items: groupModelsByManufacturer(visible.value), error: '' } }
  catch (value: any) { return { items: [], error: value.message || '厂家采购成本聚合失败' } }
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    models.value = await api(`/api/v1/admin/models?lifecycle=${lifecycle.value}`)
  } catch (value: any) {
    error.value = value.message
  } finally {
    loading.value = false
  }
}

async function showLifecycle(value: CatalogLifecycle) {
  lifecycle.value = value
  await router.replace({ query: { ...route.query, lifecycle: value } })
  await load()
}

function openCreate() {
  editingId.value = ''
  formError.value = ''
  Object.assign(form, { id: '', displayName: '', manufacturer: '', contextSize: '' })
  drawerOpen.value = true
}

function openEdit(model: PublicModel) {
  editingId.value = model.id
  formError.value = ''
  Object.assign(form, {
    id: model.id,
    displayName: model.displayName,
    manufacturer: model.manufacturer,
    contextSize: model.contextSize === null ? '' : String(model.contextSize)
  })
  drawerOpen.value = true
}

async function save() {
  formError.value = ''
  try {
    const body = JSON.stringify({
      ...(editingId.value ? {} : { id: form.id.trim() }),
      displayName: form.displayName.trim(),
      manufacturer: form.manufacturer.trim(),
      contextSize: form.contextSize === '' ? null : Number(form.contextSize)
    })
    await api(editingId.value
      ? `/api/v1/admin/models/${encodeURIComponent(editingId.value)}`
      : '/api/v1/admin/models', { method: editingId.value ? 'PATCH' : 'POST', body })
    formError.value = ''
    drawerOpen.value = false
    toast(editingId.value ? '公共模型已更新' : '公共模型已创建')
    if (!editingId.value && lifecycle.value === 'ARCHIVED') await showLifecycle('ACTIVE')
    else await load()
  } catch (value: any) {
    formError.value = value.message
  }
}

async function archiveModel() {
  const target = pendingArchive.value
  if (!target) return
  pendingArchive.value = null
  try {
    await api(`/api/v1/admin/models/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
    toast('公共模型已删除，可在“已归档”中恢复')
    await load()
  } catch (value: any) {
    error.value = value.message
  }
}

async function restore(model: PublicModel) {
  try {
    await api(`/api/v1/admin/models/${encodeURIComponent(model.id)}/restore`, { method: 'POST' })
    toast('公共模型已恢复为草稿，请检查供应与采购成本后再发布')
    await load()
  } catch (value: any) {
    error.value = value.message
  }
}

const health = (model: PublicModel) => model.abilities.some(item => item.enabled && item.health === 'HEALTHY')
  ? 'HEALTHY'
  : model.abilities.some(item => item.enabled && item.health === 'DEGRADED')
    ? 'DEGRADED'
    : model.abilities.length ? 'UNHEALTHY' : 'UNKNOWN'

const costRange = (model: PublicModel) => {
  const values = model.abilities.map(item => Number(item.currentCost?.inputPerMillion)).filter(Number.isFinite)
  if (!values.length) return '未配置'
  return `${formatCny(Math.min(...values))}–${formatCny(Math.max(...values))} / M 输入`
}

onMounted(load)
</script>

<template>
  <header class="page-header">
    <div><p>PUBLIC CATALOG</p><h1>公共模型目录</h1><span class="subtitle">面向员工客户端的稳定模型 ID，以及背后的渠道供应情况</span></div>
    <div class="actions"><button @click="load">刷新</button><button class="primary" @click="openCreate">创建公共模型</button></div>
  </header>
  <div class="tabs"><button :class="{ active: lifecycle === 'ACTIVE' }" @click="showLifecycle('ACTIVE')">使用中</button><button :class="{ active: lifecycle === 'ARCHIVED' }" @click="showLifecycle('ARCHIVED')">已归档</button></div>
  <section class="panel toolbar"><input v-model="q" placeholder="搜索模型 ID、名称或厂家"></section>
  <p v-if="loading" class="state">正在加载…</p><p v-else-if="error || grouped.error" class="state error">{{ error || grouped.error }}</p>
  <div v-else-if="grouped.items.length" class="manufacturer-groups">
    <section v-for="group in grouped.items" :key="group.key" class="panel table-panel manufacturer-group">
      <div class="manufacturer-summary"><div><h2>{{ group.name }}</h2><p class="muted mono">{{ group.key }}</p></div><div class="manufacturer-metrics"><span><strong>{{ group.modelCount }}</strong> 个模型</span><span><strong>{{ group.publishedCount }}</strong> 个已发布</span><span><strong>{{ group.channelModelCount }}</strong> 个渠道供应</span><span><strong>{{ group.requests24h.toLocaleString() }}</strong> 次请求</span><span><strong>{{ group.tokens24h.toLocaleString() }}</strong> Token</span><span><strong>{{ formatCny(group.costUsd24h) }}</strong> 采购成本</span></div></div>
      <table><thead><tr><th>公共模型</th><th>发布状态</th><th>渠道供应</th><th>健康</th><th>采购成本范围</th><th>近 24h 使用</th><th>上下文</th><th>操作</th></tr></thead>
      <tbody><tr v-for="model in group.models" :key="model.id" class="clickable-row" @click="router.push(`/models/${encodeURIComponent(model.id)}`)">
        <td><strong>{{ model.displayName }}</strong><small class="mono">{{ model.id }}</small></td>
        <td><span class="chip" :class="{ success: model.enabled && !model.deletedAt }">{{ model.deletedAt ? '已归档' : model.enabled ? '已发布' : '草稿' }}</span></td>
        <td><strong>{{ model.abilities.filter(item => item.enabled).length }}</strong><small>共 {{ model.abilities.length }} 个渠道模型</small></td>
        <td><StatusBadge :status="model.deletedAt ? 'DISABLED' : health(model)" /></td>
        <td>{{ costRange(model) }}</td>
        <td><strong>{{ model.usage24h.requests.toLocaleString() }} 次</strong><small>{{ model.usage24h.tokens.toLocaleString() }} Token · {{ formatCny(model.usage24h.costUsd) }}</small></td>
        <td>{{ model.contextSize?.toLocaleString() || '—' }}</td>
        <td><div class="actions" @click.stop><button @click="router.push(`/models/${encodeURIComponent(model.id)}`)">查看</button><template v-if="model.deletedAt"><button class="primary" @click="restore(model)">恢复</button></template><template v-else><button @click="openEdit(model)">编辑</button><button class="danger-link" @click="pendingArchive = model">删除</button></template></div></td>
      </tr></tbody>
    </table>
    </section>
  </div>
  <section v-else class="panel"><p class="empty">{{ lifecycle === 'ARCHIVED' ? '没有已归档的公共模型' : '没有公共模型' }}</p></section>

  <Drawer :open="drawerOpen" :title="editingId ? '编辑公共模型' : '创建公共模型'" @close="drawerOpen = false">
    <div class="stack-form"><label>模型 ID<input v-model="form.id" :disabled="Boolean(editingId)" placeholder="例如 gpt-4o"></label><label>显示名称<input v-model="form.displayName"></label><label>模型厂家<input v-model="form.manufacturer" required placeholder="例如 DeepSeek / Anthropic"></label><label>上下文长度<input v-model="form.contextSize" type="number" min="1"></label><p v-if="formError" class="state error">{{ formError }}</p></div>
    <template #footer><button @click="drawerOpen = false">取消</button><button class="primary" @click="save">{{ editingId ? '保存修改' : '创建' }}</button></template>
  </Drawer>
  <ConfirmDialog :open="Boolean(pendingArchive)" title="删除公共模型" :message="`确认删除“${pendingArchive?.displayName || ''}”？模型将从员工目录下线，渠道映射和兜底采购成本会一并归档；历史用量与采购成本统计不受影响。`" confirm-label="删除模型" danger @confirm="archiveModel" @cancel="pendingArchive = null" />
</template>

<style scoped>
.manufacturer-groups { display: grid; gap: 18px; }
.manufacturer-group { padding-top: 18px; }
.manufacturer-summary { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; padding: 0 4px 16px; }
.manufacturer-summary h2, .manufacturer-summary p { margin: 0 0 5px; }
.manufacturer-metrics { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 18px; color: #8293aa; font-size: 12px; }
.manufacturer-metrics strong { color: #e7ecf4; margin-right: 3px; }
@media(max-width:900px) { .manufacturer-summary { flex-direction: column; } .manufacturer-metrics { justify-content: flex-start; } }
</style>
