<script setup lang="ts">
import { onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import type { Project } from '../projects'

const router = useRouter(), lifecycle = createRequestLifecycle()
const rows = ref<Page<Project>>({ items: [], total: 0, offset: 0, limit: 20 })
const filters = reactive({ q: '', regionId: '', status: 'ACTIVE', offset: 0 })
const loading = ref(false), error = ref('')
let alive = true, lastRoute = ''
function query() {
  const params = new URLSearchParams({ status: filters.status, offset: String(filters.offset), limit: '20' })
  if (filters.q.trim()) params.set('q', filters.q.trim())
  if (filters.regionId) params.set('regionId', filters.regionId)
  return params.toString()
}
async function load() {
  const request = lifecycle.next(); loading.value = true; error.value = ''
  try {
    const result = await api<Page<Project>>(`/api/v1/admin/projects?${query()}`)
    if (lifecycle.isCurrent(request)) rows.value = result
  } catch (e: any) { if (lifecycle.isCurrent(request)) error.value = e.message }
  finally { if (lifecycle.isCurrent(request)) loading.value = false }
}
watch(() => new URLSearchParams(window.location.search).toString(), () => {
  const values = Object.fromEntries(new URLSearchParams(window.location.search))
  const route = JSON.stringify(values); if (route === lastRoute) return; lastRoute = route
  filters.q = values.q || ''; filters.regionId = values.regionId || ''
  filters.status = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(values.status) ? values.status : 'ACTIVE'
  filters.offset = Number(values.offset || 0); void load()
}, { immediate: true, deep: true })
onUnmounted(() => { alive = false; lifecycle.dispose() })
</script>

<template>
  <header class="page-header"><div><p>PROJECTS</p><h1>项目管理</h1><span class="subtitle">区域项目、负责人、Key 与独立预算</span></div></header>
  <form class="panel form-row" @submit.prevent="filters.offset = 0; load()"><input v-model="filters.q" aria-label="搜索项目" placeholder="项目名称或编码"><input v-model="filters.regionId" aria-label="区域 ID" placeholder="区域 ID"><select v-model="filters.status" aria-label="项目状态"><option value="ACTIVE">启用</option><option value="SUSPENDED">停用</option><option value="ARCHIVED">归档</option></select><button :disabled="loading">查询</button></form>
  <p v-if="error" class="state error" role="alert">{{ error }}</p><p v-if="loading" class="state">正在加载项目…</p>
  <section v-else class="panel table-panel"><table v-if="rows.items.length"><thead><tr><th>项目 / 编码</th><th>区域</th><th>状态</th><th>成员</th><th>说明</th></tr></thead><tbody>
    <tr v-for="project in rows.items" :key="project.id"><td><button class="back-link" @click="router.push(`/projects/${project.id}`)">{{ project.name }}</button><small>{{ project.code }}</small></td><td>{{ project.region.name }}</td><td>{{ project.status === 'ACTIVE' ? '启用' : project.status === 'SUSPENDED' ? '停用' : '归档' }}</td><td>{{ project.members?.length || 0 }}</td><td>{{ project.description || '—' }}</td></tr>
  </tbody></table><p v-else class="empty">暂无项目</p></section>
</template>
