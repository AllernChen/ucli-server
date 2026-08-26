<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { createExclusiveAsyncRequestGate, createRequestLifecycle, grantExpiryPayload, grantStatusLabel, type ManagedUserDetail, type UserDetailGrant } from '../device-grants'
import { toast } from '../toast'
import Drawer from '../components/Drawer.vue'
import StatusBadge from '../components/StatusBadge.vue'

const route = useRoute()
const router = useRouter()
const userId = computed(() => String(route.params.id))
const routeLifecycle = createRequestLifecycle()
const loadLifecycle = createRequestLifecycle()
let currentRouteGeneration = 0
const user = ref<ManagedUserDetail | null>(null)
const loading = ref(true)
const error = ref('')
const grantError = ref('')
const copyError = ref('')
const grantOpen = ref(false)
const grantPending = ref(false)
const createdSecret = ref<{ connectionUrl: string } | null>(null)
const grantForm = reactive({ permanent: true, expiresAt: '' })
const canCreateGrant = computed(() => user.value?.role === 'MEMBER' && user.value.status === 'ACTIVE')
const grantGate = createExclusiveAsyncRequestGate(pending => { grantPending.value = pending })

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error && value.message ? value.message : fallback
}

function detailGrantStatusLabel(grant: UserDetailGrant) {
  return grantStatusLabel(grant.status)
}

function isCurrentRoute(generation: number, requestedUserId: string) {
  return routeLifecycle.isCurrent(generation) && userId.value === requestedUserId
}

function clearSecret() {
  createdSecret.value = null
  copyError.value = ''
}

function resetForUser() {
  grantGate.invalidate()
  user.value = null
  loading.value = true
  error.value = ''
  grantError.value = ''
  grantOpen.value = false
  grantPending.value = false
  grantForm.permanent = true
  grantForm.expiresAt = ''
  clearSecret()
}

async function load() {
  const loadGeneration = loadLifecycle.next()
  const routeGeneration = currentRouteGeneration
  const requestedUserId = userId.value
  if (!isCurrentRoute(routeGeneration, requestedUserId)) return
  loading.value = true
  error.value = ''
  try {
    const detail = await api<ManagedUserDetail>(`/api/v1/admin/users/${requestedUserId}`)
    if (!isCurrentRoute(routeGeneration, requestedUserId) || !loadLifecycle.isCurrent(loadGeneration)) return
    user.value = detail
  } catch (value: unknown) {
    if (!isCurrentRoute(routeGeneration, requestedUserId) || !loadLifecycle.isCurrent(loadGeneration)) return
    error.value = errorMessage(value, '加载用户失败')
  } finally {
    if (isCurrentRoute(routeGeneration, requestedUserId) && loadLifecycle.isCurrent(loadGeneration)) loading.value = false
  }
}

function openGrant() {
  if (!canCreateGrant.value || grantPending.value) return
  grantError.value = ''
  grantForm.permanent = true
  grantForm.expiresAt = ''
  grantOpen.value = true
}

function closeGrant() {
  if (grantPending.value) return
  grantOpen.value = false
  grantError.value = ''
}

async function createGrant() {
  if (grantPending.value || !canCreateGrant.value) return
  const requestedUserId = userId.value
  const routeGeneration = currentRouteGeneration
  let operation = 0
  grantError.value = ''
  clearSecret()
  try {
    const created = await grantGate.run(async requestOperation => {
      operation = requestOperation
      return api<{ connectionUrl: string }>(
        `/api/v1/admin/users/${requestedUserId}/device-grants`,
        { method: 'POST', body: JSON.stringify(grantExpiryPayload(grantForm)) }
      )
    })
    if (!created || !grantGate.isCurrent(operation) || !isCurrentRoute(routeGeneration, requestedUserId)) return
    createdSecret.value = created
    grantOpen.value = false
    await load()
  } catch (value: unknown) {
    if (!grantGate.isCurrent(operation) || !isCurrentRoute(routeGeneration, requestedUserId)) return
    clearSecret()
    grantError.value = errorMessage(value, '创建授权失败')
  }
}

async function copyConnectionUrl() {
  const connectionUrl = createdSecret.value?.connectionUrl
  if (!connectionUrl) return
  copyError.value = ''
  try {
    await navigator.clipboard.writeText(connectionUrl)
    toast('连接链接已复制')
  } catch (value: unknown) {
    copyError.value = errorMessage(value, '复制失败，请手动复制连接链接')
  }
}

watch(userId, () => {
  currentRouteGeneration = routeLifecycle.next()
  resetForUser()
  load()
}, { immediate: true })

onUnmounted(() => {
  grantGate.dispose()
  routeLifecycle.dispose()
  loadLifecycle.dispose()
  clearSecret()
})
</script>

<template>
  <header class="page-header"><div><button type="button" class="back-link" @click="router.push('/users')">← 返回用户管理</button><p>USER ACCESS</p><h1>{{ user?.displayName || userId }}</h1><span class="subtitle">{{ user?.email }}</span></div>
    <div class="actions"><button type="button" @click="load">刷新</button><button type="button" class="primary" :disabled="!canCreateGrant || grantPending" @click="openGrant">创建授权</button></div></header>
  <p v-if="user && !canCreateGrant" class="state">仅可为已启用的 MEMBER 创建授权；请先启用该用户。</p>
  <p v-if="loading" class="state">正在加载用户…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else-if="user"><div class="detail-grid"><article class="panel metric-block"><span>当前组织成员状态</span><strong class="small-strong">{{ user.status === 'ACTIVE' ? '正常' : '已禁用' }}</strong></article><article class="panel metric-block"><span>角色</span><strong class="small-strong">{{ user.role }}</strong></article><article class="panel metric-block"><span>设备</span><strong>{{ user.deviceCount }}</strong></article><article class="panel metric-block"><span>授权</span><strong>{{ user.deviceGrantCount }}</strong></article></div>
    <section class="panel table-panel"><div class="section-header"><div><h2>设备授权</h2><p class="muted">授权令牌完整内容只在创建完成时展示一次。</p></div><button type="button" @click="router.push('/device-grants')">管理全部授权</button></div><table v-if="user.deviceGrants.length"><thead><tr><th>令牌提示</th><th>状态</th><th>有效期</th><th>绑定设备</th><th>绑定时间</th><th>创建时间</th></tr></thead><tbody><tr v-for="grant in user.deviceGrants" :key="grant.id"><td class="mono">{{ grant.tokenHint }}</td><td><StatusBadge :status="grant.status" /><small>{{ detailGrantStatusLabel(grant) }}</small></td><td>{{ grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : '永久' }}</td><td>{{ grant.deviceId || '未绑定' }}</td><td>{{ grant.boundAt ? new Date(grant.boundAt).toLocaleString() : '—' }}</td><td>{{ new Date(grant.createdAt).toLocaleString() }}</td></tr></tbody></table><p v-else class="empty">暂无设备授权</p></section>
    <section class="panel table-panel"><h2>设备</h2><table v-if="user.devices.length"><thead><tr><th>名称</th><th>平台 / 版本</th><th>绑定时间</th><th>最后活跃</th><th>状态</th></tr></thead><tbody><tr v-for="device in user.devices" :key="device.id"><td><strong>{{ device.name }}</strong><small class="mono">{{ device.installationId || '—' }}</small></td><td>{{ device.platform || '—' }} / {{ device.clientVersion || '—' }}</td><td>{{ new Date(device.createdAt).toLocaleString() }}</td><td>{{ device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '—' }}</td><td>{{ device.revokedAt ? '已永久撤销' : '正常' }}</td></tr></tbody></table><p v-else class="empty">暂无已绑定设备</p></section>
  </template>

  <Drawer :open="grantOpen" title="创建设备授权" description="创建后会显示一次完整连接链接，请及时复制并安全发送给用户。" :close-disabled="grantPending" @close="closeGrant"><form id="grant-form" class="stack-form" @submit.prevent="createGrant"><label class="check-row"><input v-model="grantForm.permanent" type="checkbox">永久有效</label><label>有效期<input v-model="grantForm.expiresAt" type="datetime-local" :disabled="grantForm.permanent" :required="!grantForm.permanent"></label><p v-if="grantError" class="state error">{{ grantError }}</p></form><template #footer><button type="button" :disabled="grantPending" @click="closeGrant">取消</button><button type="submit" form="grant-form" class="primary" :disabled="grantPending">{{ grantPending ? '正在创建…' : '创建授权' }}</button></template></Drawer>
  <Drawer :open="Boolean(createdSecret)" title="授权创建成功" description="关闭后无法再次查看完整令牌" @close="clearSecret"><label>连接链接<textarea readonly :value="createdSecret?.connectionUrl || ''" aria-label="完整连接链接"></textarea></label><p v-if="copyError" class="state error">{{ copyError }}</p><template #footer><button type="button" @click="copyConnectionUrl">复制连接链接</button><button type="button" class="primary" @click="clearSecret">关闭</button></template></Drawer>
</template>
