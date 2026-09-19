<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import type { Project, ProjectBudget } from '../projects'
import { formatCny } from '../currency'

const route = useRoute(), lifecycle = createRequestLifecycle()
const project = ref<Project | null>(null), budget = ref<ProjectBudget | null>(null)
const keys = ref<Page<{ id: string; name: string; secretHint: string; account?: { displayName: string; email: string } }>>({ items: [], total: 0, offset: 0, limit: 50 })
const loading = ref(false), error = ref(''), tab = ref('overview')
const id = computed(() => String(route.params.id))
const members = computed(() => project.value?.members || [])
const roleLabel = { OWNER: '负责人', CONTRIBUTOR: '成员', VIEWER: '观察者' } as const
let generation = 0
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
</script>

<template>
  <header class="page-header"><div><button class="back-link" @click="$router.push('/projects')">← 返回项目管理</button><p>PROJECT</p><h1>{{ project?.name || id }}</h1><span class="subtitle">{{ project?.code }} · {{ project?.region.name }}</span></div><button @click="load">刷新</button></header>
  <p v-if="error" class="state error" role="alert">{{ error }}</p><p v-if="loading" class="state">正在加载项目…</p>
  <template v-else-if="project">
    <nav class="tabs"><button :class="{ active: tab === 'overview' }" @click="tab = 'overview'">概览</button><button :class="{ active: tab === 'budget' }" @click="tab = 'budget'">预算</button><button :class="{ active: tab === 'keys' }" @click="tab = 'keys'">项目 Key</button><button :class="{ active: tab === 'members' }" @click="tab = 'members'">成员</button></nav>
    <section v-if="tab === 'overview'" class="panel"><h2>基本信息</h2><p>状态：{{ project.status }}</p><p>说明：{{ project.description || '—' }}</p><p>预算模式：{{ project.budgetMode === 'TOTAL' ? '项目总额' : '自然月' }}</p></section>
    <section v-if="tab === 'budget'" class="panel"><h2>项目预算</h2><template v-if="budget"><p>额度：{{ budget.unlimited ? '不限额' : formatCny(budget.limitCny) }}</p><p>已用：{{ formatCny(budget.spentCny) }} · 预占：{{ formatCny(budget.reservedCny) }}</p><p>可用：{{ budget.unlimited ? '不限额' : formatCny(budget.availableCny || '0') }}</p></template></section>
    <section v-if="tab === 'keys'" class="panel"><h2>项目 Key</h2><table v-if="keys.items?.length"><thead><tr><th>名称</th><th>员工</th><th>尾号</th></tr></thead><tbody><tr v-for="key in keys.items" :key="key.id"><td>{{ key.name }}</td><td>{{ key.account?.displayName || '—' }}</td><td>{{ key.secretHint }}</td></tr></tbody></table><p v-else class="empty">暂无项目 Key</p></section>
    <section v-if="tab === 'members'" class="panel"><h2>项目职责成员</h2><table v-if="members.length"><thead><tr><th>成员</th><th>邮箱</th><th>职责</th></tr></thead><tbody><tr v-for="member in members" :key="member.accountId"><td>{{ member.membership?.account.displayName }}</td><td>{{ member.membership?.account.email }}</td><td>{{ roleLabel[member.role] }}</td></tr></tbody></table><p v-else class="empty">未配置职责成员；区域成员默认可签项目 Key。</p></section>
  </template>
</template>
