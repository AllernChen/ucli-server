<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const loading = ref(true)
const error = ref('')
const orgs = ref<any[]>([])
const form = ref({ name: '', slug: '', timezone: '' })

async function load() {
  loading.value = true; error.value = ''
  try { orgs.value = await api('/api/v1/admin/organizations') }
  catch (value: any) { error.value = value.message } finally { loading.value = false }
}
async function create() {
  if (!form.value.name || !form.value.slug) return error.value = '请填写名称与 slug'
  try {
    await api('/api/v1/admin/organizations', { method: 'POST', body: JSON.stringify({ name: form.value.name, slug: form.value.slug, timezone: form.value.timezone || 'UTC' }) })
    form.value = { name: '', slug: '', timezone: '' }
    await load()
  } catch (value: any) { error.value = value.message }
}
async function toggle(org: any) {
  try { await api(`/api/v1/admin/organizations/${org.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !org.enabled }) }); await load() }
  catch (value: any) { error.value = value.message }
}
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>组织</h1></div><button @click="load">刷新数据</button></header>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <section class="panel form-panel">
      <h2>新建组织</h2>
      <div class="form-row">
        <input v-model="form.name" placeholder="名称">
        <input v-model="form.slug" placeholder="slug（如 my-org）">
        <input v-model="form.timezone" placeholder="时区（默认 UTC）">
        <button class="primary" @click="create">新建组织</button>
      </div>
    </section>
    <section class="panel">
      <h2>组织列表</h2>
      <table v-if="orgs.length">
        <thead><tr><th>名称</th><th>slug</th><th>时区</th><th>成员数</th><th>设备数</th><th>状态</th><th>操作</th></tr></thead>
        <tbody><tr v-for="org in orgs" :key="org.id"><td>{{ org.name }}</td><td class="mono">{{ org.slug }}</td><td>{{ org.timezone }}</td><td>{{ org._count.memberships }}</td><td>{{ org._count.devices }}</td><td>{{ org.enabled ? '启用' : '停用' }}</td><td><div class="actions"><button @click="toggle(org)">{{ org.enabled ? '停用' : '启用' }}</button></div></td></tr></tbody>
      </table>
      <p v-else class="empty">暂无组织</p>
    </section>
  </template>
</template>
