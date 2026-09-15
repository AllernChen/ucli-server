<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import { budgetLabel, type GroupBudget, type UsageGroup } from '../usage-groups'
import { formatCny } from '../currency'
import Drawer from '../components/Drawer.vue'
import Pagination from '../components/Pagination.vue'
const router = useRouter(), lifecycle = createRequestLifecycle()
const rows = ref<Page<UsageGroup>>({ items: [], total: 0, offset: 0, limit: 20 })
const budgets = ref<Record<string, GroupBudget>>({})
const filters = reactive({ q: '', type: '', status: 'active', offset: 0 })
const loading = ref(false), error = ref(''), open = ref(false), pending = ref(false), formError = ref('')
const form = reactive({ name: '', type: 'PROJECT', description: '' })
let alive = true
async function load() {
  const request = lifecycle.next(); loading.value = true; error.value = ''
  try {
    const query = new URLSearchParams({ status: filters.status, offset: String(filters.offset), limit: '20' })
    if (filters.q.trim()) query.set('q', filters.q.trim()); if (filters.type) query.set('type', filters.type)
    const result = await api<Page<UsageGroup>>(`/api/v1/admin/usage-groups?${query}`)
    const summaries = await Promise.all(result.items.map(g => api<GroupBudget>(`/api/v1/admin/usage-groups/${g.id}/budget`)))
    if (lifecycle.isCurrent(request)) { rows.value = result; budgets.value = Object.fromEntries(summaries.map(b => [b.groupId, b])) }
  } catch (e: any) { if (lifecycle.isCurrent(request)) error.value = e.message }
  finally { if (lifecycle.isCurrent(request)) loading.value = false }
}
async function create() {
  if (pending.value) return
  pending.value = true; formError.value = ''
  try {
    const group = await api('/api/v1/admin/usage-groups', { method: 'POST', body: JSON.stringify(form) })
    if (alive) { open.value = false; router.push(`/usage-groups/${group.id}`) }
  } catch (e: any) { if (alive) formError.value = e.message }
  finally { if (alive) pending.value = false }
}
onMounted(load); onUnmounted(() => { alive = false; lifecycle.dispose() })
</script>
<template>
  <header class="page-header"><div><p>GROUP ACCESS</p><h1>用量组</h1><span class="subtitle">按项目或部门分配模型权限与人民币采购预算</span></div><button class="primary" @click="open = true; formError = ''">创建用量组</button></header>
  <form class="panel form-row" @submit.prevent="filters.offset = 0; load()"><input v-model="filters.q" aria-label="搜索组名" placeholder="搜索组名"><select v-model="filters.type" aria-label="组类型"><option value="">全部类型</option><option value="PROJECT">项目组</option><option value="DEPARTMENT">部门组</option></select><select v-model="filters.status" aria-label="组状态"><option value="active">启用</option><option value="disabled">停用</option><option value="archived">归档</option><option value="all">全部状态</option></select><button :disabled="loading">查询</button></form>
  <p v-if="error" class="state error" role="alert">{{ error }}</p><p v-if="loading" class="state">正在加载用量组…</p>
  <section v-else class="panel table-panel"><table v-if="rows.items.length"><thead><tr><th>组 / 类型</th><th>状态</th><th>成员 / 模型</th><th>预算周期</th><th>额度 / 已用</th><th>预占 / 可用</th><th>消耗进度</th></tr></thead><tbody><tr v-for="g in rows.items" :key="g.id"><td><button class="back-link" @click="router.push(`/usage-groups/${g.id}`)">{{ g.name }}</button><small>{{ g.type === 'PROJECT' ? '项目组' : '部门组' }}</small></td><td>{{ g.archivedAt ? '已归档' : g.enabled ? '启用' : '停用' }}</td><td>{{ g._count?.members }} / {{ g._count?.models }}</td><td>{{ g.budgetMode === 'TOTAL' ? '项目总额' : '自然月' }}<small>{{ budgets[g.id]?.periodKey }}</small></td><td>{{ budgets[g.id] ? budgetLabel(budgets[g.id]) : '—' }}<small>已用 {{ formatCny(budgets[g.id]?.spentCny) }}</small></td><td>{{ formatCny(budgets[g.id]?.reservedCny) }}<small>可用 {{ budgets[g.id]?.unlimited ? '不限额' : formatCny(budgets[g.id]?.availableCny) }}</small></td><td><progress v-if="budgets[g.id] && !budgets[g.id].unlimited && Number(budgets[g.id].limitCny) > 0" :value="Number(budgets[g.id].spentCny) + Number(budgets[g.id].reservedCny)" :max="Number(budgets[g.id].limitCny)" aria-label="含预占预算消耗" /><span v-else>{{ budgets[g.id]?.unlimited ? '不限额' : '零额度' }}</span></td></tr></tbody></table><p v-else class="empty">暂无用量组</p><Pagination :total="rows.total" :limit="20" :offset="filters.offset" @change="filters.offset = $event; load()" /></section>
  <Drawer :open="open" title="创建用量组" description="新组没有成员和允许模型，预算为零；请创建后完成配置。" :close-disabled="pending" @close="open = false"><form id="create-group-form" class="stack-form" @submit.prevent="create"><label>组名称<input v-model="form.name" required maxlength="120"></label><label>类型<select v-model="form.type"><option value="PROJECT">项目组（默认总额）</option><option value="DEPARTMENT">部门组（默认月额度）</option></select></label><label>说明<textarea v-model="form.description" maxlength="2000" /></label><p v-if="formError" class="state error">{{ formError }}</p></form><template #footer><button :disabled="pending" @click="open = false">取消</button><button type="submit" form="create-group-form" :disabled="pending || !form.name.trim()">创建</button></template></Drawer>
</template>
