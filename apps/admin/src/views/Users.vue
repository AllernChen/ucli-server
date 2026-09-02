<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, token } from '../api'
import { toast } from '../toast'
import { createExclusiveAsyncRequestGate, createRequestLifecycle, editableManagedUserRoles, type ManagedUser, type ManagedUserRole, type Page } from '../device-grants'
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
const roleUser = ref<ManagedUser | null>(null)
const rolePending = ref(false)
const roleError = ref('')
const roleOptions = ref<ManagedUserRole[]>([])
const result = ref<Page<ManagedUser>>({ items: [], total: 0, limit: 20, offset: 0 })
const filters = reactive({ q: '', limit: 20, offset: 0 })
const createForm = reactive({ email: '', displayName: '' })
const roleForm = reactive<{ role: ManagedUserRole }>({ role: 'MEMBER' })
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

function signedInPrincipal(): { sub: string; role: ManagedUserRole } | null {
  try {
    const raw = token().split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '=')))
    return typeof claims.sub === 'string' && ['MEMBER', 'ORG_ADMIN', 'PLATFORM_ADMIN'].includes(claims.role)
      ? { sub: claims.sub, role: claims.role } : null
  } catch { return null }
}

function editableRoles(user: ManagedUser): ManagedUserRole[] {
  const actor = signedInPrincipal()
  return actor ? editableManagedUserRoles(actor.role, user.role, actor.sub === user.id) : []
}

function openRole(user: ManagedUser) {
  if (rolePending.value) return
  const options = editableRoles(user)
  if (!options.length) return
  roleUser.value = user
  roleOptions.value = options
  roleForm.role = user.role
  roleError.value = ''
}

function closeRole() {
  if (rolePending.value) return
  roleUser.value = null
  roleError.value = ''
}

async function updateUserRole() {
  const user = roleUser.value
  if (!user || rolePending.value) return
  rolePending.value = true
  roleError.value = ''
  try {
    await api(`/api/v1/admin/users/${user.id}/role`, { method: 'PATCH', body: JSON.stringify({ role: roleForm.role }) })
    roleUser.value = null
    toast('用户角色已更新，已有登录会话将重新验证权限')
    await load()
  } catch (value: unknown) {
    roleError.value = value instanceof Error && value.message ? value.message : '更新角色失败'
  } finally {
    rolePending.value = false
  }
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
    <tbody><tr v-for="user in result.items" :key="user.id" class="clickable-row" @click="router.push(`/users/${user.id}`)"><td><strong>{{ user.displayName }}</strong><small>{{ user.email }}</small></td><td><span class="chip" :class="{ success: user.status === 'ACTIVE' }">{{ user.status === 'ACTIVE' ? '正常' : '已禁用' }}</span></td><td>{{ user.role }}</td><td>{{ user.deviceCount }}</td><td>{{ user.deviceGrantCount }}</td><td>{{ user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString() : '—' }}</td><td><div class="actions" @click.stop><button type="button" @click="router.push(`/users/${user.id}`)">查看</button><button v-if="editableRoles(user).length" type="button" :disabled="actionPending || rolePending" @click="openRole(user)">编辑角色</button><button v-if="user.role === 'MEMBER'" type="button" :class="{ 'danger-link': user.status === 'ACTIVE', primary: user.status === 'DISABLED' }" :disabled="actionPending || rolePending" @click="pendingUser = user">{{ user.status === 'ACTIVE' ? '禁用' : '启用' }}</button></div></td></tr></tbody>
  </table><p v-else class="empty">没有符合条件的用户</p><Pagination v-bind="result" @change="setOffset" /></section>

  <Drawer :open="createOpen" title="创建用户" :close-disabled="createPending" @close="closeCreate"><form class="stack-form" @submit.prevent="createUser"><label>显示名<input v-model="createForm.displayName" required maxlength="120" autocomplete="name"></label><label>邮箱<input v-model="createForm.email" type="email" required maxlength="320" autocomplete="email"></label><p v-if="formError" class="state error">{{ formError }}</p><button type="submit" class="primary" :disabled="createPending">{{ createPending ? '正在创建…' : '创建用户' }}</button></form></Drawer>
  <Drawer :open="Boolean(roleUser)" title="编辑角色授权" :close-disabled="rolePending" @close="closeRole"><form id="role-form" class="stack-form" @submit.prevent="updateUserRole"><label>用户<input :value="roleUser?.displayName" disabled></label><label>角色<select v-model="roleForm.role"><option v-for="role in roleOptions" :key="role" :value="role">{{ role }}</option></select></label><p v-if="roleError" class="state error">{{ roleError }}</p></form><template #footer><button type="button" :disabled="rolePending" @click="closeRole">取消</button><button type="submit" form="role-form" class="primary" :disabled="rolePending">{{ rolePending ? '正在保存…' : '保存角色' }}</button></template></Drawer>
  <ConfirmDialog :open="Boolean(pendingUser)" :title="pendingUser?.status === 'ACTIVE' ? '禁用用户' : '启用用户'" :message="pendingUser?.status === 'ACTIVE' ? '禁用后该用户的全部设备会立即停止访问服务端；重新启用后可恢复。' : '重新启用后该用户及未被禁用、删除或过期的授权可恢复访问。'" :confirm-label="pendingUser?.status === 'ACTIVE' ? '确认禁用' : '确认启用'" :danger="pendingUser?.status === 'ACTIVE'" @confirm="updateUserStatus" @cancel="pendingUser = null" />
</template>
