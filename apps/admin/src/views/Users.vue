<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { toast } from '../toast'
import { createExclusiveAsyncRequestGate, createRequestLifecycle, type ManagedUser, type Page } from '../device-grants'
import Drawer from '../components/Drawer.vue'
import Pagination from '../components/Pagination.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const formError = ref('')
const createOpen = ref(false)
const createPending = ref(false)
const actionPending = ref(false)
const pendingUser = ref<ManagedUser | null>(null)
const result = ref<Page<ManagedUser>>({ items: [], total: 0, limit: 20, offset: 0 })
const filters = reactive({ q: '', limit: 20, offset: 0 })
const createForm = reactive({ email: '', displayName: '' })
const createGate = createExclusiveAsyncRequestGate(pending => { createPending.value = pending })
const loadLifecycle = createRequestLifecycle()

async function load() {
  const generation = loadLifecycle.next()
  loading.value = true
  error.value = ''
  const query = new URLSearchParams({ limit: String(filters.limit), offset: String(filters.offset) })
  if (filters.q.trim()) query.set('q', filters.q.trim())
  try {
    const loaded = await api<Page<ManagedUser>>(`/api/v1/admin/users?${query}`)
    if (!loadLifecycle.isCurrent(generation)) return
    result.value = loaded
  } catch (value: any) {
    if (!loadLifecycle.isCurrent(generation)) return
    error.value = value.message
  } finally {
    if (loadLifecycle.isCurrent(generation)) loading.value = false
  }
}

function openCreate() {
  if (createPending.value) return
  formError.value = ''
  createForm.email = ''
  createForm.displayName = ''
  createOpen.value = true
}

function closeCreate() {
  if (createPending.value) return
  createOpen.value = false
  formError.value = ''
}

async function createUser() {
  if (createPending.value) return
  let operation = 0
  formError.value = ''
  try {
    const created = await createGate.run(async requestOperation => {
      operation = requestOperation
      await api('/api/v1/admin/users', { method: 'POST', body: JSON.stringify(createForm) })
      return true
    })
    if (!created || !createGate.isCurrent(operation)) return
    createOpen.value = false
    toast('用户已创建')
    await load()
  } catch (value: unknown) {
    if (!createGate.isCurrent(operation)) return
    formError.value = value instanceof Error && value.message ? value.message : '创建用户失败'
  }
}

async function updateUserStatus() {
  const user = pendingUser.value
  if (!user || user.role !== 'MEMBER') return
  pendingUser.value = null
  actionPending.value = true
  try {
    const action = user.status === 'ACTIVE' ? 'disable' : 'enable'
    await api(`/api/v1/admin/users/${user.id}/${action}`, { method: 'POST' })
    toast(user.status === 'ACTIVE' ? '用户已禁用，关联设备已停止访问服务端' : '用户已启用')
    await load()
  } catch (value: any) {
    error.value = value.message
  } finally {
    actionPending.value = false
  }
}

function search() {
  filters.offset = 0
  load()
}

function setOffset(offset: number) {
  filters.offset = offset
  load()
}

onMounted(load)
onUnmounted(() => { createGate.dispose(); loadLifecycle.dispose() })
</script>

<template>
  <header class="page-header"><div><p>USER ACCESS</p><h1>用户管理</h1><span class="subtitle">管理组织成员及其设备授权</span></div>
    <div class="actions"><button type="button" @click="load">刷新</button><button type="button" class="primary" @click="openCreate">创建用户</button></div></header>
  <form class="panel toolbar user-toolbar" @submit.prevent="search"><input v-model="filters.q" aria-label="搜索用户" placeholder="搜索邮箱或显示名"><button type="submit">搜索</button></form>
  <p v-if="loading" class="state">正在加载用户…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <section v-else class="panel table-panel"><table v-if="result.items.length"><thead><tr><th>用户</th><th>组织状态</th><th>角色</th><th>设备</th><th>授权</th><th>最近使用</th><th>操作</th></tr></thead>
    <tbody><tr v-for="user in result.items" :key="user.id" class="clickable-row" @click="router.push(`/users/${user.id}`)"><td><strong>{{ user.displayName }}</strong><small>{{ user.email }}</small></td><td><span class="chip" :class="{ success: user.status === 'ACTIVE' }">{{ user.status === 'ACTIVE' ? '正常' : '已禁用' }}</span></td><td>{{ user.role }}</td><td>{{ user.deviceCount }}</td><td>{{ user.deviceGrantCount }}</td><td>{{ user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString() : '—' }}</td><td><div class="actions" @click.stop><button type="button" @click="router.push(`/users/${user.id}`)">查看</button><button v-if="user.role === 'MEMBER'" type="button" :class="{ 'danger-link': user.status === 'ACTIVE', primary: user.status === 'DISABLED' }" :disabled="actionPending" @click="pendingUser = user">{{ user.status === 'ACTIVE' ? '禁用' : '启用' }}</button></div></td></tr></tbody>
  </table><p v-else class="empty">没有符合条件的用户</p><Pagination v-bind="result" @change="setOffset" /></section>

  <Drawer :open="createOpen" title="创建用户" :close-disabled="createPending" @close="closeCreate"><form class="stack-form" @submit.prevent="createUser"><label>显示名<input v-model="createForm.displayName" required maxlength="120" autocomplete="name"></label><label>邮箱<input v-model="createForm.email" type="email" required maxlength="320" autocomplete="email"></label><p v-if="formError" class="state error">{{ formError }}</p><button type="submit" class="primary" :disabled="createPending">{{ createPending ? '正在创建…' : '创建用户' }}</button></form></Drawer>
  <ConfirmDialog :open="Boolean(pendingUser)" :title="pendingUser?.status === 'ACTIVE' ? '禁用用户' : '启用用户'" :message="pendingUser?.status === 'ACTIVE' ? '禁用后该用户的全部设备会立即停止访问服务端；重新启用后可恢复。' : '重新启用后该用户及未被禁用、删除或过期的授权可恢复访问。'" :confirm-label="pendingUser?.status === 'ACTIVE' ? '确认禁用' : '确认启用'" :danger="pendingUser?.status === 'ACTIVE'" @confirm="updateUserStatus" @cancel="pendingUser = null" />
</template>
