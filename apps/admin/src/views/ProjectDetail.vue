<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import type { Project, ProjectBudget } from '../projects'
import { formatCny } from '../currency'
import Drawer from '../components/Drawer.vue'

const route = useRoute(), lifecycle = createRequestLifecycle()
const project = ref<Project | null>(null), budget = ref<ProjectBudget | null>(null)
type ProjectKey = { id: string; name: string; secretHint: string; secretRecoverable?: boolean; account?: { displayName: string; email: string }; expiresAt: string | null; disabledAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdAt?: string }
const keys = ref<Page<ProjectKey>>({ items: [], total: 0, offset: 0, limit: 50 })
const loading = ref(false), error = ref(''), selectedKey = ref<ProjectKey | null>(null)
const revealPassword = ref(''), revealedSecret = ref(''), revealError = ref(''), revealing = ref(false), copyState = ref('')
const tab = ref(String(route.query.tab || 'overview'))
const id = computed(() => String(route.params.id))
const members = computed(() => project.value?.members || [])
const roleLabel = { OWNER: '负责人', CONTRIBUTOR: '成员', VIEWER: '观察者' } as const
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
    const [loadedProject, loadedBudget, loadedKeys] = await Promise.all([
      api<Project>(`/api/v1/admin/projects/${id.value}`),
      api<ProjectBudget>(`/api/v1/admin/projects/${id.value}/budget`),
      api<Page<any>>(`/api/v1/admin/employee-api-keys?projectId=${id.value}&limit=50`)
    ])
    if (request !== generation) return
    project.value = loadedProject; budget.value = loadedBudget; keys.value = loadedKeys
  } catch (e: any) { if (request === generation) error.value = e.message }
  finally { if (request === generation) loading.value = false }
}
watch(id, () => void load(), { immediate: true })
watch(() => route.query.tab, value => { tab.value = String(value || 'overview') })
</script>

<template>
  <header class="page-header"><div><button class="back-link" @click="$router.push('/projects')">← 返回项目管理</button><p>PROJECT</p><h1>{{ project?.name || id }}</h1><span class="subtitle">{{ project?.code }} · {{ project?.region.name }}</span></div><button @click="load">刷新</button></header>
  <p v-if="error" class="state error" role="alert">{{ error }}</p><p v-if="loading" class="state">正在加载项目…</p>
  <template v-else-if="project">
    <nav class="tabs"><button :class="{ active: tab === 'overview' }" @click="tab = 'overview'">概览</button><button :class="{ active: tab === 'budget' }" @click="tab = 'budget'">预算</button><button :class="{ active: tab === 'keys' }" @click="tab = 'keys'">项目 Key</button><button :class="{ active: tab === 'members' }" @click="tab = 'members'">成员</button></nav>
    <section v-if="tab === 'overview'" class="panel"><h2>基本信息</h2><p>状态：{{ project.status }}</p><p>说明：{{ project.description || '—' }}</p><p>预算模式：{{ project.budgetMode === 'TOTAL' ? '项目总额' : '自然月' }}</p></section>
    <section v-if="tab === 'budget'" class="panel"><h2>项目预算</h2><template v-if="budget"><p>额度：{{ budget.unlimited ? '不限额' : formatCny(budget.limitCny) }}</p><p>已用：{{ formatCny(budget.spentCny) }} · 预占：{{ formatCny(budget.reservedCny) }}</p><p>可用：{{ budget.unlimited ? '不限额' : formatCny(budget.availableCny || '0') }}</p></template></section>
    <section v-if="tab === 'keys'" class="panel"><h2>项目 Key</h2><table v-if="keys.items?.length"><thead><tr><th>名称 / 尾号</th><th>员工</th><th>状态</th><th>最后使用</th><th>操作</th></tr></thead><tbody><tr v-for="key in keys.items" :key="key.id"><td>{{ key.name }}<small class="mono">{{ key.secretHint }}</small></td><td>{{ key.account?.displayName || '—' }}<small>{{ key.account?.email }}</small></td><td>{{ keyStatus(key) }}</td><td>{{ dateTime(key.lastUsedAt) }}</td><td><button @click="openKey(key)">查看</button></td></tr></tbody></table><p v-else class="empty">暂无项目 Key</p></section>
    <section v-if="tab === 'members'" class="panel"><h2>项目职责成员</h2><table v-if="members.length"><thead><tr><th>成员</th><th>邮箱</th><th>职责</th></tr></thead><tbody><tr v-for="member in members" :key="member.accountId"><td>{{ member.membership?.account.displayName }}</td><td>{{ member.membership?.account.email }}</td><td>{{ roleLabel[member.role] }}</td></tr></tbody></table><p v-else class="empty">未配置职责成员；区域成员默认可签项目 Key。</p></section>
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
