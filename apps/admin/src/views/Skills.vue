<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'
import { toast } from '../toast'

const loading = ref(true)
const error = ref('')
const skills = ref<any[]>([])
const form = ref({ slug: '', name: '', description: '' })
const uploads = ref<Record<string, { version: string; file: File | null }>>({})

async function load() {
  loading.value = true; error.value = ''
  try {
    skills.value = await api('/api/v1/skills/admin')
    for (const skill of skills.value) if (!uploads.value[skill.id]) uploads.value[skill.id] = { version: '', file: null }
  } catch (value: any) { error.value = value.message } finally { loading.value = false }
}
async function create() {
  if (!form.value.slug || !form.value.name) return error.value = '请填写 slug 与名称'
  try {
    await api('/api/v1/skills/admin', { method: 'POST', body: JSON.stringify(form.value) })
    form.value = { slug: '', name: '', description: '' }
    toast('技能已创建')
    await load()
  } catch (value: any) { error.value = value.message }
}
function pickFile(skillId: string, event: Event) {
  const input = event.target as HTMLInputElement
  uploads.value[skillId] = { version: uploads.value[skillId]?.version || '', file: input.files?.[0] || null }
}
async function upload(skillId: string) {
  const u = uploads.value[skillId]
  if (!u || !u.version || !u.file) return error.value = '请填写版本号并选择 ZIP 文件'
  const data = new FormData()
  data.append('version', u.version)
  data.append('file', u.file)
  try {
    await api(`/api/v1/skills/admin/${skillId}/versions`, { method: 'POST', body: data })
    delete uploads.value[skillId]
    toast('版本已上传')
    await load()
  } catch (value: any) { error.value = value.message }
}
async function publish(versionId: string) {
  try { await api(`/api/v1/skills/admin/${versionId}/publish`, { method: 'POST' }); toast('技能已发布'); await load() }
  catch (value: any) { error.value = value.message }
}
async function revoke(versionId: string) {
  try { await api(`/api/v1/skills/admin/${versionId}/revoke`, { method: 'POST' }); toast('技能已撤销'); await load() }
  catch (value: any) { error.value = value.message }
}
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>技能超市</h1></div><button @click="load">刷新数据</button></header>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <section class="panel form-panel">
      <h2>新建技能</h2>
      <div class="form-row">
        <input v-model="form.slug" placeholder="slug（如 my-skill）">
        <input v-model="form.name" placeholder="名称">
        <input v-model="form.description" placeholder="描述">
        <button class="primary" @click="create">新建技能</button>
      </div>
    </section>
    <section class="panel">
      <h2>技能列表</h2>
      <table v-if="skills.length">
        <thead><tr><th>名称</th><th>slug</th><th>描述</th><th>版本</th><th>上传新版本</th></tr></thead>
        <tbody>
          <tr v-for="skill in skills" :key="skill.id">
            <td>{{ skill.name }}</td>
            <td class="mono">{{ skill.slug }}</td>
            <td>{{ skill.description }}</td>
            <td>
              <div v-for="version in skill.versions" :key="version.id" class="key-chip">
                v{{ version.version }} · {{ version.status }}
                <button v-if="version.status === 'DRAFT'" @click="publish(version.id)">发布</button>
                <button v-if="version.status === 'PUBLISHED'" @click="revoke(version.id)">撤销</button>
              </div>
              <div v-if="!skill.versions.length" class="mono">无</div>
            </td>
            <td>
              <div class="inline">
                <input v-model="uploads[skill.id].version" placeholder="版本号（如 1.0.0）">
                <input type="file" accept=".zip" @change="pickFile(skill.id, $event)">
                <button @click="upload(skill.id)">上传</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">暂无技能，请先在上方新建</p>
    </section>
  </template>
</template>
