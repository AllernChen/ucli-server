<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import type { Project, ProjectBudget } from '../projects'
import { formatCny } from '../currency'
import { operationId } from '../usage-groups'
import Drawer from '../components/Drawer.vue'

const route = useRoute(), lifecycle = createRequestLifecycle()
const project = ref<Project | null>(null), budget = ref<ProjectBudget | null>(null)
type ProjectKey = { id: string; name: string; secretHint: string; secretRecoverable?: boolean; account?: { displayName: string; email: string }; expiresAt: string | null; disabledAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdAt?: string }
const keys = ref<Page<ProjectKey>>({ items: [], total: 0, offset: 0, limit: 50 })
const candidates = ref<Page<any>>({ items: [], total: 0, offset: 0, limit: 100 })
const applications = ref<Page<any>>({ items: [], total: 0, offset: 0, limit: 20 })
const loading = ref(false), error = ref(''), selectedKey = ref<ProjectKey | null>(null)
const revealPassword = ref(''), revealedSecret = ref(''), revealError = ref(''), revealing = ref(false), copyState = ref('')
const tab = ref(String(route.query.tab || 'overview'))
const id = computed(() => String(route.params.id))
const members = computed(() => project.value?.members || [])
const roleLabel = { OWNER: '负责人', CONTRIBUTOR: '成员', VIEWER: '观察者' } as const
const memberForm = reactive({ accountId: '', role: 'CONTRIBUTOR' })
const budgetForm = reactive({ requestedTotalCny: '', unlimited: false, reason: '' })
const actionPending = ref(false), actionError = ref('')
let generation = 0
const keyStatus = (key: ProjectKey) => key.revokedAt ? '已撤销' : key.disabledAt ? '已停用' : key.expiresAt && new Date(key.expiresAt) <= new Date() ? '已过期' : '可用'
const dateTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '—'
function openKey(key: ProjectKey) {
  selectedKey.value = key
  revealPassword.value = ''; revealedSecret.value = ''; revealError.value = ''; copyState.value = ''
}
function closeKey() {
  selectedKey.value = null
  revealPassword.value = ''; revealedSecret.value = ''; revealError.value = ''; copyState.value = ''
}
async function revealSecret() {
  if (!selectedKey.value || revealing.value || !revealPassword.value) return
  revealing.value = true; revealError.value = ''; copyState.value = ''
  try {
    const result = await api<{ id: string; secret: string }>(`/api/v1/admin/employee-api-keys/${selectedKey.value.id}/reveal`, {
      method: 'POST', body: JSON.stringify({ password: revealPassword.value })
    })
    revealedSecret.value = result.secret; revealPassword.value = ''
  } catch (e: any) { revealError.value = e.message }
  finally { revealing.value = false }
}
async function copySecret() {
  if (!revealedSecret.value) return
  try { await navigator.clipboard.writeText(revealedSecret.value); copyState.value = '已复制' }
  catch { copyState.value = '复制失败，请手动选择复制' }
}
async function load() {
  const request = ++generation; loading.value = true; error.value = ''
  try {
    const loadedProject = await api<Project>(`/api/v1/admin/projects/${id.value}`)
    const [loadedBudget, loadedKeys, loadedApplications, loadedCandidates] = await Promise.all([
      api<ProjectBudget>(`/api/v1/admin/projects/${id.value}/budget`),
      api<Page<any>>(`/api/v1/admin/employee-api-keys?projectId=${id.value}&limit=50`),
      api<Page<any>>(`/api/v1/admin/projects/${id.value}/budget-applications?limit=20`),
      api<Page<any>>(`/api/v1/admin/org-units/${loadedProject.regionId}/members?limit=100`)
    ])
    if (request !== generation) return
    project.value = loadedProject; budget.value = loadedBudget; keys.value = loadedKeys
    applications.value = loadedApplications?.items ? loadedApplications : { items: [], total: 0, offset: 0, limit: 20 }
    candidates.value = loadedCandidates?.items ? loadedCandidates : { items: [], total: 0, offset: 0, limit: 100 }
  } catch (e: any) { if (request === generation) error.value = e.message }
  finally { if (request === generation) loading.value = false }
}
async function projectAction(path: string, method: string, body?: unknown) {
  if (actionPending.value) return false
  actionPending.value = true; actionError.value = ''
  try {
    await api(`/api/v1/admin/projects/${id.value}${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    await load(); return true
  } catch (e: any) { actionError.value = e.message; return false }
  finally { actionPending.value = false }
}
async function addMember() {
  if (!memberForm.accountId) return
  if (await projectAction('/members', 'POST', { ...memberForm })) memberForm.accountId = ''
}
async function submitAndApprove() {
  if (!budgetForm.requestedTotalCny || !budgetForm.reason.trim()) return
  if (await projectAction('/budget-applications/submit-and-approve', 'POST', {
    operationId: operationId(), requestedTotalCny: budgetForm.requestedTotalCny,
    unlimited: budgetForm.unlimited, reason: budgetForm.reason.trim()
  })) budgetForm.requestedTotalCny = ''; budgetForm.reason = ''
}
watch(id, () => void load(), { immediate: true })
watch(() => route.query.tab, value => { tab.value = String(value || 'overview') })
</script>

<template>
  <header class="page-header"><div><button class="back-link" @click="$router.push('/projects')">← 返回项目管理</button><p>PROJECT</p><h1>{{ project?.name || id }}</h1><span class="subtitle">{{ project?.code }} · {{ project?.region.name }}</span></div><button @click="load">刷新</button></header>
  <p v-if="error" class="state error" role="alert">{{ error }}</p><p v-if="loading" class="state">正在加载项目…</p>
  <template v-else-if="project">
    <nav class="tabs"><button :class="{ active: tab === 'overview' }" @click="tab = 'overview'">概览</button><button :class="{ active: tab === 'budget' }" data-tab="budget" @click="tab = 'budget'">预算</button><button :class="{ active: tab === 'keys' }" @click="tab = 'keys'">项目 Key</button><button :class="{ active: tab === 'members' }" data-tab="members" @click="tab = 'members'">成员</button></nav>
    <section v-if="tab === 'overview'" class="panel"><h2>基本信息</h2><p>状态：{{ project.status }}</p><p>项目类型：{{ project.category === 'DEPARTMENT' ? '部门预算项目' : '业务项目' }}</p><p>所属部门：{{ project.region.name }}</p><p>说明：{{ project.description || '—' }}</p><p>预算模式：{{ project.budgetMode === 'TOTAL' ? '项目总额' : '自然月' }}</p></section>
    <section v-if="tab === 'budget'" class="panel"><h2>项目预算</h2><template v-if="budget"><p>额度：{{ budget.unlimited ? '不限额' : formatCny(budget.limitCny) }}</p><p>已用：{{ formatCny(budget.spentCny) }} · 预占：{{ formatCny(budget.reservedCny) }}</p><p>可用：{{ budget.unlimited ? '不限额' : formatCny(budget.availableCny || '0') }}</p></template>
      <h3>预算申请</h3><p class="muted">填写批复后项目总额度；平台管理员可本人申请并批复。</p>
      <form class="form-row" @submit.prevent="submitAndApprove"><label>申请后项目总额<input v-model="budgetForm.requestedTotalCny" aria-label="申请后项目总额" inputmode="decimal" required></label><label>原因<input v-model="budgetForm.reason" aria-label="预算申请原因" required maxlength="2000"></label><button type="button" data-action="submit-and-approve" :disabled="actionPending || !budgetForm.requestedTotalCny || !budgetForm.reason.trim()" @click="submitAndApprove">提交并批复</button></form>
      <p v-if="actionError" class="state error">{{ actionError }}</p>
      <table v-if="applications.items.length"><thead><tr><th>申请时间</th><th>申请人 / 批复人</th><th>目标额度</th><th>批复后额度</th><th>状态</th><th>说明</th></tr></thead><tbody><tr v-for="application in applications.items" :key="application.id"><td>{{ dateTime(application.createdAt) }}</td><td>{{ application.applicant?.account?.displayName || '—' }} / {{ application.decidedBy?.displayName || '—' }}<small v-if="application.selfApproved">自申请自批复</small></td><td>{{ formatCny(application.requestedCny) }}</td><td>{{ application.approvedCny == null ? '—' : formatCny(application.approvedCny.toString()) }}</td><td>{{ application.status }}</td><td>{{ application.reason }}<small>{{ application.decisionNote }}</small></td></tr></tbody></table>
    </section>
    <section v-if="tab === 'keys'" class="panel"><h2>项目 Key</h2><table v-if="keys.items?.length"><thead><tr><th>名称 / 尾号</th><th>员工</th><th>状态</th><th>最后使用</th><th>操作</th></tr></thead><tbody><tr v-for="key in keys.items" :key="key.id"><td>{{ key.name }}<small class="mono">{{ key.secretHint }}</small></td><td>{{ key.account?.displayName || '—' }}<small>{{ key.account?.email }}</small></td><td>{{ keyStatus(key) }}</td><td>{{ dateTime(key.lastUsedAt) }}</td><td><button @click="openKey(key)">查看</button></td></tr></tbody></table><p v-else class="empty">暂无项目 Key</p></section>
    <section v-if="tab === 'members'" class="panel"><h2>项目成员</h2>
      <form class="form-row" @submit.prevent="addMember"><label>添加成员<select v-model="memberForm.accountId" aria-label="选择项目成员" required><option value="">请选择</option><option v-for="candidate in candidates.items" :key="candidate.accountId" :value="candidate.accountId">{{ candidate.membership.account.displayName }} · {{ candidate.membership.account.email }}</option></select></label><label>角色<select v-model="memberForm.role"><option value="CONTRIBUTOR">成员</option><option value="OWNER">项目负责人</option><option value="VIEWER">观察者</option></select></label><button type="button" data-action="add-project-member" :disabled="actionPending || !memberForm.accountId" @click="addMember">添加成员</button></form>
      <p v-if="actionError" class="state error">{{ actionError }}</p>
      <table v-if="members.length"><thead><tr><th>成员</th><th>邮箱</th><th>职责</th><th>操作</th></tr></thead><tbody><tr v-for="member in members" :key="member.accountId"><td>{{ member.membership?.account.displayName }}</td><td>{{ member.membership?.account.email }}</td><td>{{ roleLabel[member.role] }}</td><td><button :disabled="actionPending" @click="projectAction(`/members/${member.accountId}`, 'DELETE')">移除</button><button v-if="member.role !== 'OWNER'" :disabled="actionPending" @click="projectAction(`/members/${member.accountId}`, 'PATCH', { role: 'OWNER' })">设为负责人</button></td></tr></tbody></table><p v-else class="empty">暂无项目成员</p></section>
  </template>
<Drawer :open="Boolean(selectedKey)" title="项目 Key 详情" description="默认仅展示尾号；验证管理员密码后可查看和复制完整 Key。" @close="closeKey">
    <template v-if="selectedKey">
      <p>名称：{{ selectedKey.name }}</p>
      <p>尾号：<span class="mono">{{ selectedKey.secretHint }}</span></p>
      <p>员工：{{ selectedKey.account?.displayName || '—' }} {{ selectedKey.account?.email }}</p>
      <p>状态：{{ keyStatus(selectedKey) }}</p>
      <p>创建时间：{{ dateTime(selectedKey.createdAt) }}</p>
      <p>到期时间：{{ selectedKey.expiresAt ? dateTime(selectedKey.expiresAt) : '不设到期时间' }}</p>
      <p>最后使用：{{ dateTime(selectedKey.lastUsedAt) }}</p>
      <form v-if="!revealedSecret" class="stack-form" @submit.prevent="revealSecret">
        <label>管理员密码<input v-model="revealPassword" type="password" aria-label="输入管理员密码" autocomplete="current-password" required :disabled="revealing || !selectedKey.secretRecoverable"></label>
        <button type="button" data-action="reveal-key" :disabled="revealing || !revealPassword || !selectedKey.secretRecoverable" @click="revealSecret">{{ revealing ? '验证中…' : '验证并显示 Key' }}</button>
        <p v-if="!selectedKey.secretRecoverable" class="muted">此 Key 创建于支持明文查看之前，系统未保存可恢复密文；请签发替代 Key。</p>
      </form>
      <p v-if="revealError" class="state error" role="alert">{{ revealError }}</p>
      <template v-else-if="revealedSecret">
        <p>完整 Key：<code data-secret class="mono">{{ revealedSecret }}</code></p>
        <div class="actions"><button @click="copySecret">复制 Key</button><span v-if="copyState">{{ copyState }}</span></div>
        <p class="muted">请仅在受控环境中复制；关闭抽屉后明文不会保留。</p>
      </template>
    </template>
  </Drawer>
</template>
