<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import { formatCny } from '../currency'

type OrgUnit = {
  id: string; name: string; orgType: string; description?: string; enabled: boolean; archivedAt: string | null
  memberCount: number; modelCount: number; activeKeyCount: number; activeProjectCount: number
  departmentProject?: { id: string; name: string; category: string } | null
  budget?: {
    projectCount: number; totalLimitCny: string; spentCny: string; reservedCny: string
    occupiedCny: string; availableCny: string | null; usagePercent: number | null
    unlimitedProjectCount: number; alertProjectCount: number
  }
  usage?: {
    requests: number; totalTokens: string; costCny: string; activeAccounts: number; lastUsedAt: string | null
  }
}
const route = useRoute(), router = useRouter(), lifecycle = createRequestLifecycle()
const id = computed(() => String(route.params.id)), base = computed(() => `/api/v1/admin/org-units/${id.value}`)
const org = ref<OrgUnit | null>(null), members = ref<Page<any>>({ items: [], total: 0, offset: 0, limit: 100 })
const projects = ref<any[]>([]), models = ref<any[]>([])
const loading = ref(false), error = ref(''), tab = ref('overview')
const kindLabel: Record<string, string> = { EXECUTIVE: '经营层', FUNCTIONAL: '职能部门', REGION: '区域部门', LEGACY_PROJECT: '历史项目组' }
const tokens = (value: string | number | null | undefined) => value == null ? '—' : BigInt(value).toLocaleString('zh-CN')
async function load() {
  const request = lifecycle.next(); loading.value = true; error.value = ''
  try {
    const [loadedOrg, loadedMembers, loadedProjects, loadedModels] = await Promise.all([
      api<OrgUnit>(base.value),
      api<Page<any>>(`${base.value}/members?limit=100`),
      api<any[]>(`${base.value}/projects`),
      api<any[]>(`${base.value}/model-access`)
    ])
    if (!lifecycle.isCurrent(request)) return
    org.value = loadedOrg
    members.value = loadedMembers?.items ? loadedMembers : { items: [], total: 0, offset: 0, limit: 100 }
    projects.value = loadedProjects ?? []
    models.value = loadedModels ?? []
  } catch (e: any) { if (lifecycle.isCurrent(request)) error.value = e.message }
  finally { if (lifecycle.isCurrent(request)) loading.value = false }
}
watch(id, () => void load(), { immediate: true })
</script>

<template>
  <header class="page-header"><div><button class="back-link" @click="router.push('/org-units')">← 返回组织管理</button><h1>{{ org?.name || '组织详情' }}</h1><span v-if="org" class="subtitle">{{ kindLabel[org.orgType] || org.orgType }} · {{ org.archivedAt ? '已归档' : org.enabled ? '启用' : '停用' }}</span></div><button @click="load">刷新</button></header>
  <p v-if="error" class="state error">{{ error }}</p>
  <p v-if="loading" class="state">正在加载组织…</p>
  <template v-else-if="org">
    <nav class="tabs">
      <button :class="{ active: tab === 'overview' }" @click="tab = 'overview'">概览</button>
      <button :class="{ active: tab === 'members' }" data-tab="members" @click="tab = 'members'">成员</button>
      <button :class="{ active: tab === 'projects' }" data-tab="projects" @click="tab = 'projects'">项目</button>
      <button :class="{ active: tab === 'models' }" data-tab="models" @click="tab = 'models'">模型权限</button>
    </nav>
    <section v-if="tab === 'overview'" class="panel">
      <h2>组织概览</h2>
      <p>说明：{{ org.description || '—' }}</p>
      <p>成员：{{ org.memberCount }} · 项目：{{ org.activeProjectCount }} · 模型：{{ org.modelCount }} · 有效 Key：{{ org.activeKeyCount }}</p>
      <div v-if="org.budget || org.usage" class="detail-grid">
        <article class="panel metric-block"><span>项目预算合计</span><strong class="small-strong">{{ org.budget?.availableCny == null ? '不限额' : formatCny(org.budget.totalLimitCny) }}</strong><small>包含项目 {{ org.budget?.projectCount ?? 0 }} 个</small></article>
        <article class="panel metric-block"><span>已用 / 预占</span><strong class="small-strong">{{ formatCny(org.budget?.spentCny || '0') }} / {{ formatCny(org.budget?.reservedCny || '0') }}</strong><small>占用合计 {{ formatCny(org.budget?.occupiedCny || '0') }}</small></article>
        <article class="panel metric-block"><span>可用额度</span><strong class="small-strong">{{ org.budget?.availableCny == null ? '不限额' : formatCny(org.budget.availableCny) }}</strong><small v-if="org.budget?.usagePercent != null">预算使用 {{ org.budget.usagePercent }}%</small></article>
        <article class="panel metric-block"><span>近 30 天请求</span><strong class="small-strong">{{ org.usage?.requests ?? 0 }}</strong><small>活跃成员 {{ org.usage?.activeAccounts ?? 0 }}</small></article>
        <article class="panel metric-block"><span>近 30 天 Token</span><strong class="small-strong">{{ tokens(org.usage?.totalTokens) }}</strong></article>
        <article class="panel metric-block"><span>近 30 天采购成本</span><strong class="small-strong">{{ formatCny(org.usage?.costCny || '0') }}</strong><small>最后使用 {{ org.usage?.lastUsedAt ? new Date(org.usage.lastUsedAt).toLocaleString() : '—' }}</small></article>
      </div>
      <p v-if="org.budget?.alertProjectCount">{{ org.budget.alertProjectCount }} 个项目接近或达到预算。</p>
      <p v-if="org.departmentProject">部门预算项目：<button class="back-link" @click="router.push(`/projects/${org.departmentProject.id}?tab=budget`)">{{ org.departmentProject.name }}</button></p>
      <p v-else>部门预算项目：区域部门的预算由业务项目承载。</p>
    </section>
    <section v-if="tab === 'members'" class="panel table-panel"><h2>组织成员</h2>
      <table v-if="members.items.length"><thead><tr><th>成员</th><th>组织角色</th><th>状态</th></tr></thead><tbody><tr v-for="member in members.items" :key="member.accountId"><td>{{ member.membership.account.displayName }}<small>{{ member.membership.account.email }}</small></td><td>{{ member.role === 'LEADER' ? '负责人' : '成员' }}</td><td>{{ member.membership.status }}</td></tr></tbody></table>
      <p v-else class="empty">暂无成员</p>
    </section>
    <section v-if="tab === 'projects'" class="panel table-panel"><h2>关联项目</h2>
      <table v-if="projects.length"><thead><tr><th>项目</th><th>类型</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="project in projects" :key="project.id"><td>{{ project.name }}<small>{{ project.code }}</small></td><td>{{ project.category === 'DEPARTMENT' ? '部门预算' : '业务项目' }}</td><td>{{ project.status }}</td><td><button @click="router.push(`/projects/${project.id}`)">详情</button></td></tr></tbody></table>
      <p v-else class="empty">暂无关联项目</p>
    </section>
    <section v-if="tab === 'models'" class="panel"><h2>模型权限</h2>
      <ul><li v-for="model in models" :key="model.publicModel.id">{{ model.publicModel.displayName }}<small class="mono">{{ model.publicModel.id }}</small></li></ul>
      <p v-if="!models.length" class="empty">未配置模型权限</p>
    </section>
  </template>
</template>
