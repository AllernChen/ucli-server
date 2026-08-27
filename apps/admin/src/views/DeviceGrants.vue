<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, deviceGrantQuery, grantActions, grantExpiryPayload, grantStatusLabel, linkStatusLabel, type DeviceGrantSummary, type DeviceGrantUserGroup, type Page } from '../device-grants'
import { toast } from '../toast'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import DeviceGrantLinkActions from '../components/DeviceGrantLinkActions.vue'
import Pagination from '../components/Pagination.vue'
import StatusBadge from '../components/StatusBadge.vue'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const editError = ref('')
const actionPending = ref(false)
const result = ref<Page<DeviceGrantUserGroup>>({ items: [], total: 0, limit: 20, offset: 0 })
const filters = reactive({ status: 'ALL', q: '', limit: 20, offset: 0 })
const editingGrant = ref<DeviceGrantSummary | null>(null)
const pendingAction = ref<{ grant: DeviceGrantSummary; action: 'disable' | 'delete' } | null>(null)
const expiryForm = reactive({ permanent: true, expiresAt: '' })
const loadLifecycle = createRequestLifecycle()

function localDateTime(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

async function load() {
  const generation = loadLifecycle.next()
  loading.value = true
  error.value = ''
  try {
    const loaded = await api<Page<DeviceGrantUserGroup>>(`/api/v1/admin/device-grants?${deviceGrantQuery(filters)}`)
    if (!loadLifecycle.isCurrent(generation)) return
    result.value = loaded
  } catch (value: any) {
    if (!loadLifecycle.isCurrent(generation)) return
    error.value = value.message
  } finally {
    if (loadLifecycle.isCurrent(generation)) loading.value = false
  }
}

function search() {
  filters.offset = 0
  load()
}

function changeStatus() {
  filters.offset = 0
  load()
}

function setOffset(offset: number) {
  filters.offset = offset
  load()
}

function openExpiry(grant: DeviceGrantSummary) {
  editError.value = ''
  expiryForm.permanent = grant.expiresAt === null
  expiryForm.expiresAt = localDateTime(grant.expiresAt)
  editingGrant.value = grant
}

function closeExpiry() {
  editingGrant.value = null
  editError.value = ''
}

async function saveExpiry() {
  const grant = editingGrant.value
  if (!grant) return
  editError.value = ''
  actionPending.value = true
  try {
    await api(`/api/v1/admin/device-grants/${grant.id}`, {
      method: 'PATCH', body: JSON.stringify(grantExpiryPayload(expiryForm))
    })
    closeExpiry()
    toast('授权有效期已更新')
    await load()
  } catch (value: any) {
    editError.value = value.message
  } finally {
    actionPending.value = false
  }
}

async function confirmAction() {
  const target = pendingAction.value
  if (!target) return
  pendingAction.value = null
  actionPending.value = true
  try {
    if (target.action === 'disable') {
      await api(`/api/v1/admin/device-grants/${target.grant.id}/disable`, { method: 'POST' })
      toast('授权已禁用；重新启用后设备可恢复')
    } else {
      await api(`/api/v1/admin/device-grants/${target.grant.id}`, { method: 'DELETE' })
      toast('授权已删除，关联设备已永久撤销')
    }
    await load()
  } catch (value: any) {
    error.value = value.message
  } finally {
    actionPending.value = false
  }
}

async function enable(grant: DeviceGrantSummary) {
  actionPending.value = true
  try {
    await api(`/api/v1/admin/device-grants/${grant.id}/enable`, { method: 'POST' })
    toast('授权已启用；如仍过期，请先修改有效期')
    await load()
  } catch (value: any) {
    error.value = value.message
  } finally {
    actionPending.value = false
  }
}

onMounted(load)
onUnmounted(() => loadLifecycle.dispose())
</script>

<template>
  <header class="page-header"><div><p>DEVICE GRANTS</p><h1>授权令牌</h1><span class="subtitle">按用户聚合管理设备授权；列表分页单位为用户。</span></div><button type="button" @click="load">刷新</button></header>
  <form class="panel grant-toolbar" @submit.prevent="search"><input v-model="filters.q" aria-label="搜索授权用户" placeholder="搜索邮箱或显示名"><select v-model="filters.status" aria-label="授权状态" @change="changeStatus"><option value="ALL">全部未删除</option><option value="AVAILABLE">待绑定</option><option value="BOUND">已绑定</option><option value="DISABLED">已禁用</option><option value="EXPIRED">已过期</option><option value="DELETED">已删除</option></select><button type="submit">搜索</button></form>
  <p v-if="loading" class="state">正在加载授权…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <section v-else class="grant-groups"><article v-for="group in result.items" :key="group.id" class="panel grant-group"><div class="section-header"><div><h2>{{ group.displayName }}</h2><p class="muted">{{ group.email }}</p></div><button type="button" @click="router.push(`/users/${group.id}`)">查看用户</button></div><table><thead><tr><th>URL 提示</th><th>URL 状态</th><th>URL 有效期</th><th>授权状态</th><th>授权有效期</th><th>绑定设备</th><th>创建人</th><th>创建时间</th><th>操作</th></tr></thead><tbody><tr v-for="grant in group.deviceGrants" :key="grant.id"><td class="mono">{{ grant.currentLink?.secretHint || '未生成' }}</td><td>{{ grant.currentLink ? linkStatusLabel(grant.currentLink.status) : '未生成' }}</td><td>{{ grant.currentLink ? (grant.currentLink.expiresAt ? new Date(grant.currentLink.expiresAt).toLocaleString() : '永久') : '未生成' }}</td><td><StatusBadge :status="grant.status" /><small>{{ grantStatusLabel(grant.status) }}</small></td><td>{{ grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : '永久' }}</td><td>{{ grant.device?.name || '未绑定' }}<small v-if="grant.boundAt">{{ new Date(grant.boundAt).toLocaleString() }}</small></td><td class="mono">{{ grant.createdById }}</td><td>{{ new Date(grant.createdAt).toLocaleString() }}</td><td><div class="actions" @click.stop><DeviceGrantLinkActions :grant="grant" @changed="load" /><button v-if="grantActions(grant).includes('enable')" type="button" class="primary" :disabled="actionPending" @click="enable(grant)">启用</button><button v-if="grantActions(grant).includes('disable')" type="button" :disabled="actionPending" @click="pendingAction = { grant, action: 'disable' }">禁用</button><button v-if="grantActions(grant).includes('edit-expiry')" type="button" :disabled="actionPending" @click="openExpiry(grant)">有效期</button><button v-if="grantActions(grant).includes('delete')" type="button" class="danger-link" :disabled="actionPending" @click="pendingAction = { grant, action: 'delete' }">删除</button><span v-if="grantActions(grant).length === 0" class="muted">无可用操作</span></div></td></tr></tbody></table></article><p v-if="!result.items.length" class="panel empty">没有符合条件的授权用户</p><Pagination v-bind="result" @change="setOffset" /></section>

  <div v-if="editingGrant" class="modal-backdrop" @click.self="closeExpiry"><form class="modal" @submit.prevent="saveExpiry"><h2>修改授权有效期</h2><label class="check-row"><input v-model="expiryForm.permanent" type="checkbox">永久有效</label><label>有效期<input v-model="expiryForm.expiresAt" type="datetime-local" :disabled="expiryForm.permanent" :required="!expiryForm.permanent"></label><p v-if="editError" class="state error">{{ editError }}</p><div class="modal-actions"><button type="button" :disabled="actionPending" @click="closeExpiry">取消</button><button type="submit" class="primary" :disabled="actionPending">{{ actionPending ? '正在保存…' : '保存有效期' }}</button></div></form></div>
  <ConfirmDialog :open="Boolean(pendingAction)" :title="pendingAction?.action === 'delete' ? '删除授权' : '禁用授权'" :message="pendingAction?.action === 'delete' ? '删除后不可恢复，关联设备将被永久撤销。' : '禁用后关联设备会立即停止访问服务端；重新启用后设备可恢复。'" :confirm-label="pendingAction?.action === 'delete' ? '确认删除' : '确认禁用'" :danger="pendingAction?.action === 'delete'" @confirm="confirmAction" @cancel="pendingAction = null" />
</template>
