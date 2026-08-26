<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'
import { toast } from '../toast'
import { formatCny } from '../currency'

const loading = ref(true)
const error = ref('')
const tab = ref<'quotas' | 'audit'>('quotas')
const quotas = ref<any[]>([])
const audit = ref<any[]>([])
const quotaForm = ref({ accountId: '', publicModelId: '', dailyTokens: '', monthlyTokens: '', dailyCostUsd: '', monthlyCostUsd: '', qps: '', tpm: '', concurrency: '' })

async function load() {
  loading.value = true; error.value = ''
  try {
    [quotas.value, audit.value] = await Promise.all([api('/api/v1/admin/quotas'), api('/api/v1/admin/audit')])
  } catch (value: any) { error.value = value.message } finally { loading.value = false }
}
async function createQuota() {
  const body: Record<string, any> = {}
  if (quotaForm.value.accountId) body.accountId = quotaForm.value.accountId
  if (quotaForm.value.publicModelId) body.publicModelId = quotaForm.value.publicModelId
  for (const key of ['dailyTokens', 'monthlyTokens', 'dailyCostUsd', 'monthlyCostUsd', 'qps', 'tpm', 'concurrency'] as const) {
    if (quotaForm.value[key] !== '') body[key] = Number(quotaForm.value[key])
  }
  const limitKeys = ['dailyTokens', 'monthlyTokens', 'dailyCostUsd', 'monthlyCostUsd', 'qps', 'tpm', 'concurrency']
  if (!limitKeys.some(key => quotaForm.value[key as keyof typeof quotaForm.value] !== '')) return error.value = '请至少填写一个限额'
  try {
    await api('/api/v1/admin/quotas', { method: 'POST', body: JSON.stringify(body) })
    quotaForm.value = { accountId: '', publicModelId: '', dailyTokens: '', monthlyTokens: '', dailyCostUsd: '', monthlyCostUsd: '', qps: '', tpm: '', concurrency: '' }
    toast('配额已创建')
    await load()
  } catch (value: any) { error.value = value.message }
}
async function deleteQuota(id: string) {
  try { await api(`/api/v1/admin/quotas/${id}`, { method: 'DELETE' }); toast('配额已删除'); await load() }
  catch (value: any) { error.value = value.message }
}
function truncate(value: any) {
  const s = JSON.stringify(value ?? '')
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>治理</h1></div><button @click="load">刷新数据</button></header>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <div class="tabs">
      <button type="button" :class="{active: tab === 'quotas'}" @click="tab = 'quotas'">配额</button>
      <button type="button" :class="{active: tab === 'audit'}" @click="tab = 'audit'">审计</button>
    </div>

    <template v-if="tab === 'quotas'">
      <section class="panel form-panel">
        <h2>新建配额</h2>
        <div class="form-row">
          <input v-model="quotaForm.accountId" placeholder="账号 id（可选）">
          <input v-model="quotaForm.publicModelId" placeholder="模型 id（可选）">
          <input v-model="quotaForm.dailyTokens" type="number" placeholder="每日 token">
          <input v-model="quotaForm.monthlyTokens" type="number" placeholder="每月 token">
        <input v-model="quotaForm.dailyCostUsd" type="number" step="0.01" placeholder="每日费用¥">
        <input v-model="quotaForm.monthlyCostUsd" type="number" step="0.01" placeholder="每月费用¥">
          <input v-model="quotaForm.qps" type="number" placeholder="QPS">
          <input v-model="quotaForm.tpm" type="number" placeholder="TPM">
          <input v-model="quotaForm.concurrency" type="number" placeholder="并发">
          <button class="primary" @click="createQuota">创建配额</button>
        </div>
      </section>
      <section class="panel">
        <h2>配额列表</h2>
        <table v-if="quotas.length">
          <thead><tr><th>账号</th><th>模型</th><th>每日/每月 token</th><th>每日/每月费用</th><th>QPS</th><th>TPM</th><th>并发</th><th>操作</th></tr></thead>
            <tbody><tr v-for="q in quotas" :key="q.id"><td>{{ q.accountId?.slice(0, 8) || '组织级' }}</td><td>{{ q.publicModelId || '全部' }}</td><td>{{ q.dailyTokens || '—' }} / {{ q.monthlyTokens || '—' }}</td><td>{{ formatCny(q.dailyCostUsd) }} / {{ formatCny(q.monthlyCostUsd) }}</td><td>{{ q.qps || '—' }}</td><td>{{ q.tpm || '—' }}</td><td>{{ q.concurrency || '—' }}</td><td><button @click="deleteQuota(q.id)">删除</button></td></tr></tbody>
        </table>
        <p v-else class="empty">暂无配额</p>
      </section>
    </template>

    <template v-else>
      <section class="panel">
        <h2>审计日志</h2>
        <table v-if="audit.length">
          <thead><tr><th>时间</th><th>操作</th><th>账号</th><th>资源</th><th>详情</th></tr></thead>
          <tbody><tr v-for="a in audit" :key="a.id"><td>{{ a.occurredAt?.slice(0, 19).replace('T', ' ') }}</td><td>{{ a.action }}</td><td>{{ a.actor?.email || '—' }}</td><td>{{ a.resourceType }}</td><td class="mono" :title="JSON.stringify(a.metadata)">{{ truncate(a.metadata) }}</td></tr></tbody>
        </table>
        <p v-else class="empty">暂无审计记录</p>
      </section>
    </template>
  </template>
</template>
