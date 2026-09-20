<script setup lang="ts">
import { onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import type { Project } from '../projects'
import Drawer from '../components/Drawer.vue'

const router = useRouter(), lifecycle = createRequestLifecycle()
const rows = ref<Page<Project>>({ items: [], total: 0, offset: 0, limit: 20 })
const organizations = ref<any[]>([])
const filters = reactive({ q: '', ownerOrgUnitId: '', category: '', status: 'ACTIVE', offset: 0 })
const loading = ref(false), error = ref('')
const open = ref(false), pending = ref(false), formError = ref('')
const form = reactive({ ownerOrgUnitId: '', code: '', name: '', description: '' })
let alive = true, lastRoute = ''
function query() {
  const params = new URLSearchParams({ status: filters.status, offset: String(filters.offset), limit: '20' })
  if (filters.q.trim()) params.set('q', filters.q.trim())
  if (filters.ownerOrgUnitId) params.set('ownerOrgUnitId', filters.ownerOrgUnitId)
  if (filters.category) params.set('category', filters.category)
  return params.toString()
}
async function loadOrganizations() {
  try { organizations.value = (await api<Page<any>>('/api/v1/admin/org-units?kind=REGION&limit=100')).items ?? [] }
  catch { organizations.value = [] }
}
async function create() {
  if (pending.value || !form.ownerOrgUnitId || !form.code.trim() || !form.name.trim()) return
  pending.value = true; formError.value = ''
  try {
    await api('/api/v1/admin/projects', { method: 'POST', body: JSON.stringify({ ...form, category: 'BUSINESS' }) })
    open.value = false; form.ownerOrgUnitId = ''; form.code = ''; form.name = ''; form.description = ''
    filters.offset = 0; await load()
  } catch (e: any) { formError.value = e.message }
  finally { pending.value = false }
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
  filters.q = values.q || ''; filters.ownerOrgUnitId = values.ownerOrgUnitId || ''
  filters.status = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(values.status) ? values.status : 'ACTIVE'
  filters.category = ['BUSINESS', 'DEPARTMENT'].includes(values.category) ? values.category : ''
  filters.offset = Number(values.offset || 0); void load()
  void loadOrganizations()
}, { immediate: true, deep: true })
onUnmounted(() => { alive = false; lifecycle.dispose() })
</script>

<template>
  <header class="page-header"><div><p>PROJECTS</p><h1>项目管理</h1><span class="subtitle">组织项目、负责人、Key 与独立预算</span></div><button class="primary" @click="open = true">新建项目</button></header>
  <form class="panel form-row" @submit.prevent="filters.offset = 0; load()"><input v-model="filters.q" aria-label="搜索项目" placeholder="项目名称或编码"><select v-model="filters.ownerOrgUnitId" aria-label="所属组织"><option value="">全部组织</option><option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option></select><select v-model="filters.category" aria-label="项目类型"><option value="">全部类型</option><option value="BUSINESS">业务项目</option><option value="DEPARTMENT">部门预算</option></select><select v-model="filters.status" aria-label="项目状态"><option value="ACTIVE">启用</option><option value="SUSPENDED">停用</option><option value="ARCHIVED">归档</option></select><button :disabled="loading">查询</button></form>
  <p v-if="error" class="state error" role="alert">{{ error }}</p><p v-if="loading" class="state">正在加载项目…</p>
  <section v-else class="panel table-panel"><table v-if="rows.items.length"><thead><tr><th>项目 / 编码</th><th>所属组织</th><th>类型</th><th>状态</th><th>成员</th><th>说明</th></tr></thead><tbody>
    <tr v-for="project in rows.items" :key="project.id"><td><button class="back-link" @click="router.push(`/projects/${project.id}`)">{{ project.name }}</button><small>{{ project.code }}</small></td><td>{{ project.region.name }}</td><td>{{ project.category === 'DEPARTMENT' ? '部门预算' : '业务项目' }}</td><td>{{ project.status === 'ACTIVE' ? '启用' : project.status === 'SUSPENDED' ? '停用' : '归档' }}</td><td>{{ project.members?.length || 0 }}</td><td>{{ project.description || '—' }}</td></tr>
  </tbody></table><p v-else class="empty">暂无项目</p></section>
  <Drawer :open="open" title="新建业务项目" description="项目归属区域部门，并使用独立项目预算。" @close="open = false">
    <form id="create-project-form" class="stack-form" @submit.prevent="create">
      <label>所属组织<select v-model="form.ownerOrgUnitId" required><option value="">请选择区域部门</option><option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option></select></label>
      <label>项目编码<input v-model="form.code" required maxlength="60"></label>
      <label>项目名称<input v-model="form.name" required maxlength="120"></label>
      <label>说明<textarea v-model="form.description" maxlength="2000"></textarea></label>
      <p v-if="formError" class="state error">{{ formError }}</p>
    </form>
    <template #footer><button @click="open = false">取消</button><button class="primary" type="submit" form="create-project-form" :disabled="pending || !form.ownerOrgUnitId || !form.code.trim() || !form.name.trim()">创建</button></template>
  </Drawer>
</template>
