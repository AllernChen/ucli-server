<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import Pagination from '../components/Pagination.vue'
import Drawer from '../components/Drawer.vue'
import { formatCny } from '../currency'

type OrgUnitKind = 'EXECUTIVE' | 'FUNCTIONAL' | 'REGION' | 'LEGACY_PROJECT'
type OrgUnit = {
  id: string; name: string; orgType: OrgUnitKind; description?: string; enabled: boolean; archivedAt: string | null
  memberCount: number; activeKeyCount: number; activeProjectCount: number; modelCount: number
  departmentProject?: { id: string; name: string; category: 'DEPARTMENT' } | null
  budget?: {
    projectCount: number; totalLimitCny: string; spentCny: string; reservedCny: string
    occupiedCny: string; availableCny: string | null; usagePercent: number | null
    unlimitedProjectCount: number; alertProjectCount: number
  }
  usage?: {
    requests: number; totalTokens: string; costCny: string; activeAccounts: number; lastUsedAt: string | null
  }
}

const router = useRouter(), lifecycle = createRequestLifecycle()
const rows = ref<Page<OrgUnit>>({ items: [], total: 0, offset: 0, limit: 20 })
const filters = reactive({ kind: '', q: '', offset: 0 })
const loading = ref(false), error = ref(''), open = ref(false), pending = ref(false), formError = ref('')
const form = reactive({ name: '', kind: 'REGION', description: '' })
const kindOptions = [
  { value: 'EXECUTIVE', label: '经营层' },
  { value: 'FUNCTIONAL', label: '职能部门' },
  { value: 'REGION', label: '区域部门' }
]
const kindLabel = computed(() => ({
  EXECUTIVE: '经营层', FUNCTIONAL: '职能部门', REGION: '区域部门', LEGACY_PROJECT: '历史项目组'
} as Record<OrgUnitKind, string>))
const tokens = (value: string | number | null | undefined) => value == null ? '—' : BigInt(value).toLocaleString('zh-CN')
function query() {
  const params = new URLSearchParams({ status: 'active', offset: String(filters.offset), limit: '20' })
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.q.trim()) params.set('q', filters.q.trim())
  return params.toString()
}
async function load() {
  const request = lifecycle.next(); loading.value = true; error.value = ''
  try {
    const result = await api<Page<OrgUnit>>(`/api/v1/admin/org-units?${query()}`)
    if (lifecycle.isCurrent(request)) rows.value = result
  } catch (e: any) { if (lifecycle.isCurrent(request)) error.value = e.message }
  finally { if (lifecycle.isCurrent(request)) loading.value = false }
}
async function create() {
  if (pending.value || !form.name.trim()) return
  pending.value = true; formError.value = ''
  try {
    await api('/api/v1/admin/org-units', { method: 'POST', body: JSON.stringify({ ...form }) })
    open.value = false; form.name = ''; form.description = ''; filters.offset = 0; await load()
  } catch (e: any) { formError.value = e.message }
  finally { pending.value = false }
}
watch(filters, () => void load(), { immediate: true, deep: true })
</script>

<template>
  <header class="page-header"><div><p>ORGANIZATION</p><h1>组织管理</h1><span class="subtitle">部门、成员、项目与模型权限</span></div><div class="actions"><button @click="load">刷新</button><button class="primary" @click="open = true">新建组织</button></div></header>
  <form class="panel form-row" @submit.prevent="filters.offset = 0; load()">
    <select v-model="filters.kind" aria-label="组织类型"><option value="">全部类型</option><option value="EXECUTIVE">经营层</option><option value="FUNCTIONAL">职能部门</option><option value="REGION">区域部门</option></select>
    <input v-model="filters.q" aria-label="搜索组织" placeholder="组织名称">
    <button :disabled="loading">查询</button>
  </form>
  <p v-if="error" class="state error" role="alert">{{ error }}</p>
  <p v-if="loading" class="state">正在加载组织…</p>
  <section v-else class="panel table-panel">
    <table v-if="rows.items.length"><thead><tr><th>组织</th><th>类型</th><th>负责人 / 成员</th><th>项目</th><th>预算进度</th><th>模型 / Key</th><th>部门预算项目</th><th>操作</th></tr></thead>
      <tbody><tr v-for="org in rows.items" :key="org.id">
        <td><button class="back-link" @click="router.push(`/org-units/${org.id}`)">{{ org.name }}</button><small>{{ org.description || '—' }}</small></td>
        <td>{{ kindLabel[org.orgType] }}</td>
        <td>成员 {{ org.memberCount }}</td>
        <td>{{ org.activeProjectCount }}<small>预算 {{ org.budget?.projectCount ?? 0 }}</small></td>
        <td>
          <template v-if="org.budget">
            <strong>{{ formatCny(org.budget.occupiedCny) }} / {{ org.budget.availableCny == null ? '不限额' : formatCny(org.budget.totalLimitCny) }}</strong>
            <small>已用 {{ formatCny(org.budget.spentCny) }} · 预占 {{ formatCny(org.budget.reservedCny) }}</small>
            <progress v-if="org.budget.usagePercent != null" :value="org.budget.usagePercent" max="100" aria-label="组织预算使用率"></progress>
            <small v-if="org.budget.usagePercent != null">{{ org.budget.usagePercent }}%</small>
            <small v-if="org.budget.unlimitedProjectCount">包含不限额项目 {{ org.budget.unlimitedProjectCount }}</small>
            <small v-if="org.budget.alertProjectCount">{{ org.budget.alertProjectCount }} 个项目接近或达到预算</small>
          </template>
          <span v-else>—</span>
        </td>
        <td>{{ org.modelCount }} / {{ org.activeKeyCount }}</td>
        <td>{{ org.departmentProject?.name || '—' }}</td>
        <td><button @click="router.push(`/org-units/${org.id}`)">详情</button></td>
      </tr></tbody></table>
    <p v-else class="empty">暂无组织</p>
    <Pagination :total="rows.total" :limit="rows.limit" :offset="rows.offset" @change="filters.offset = $event" />
  </section>
  <Drawer :open="open" title="新建组织" description="经营层和职能部门会自动创建部门预算项目；区域部门用于承载业务项目。" @close="open = false">
    <form id="org-unit-form" class="stack-form" @submit.prevent="create">
      <label>组织名称<input v-model="form.name" required maxlength="120"></label>
      <label>组织类型<select v-model="form.kind"><option v-for="option in kindOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
      <label>说明<textarea v-model="form.description" maxlength="2000"></textarea></label>
      <p v-if="formError" class="state error">{{ formError }}</p>
    </form>
    <template #footer><button @click="open = false">取消</button><button class="primary" type="submit" form="org-unit-form" :disabled="pending || !form.name.trim()">创建</button></template>
  </Drawer>
</template>
