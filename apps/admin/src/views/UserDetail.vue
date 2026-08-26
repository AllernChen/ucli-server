<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { grantExpiryPayload, grantStatusLabel, type ManagedUserDetail } from '../device-grants'
import { toast } from '../toast'
import StatusBadge from '../components/StatusBadge.vue'

const route = useRoute()
const router = useRouter()
const userId = String(route.params.id)
const user = ref<ManagedUserDetail | null>(null)
const loading = ref(true)
const error = ref('')
const grantError = ref('')
const grantOpen = ref(false)
const grantPending = ref(false)
const createdSecret = ref<{ token: string; connectionUrl: string } | null>(null)
const grantForm = reactive({ permanent: true, expiresAt: '' })

async function load() {
  loading.value = true
  error.value = ''
  try {
    user.value = await api<ManagedUserDetail>(`/api/v1/admin/users/${userId}`)
  } catch (value: any) {
    error.value = value.message
  } finally {
    loading.value = false
  }
}

function openGrant() {
  grantError.value = ''
  grantForm.permanent = true
  grantForm.expiresAt = ''
  grantOpen.value = true
}

async function createGrant() {
  grantError.value = ''
  createdSecret.value = null
  grantPending.value = true
  try {
    const created = await api<{ token: string; connectionUrl: string }>(
      `/api/v1/admin/users/${userId}/device-grants`,
      { method: 'POST', body: JSON.stringify(grantExpiryPayload(grantForm)) }
    )
    createdSecret.value = created
    grantOpen.value = false
    await load()
  } catch (value: any) {
    createdSecret.value = null
    grantError.value = value.message
  } finally {
    grantPending.value = false
  }
}

function closeSecret() {
  createdSecret.value = null
}

async function copyConnectionUrl() {
  const connectionUrl = createdSecret.value?.connectionUrl
  if (!connectionUrl) return
  try {
    await navigator.clipboard.writeText(connectionUrl)
    toast('连接链接已复制')
  } catch (value: any) {
    error.value = value.message || '复制失败，请手动复制连接链接'
  }
}

onMounted(load)
onUnmounted(closeSecret)
</script>

<template>
  <header class="page-header"><div><button type="button" class="back-link" @click="router.push('/users')">← 返回用户管理</button><p>USER ACCESS</p><h1>{{ user?.displayName || userId }}</h1><span class="subtitle">{{ user?.email }}</span></div>
    <div class="actions"><button type="button" @click="load">刷新</button><button type="button" class="primary" :disabled="!user || user.role !== 'MEMBER'" @click="openGrant">创建授权</button></div></header>
  <p v-if="loading" class="state">正在加载用户…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else-if="user"><div class="detail-grid"><article class="panel metric-block"><span>组织状态</span><strong class="small-strong">{{ user.status === 'ACTIVE' ? '正常' : '已禁用' }}</strong></article><article class="panel metric-block"><span>角色</span><strong class="small-strong">{{ user.role }}</strong></article><article class="panel metric-block"><span>设备</span><strong>{{ user.deviceCount }}</strong></article><article class="panel metric-block"><span>授权</span><strong>{{ user.deviceGrantCount }}</strong></article></div>
    <section class="panel table-panel"><div class="section-header"><div><h2>设备授权</h2><p class="muted">授权令牌完整内容只在创建完成时展示一次。</p></div><button type="button" @click="router.push('/device-grants')">管理全部授权</button></div><table v-if="user.deviceGrants.length"><thead><tr><th>令牌提示</th><th>状态</th><th>有效期</th><th>绑定设备</th><th>绑定时间</th><th>创建时间</th></tr></thead><tbody><tr v-for="grant in user.deviceGrants" :key="grant.id"><td class="mono">{{ grant.tokenHint }}</td><td><StatusBadge :status="grant.status" /><small>{{ grantStatusLabel(grant.status) }}</small></td><td>{{ grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : '永久' }}</td><td>{{ grant.deviceId || '未绑定' }}</td><td>{{ grant.boundAt ? new Date(grant.boundAt).toLocaleString() : '—' }}</td><td>{{ new Date(grant.createdAt).toLocaleString() }}</td></tr></tbody></table><p v-else class="empty">暂无设备授权</p></section>
    <section class="panel table-panel"><h2>设备</h2><table v-if="user.devices.length"><thead><tr><th>名称</th><th>平台 / 版本</th><th>绑定时间</th><th>最后活跃</th><th>状态</th></tr></thead><tbody><tr v-for="device in user.devices" :key="device.id"><td><strong>{{ device.name }}</strong><small class="mono">{{ device.installationId || '—' }}</small></td><td>{{ device.platform || '—' }} / {{ device.clientVersion || '—' }}</td><td>{{ new Date(device.createdAt).toLocaleString() }}</td><td>{{ device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '—' }}</td><td>{{ device.revokedAt ? '已永久撤销' : '正常' }}</td></tr></tbody></table><p v-else class="empty">暂无已绑定设备</p></section>
  </template>

  <div v-if="grantOpen" class="modal-backdrop" @click.self="grantOpen = false"><form class="modal" @submit.prevent="createGrant"><h2>创建设备授权</h2><label class="check-row"><input v-model="grantForm.permanent" type="checkbox">永久有效</label><label>有效期<input v-model="grantForm.expiresAt" type="datetime-local" :disabled="grantForm.permanent" :required="!grantForm.permanent"></label><p class="muted">创建后会显示一次完整连接链接，请及时复制并安全发送给用户。</p><p v-if="grantError" class="state error">{{ grantError }}</p><div class="modal-actions"><button type="button" :disabled="grantPending" @click="grantOpen = false">取消</button><button type="submit" class="primary" :disabled="grantPending">{{ grantPending ? '正在创建…' : '创建授权' }}</button></div></form></div>
  <div v-if="createdSecret" class="modal-backdrop" @click.self="closeSecret"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="grant-secret-title"><h2 id="grant-secret-title">授权创建成功</h2><p class="warning-text">关闭后无法再次查看完整令牌</p><label>连接链接<textarea readonly :value="createdSecret.connectionUrl" aria-label="完整连接链接"></textarea></label><div class="modal-actions"><button type="button" @click="copyConnectionUrl">复制连接链接</button><button type="button" class="primary" @click="closeSecret">关闭</button></div></section></div>
</template>
