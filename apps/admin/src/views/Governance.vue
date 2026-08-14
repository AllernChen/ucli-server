<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const loading = ref(true)
const error = ref('')
const notice = ref('')
const tab = ref('members')

const members = ref<any[]>([])
const devices = ref<any[]>([])
const quotas = ref<any[]>([])
const inviteForm = ref({ email: '', role: 'MEMBER' })
const quotaForm = ref({ accountId: '', publicModelId: '', dailyTokens: '', monthlyTokens: '', dailyCostUsd: '', monthlyCostUsd: '', qps: '', concurrency: '' })

async function load() {
  loading.value = true; error.value = ''
  try {
    [members.value, devices.value, quotas.value] = await Promise.all([
      api('/api/v1/admin/members'), api('/api/v1/admin/devices'), api('/api/v1/admin/quotas')
    ])
  } catch (value: any) { error.value = value.message } finally { loading.value = false }
}
async function invite() {
  if (!inviteForm.value.email) return error.value = '请填写邮箱'
  try {
    const result = await api('/api/v1/admin/invitations', { method: 'POST', body: JSON.stringify({ email: inviteForm.value.email, role: inviteForm.value.role }) })
    notice.value = `邀请已创建，请把令牌发给对方（7 天有效）：${result.token}`
    inviteForm.value = { email: '', role: 'MEMBER' }
    await load()
  } catch (value: any) { error.value = value.message }
}
async function revoke(id: string) {
  try { await api(`/api/v1/admin/devices/${id}/revoke`, { method: 'POST' }); await load() }
  catch (value: any) { error.value = value.message }
}
async function createQuota() {
  const body: Record<string, any> = {}
  if (quotaForm.value.accountId) body.accountId = quotaForm.value.accountId
  if (quotaForm.value.publicModelId) body.publicModelId = quotaForm.value.publicModelId
  for (const key of ['dailyTokens', 'monthlyTokens', 'dailyCostUsd', 'monthlyCostUsd', 'qps', 'concurrency'] as const) {
    if (quotaForm.value[key] !== '') body[key] = Number(quotaForm.value[key])
  }
  const limitKeys = ['dailyTokens', 'monthlyTokens', 'dailyCostUsd', 'monthlyCostUsd', 'qps', 'concurrency']
  if (!limitKeys.some(key => quotaForm.value[key as keyof typeof quotaForm.value] !== '')) return error.value = '请至少填写一个限额'
  try {
    await api('/api/v1/admin/quotas', { method: 'POST', body: JSON.stringify(body) })
    quotaForm.value = { accountId: '', publicModelId: '', dailyTokens: '', monthlyTokens: '', dailyCostUsd: '', monthlyCostUsd: '', qps: '', concurrency: '' }
    await load()
  } catch (value: any) { error.value = value.message }
}
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>治理</h1></div><button @click="load">刷新数据</button></header>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <div class="tabs">
      <button :class="{active: tab === 'members'}" @click="tab = 'members'">成员</button>
      <button :class="{active: tab === 'devices'}" @click="tab = 'devices'">设备</button>
      <button :class="{active: tab === 'quotas'}" @click="tab = 'quotas'">配额</button>
    </div>

    <template v-if="tab === 'members'">
      <section class="panel form-panel">
        <h2>邀请成员</h2>
        <div class="form-row">
          <input v-model="inviteForm.email" type="email" placeholder="对方邮箱">
          <select v-model="inviteForm.role"><option value="MEMBER">成员</option><option value="ORG_ADMIN">组织管理员</option></select>
          <button class="primary" @click="invite">发送邀请</button>
        </div>
        <p v-if="notice" class="state">{{ notice }}</p>
      </section>
      <section class="panel">
        <h2>成员列表</h2>
        <table v-if="members.length">
          <thead><tr><th>显示名</th><th>邮箱</th><th>角色</th><th>状态</th><th>加入时间</th></tr></thead>
          <tbody><tr v-for="m in members" :key="m.accountId"><td>{{ m.account.displayName }}</td><td>{{ m.account.email }}</td><td>{{ m.role }}</td><td>{{ m.account.status }}</td><td>{{ m.account.createdAt?.slice(0, 10) }}</td></tr></tbody>
        </table>
        <p v-else class="empty">暂无成员</p>
      </section>
    </template>

    <template v-else-if="tab === 'devices'">
      <section class="panel">
        <h2>设备列表</h2>
        <table v-if="devices.length">
          <thead><tr><th>名称</th><th>最后活跃</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead>
          <tbody><tr v-for="d in devices" :key="d.id"><td>{{ d.name }}</td><td>{{ d.lastSeenAt?.slice(0, 19).replace('T', ' ') }}</td><td>{{ d.createdAt?.slice(0, 10) }}</td><td>{{ d.revokedAt ? '已撤销' : '正常' }}</td><td><div class="actions"><button v-if="!d.revokedAt" @click="revoke(d.id)">撤销</button></div></td></tr></tbody>
        </table>
        <p v-else class="empty">暂无设备</p>
      </section>
    </template>

    <template v-else>
      <section class="panel form-panel">
        <h2>新建配额</h2>
        <div class="form-row">
          <input v-model="quotaForm.accountId" placeholder="账号 id（可选）">
          <input v-model="quotaForm.publicModelId" placeholder="模型 id（可选）">
          <input v-model="quotaForm.dailyTokens" type="number" placeholder="每日 token">
          <input v-model="quotaForm.monthlyTokens" type="number" placeholder="每月 token">
          <input v-model="quotaForm.dailyCostUsd" type="number" step="0.01" placeholder="每日费用$">
          <input v-model="quotaForm.monthlyCostUsd" type="number" step="0.01" placeholder="每月费用$">
          <input v-model="quotaForm.qps" type="number" placeholder="QPS">
          <input v-model="quotaForm.concurrency" type="number" placeholder="并发">
          <button class="primary" @click="createQuota">创建配额</button>
        </div>
      </section>
      <section class="panel">
        <h2>配额列表</h2>
        <table v-if="quotas.length">
          <thead><tr><th>账号</th><th>模型</th><th>每日/每月 token</th><th>每日/每月费用</th><th>QPS</th><th>并发</th></tr></thead>
          <tbody><tr v-for="q in quotas" :key="q.id"><td>{{ q.accountId?.slice(0, 8) || '组织级' }}</td><td>{{ q.publicModelId || '全部' }}</td><td>{{ q.dailyTokens || '—' }} / {{ q.monthlyTokens || '—' }}</td><td>${{ q.dailyCostUsd || '—' }} / ${{ q.monthlyCostUsd || '—' }}</td><td>{{ q.qps || '—' }}</td><td>{{ q.concurrency || '—' }}</td></tr></tbody>
        </table>
        <p v-else class="empty">暂无配额</p>
      </section>
    </template>
  </template>
</template>
