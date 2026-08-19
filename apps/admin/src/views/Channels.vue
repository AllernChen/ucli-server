<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'
import { toast } from '../toast'

const loading = ref(true)
const error = ref('')
const notice = ref('')
const channels = ref<any[]>([])
const form = ref({ name: '', provider: '', protocol: 'OPENAI', baseUrl: '', priority: '', weight: '', timeoutMs: '', maxRetries: '', keySelection: 'WEIGHTED_RANDOM' })
const keyInput = ref<Record<string, string>>({})
const editing = ref<string | null>(null)
const editForm = ref({ name: '', provider: '', protocol: 'OPENAI', baseUrl: '', priority: '', weight: '', timeoutMs: '', maxRetries: '', keySelection: 'WEIGHTED_RANDOM' })

async function load() {
  loading.value = true; error.value = ''
  try { channels.value = await api('/api/v1/admin/channels') }
  catch (value: any) { error.value = value.message } finally { loading.value = false }
}
async function create() {
  if (!form.value.name || !form.value.provider || !form.value.baseUrl) return error.value = '请填写名称、供应商与 baseUrl'
  try {
    await api('/api/v1/admin/channels', { method: 'POST', body: JSON.stringify({
      name: form.value.name, provider: form.value.provider, protocol: form.value.protocol, baseUrl: form.value.baseUrl,
      priority: Number(form.value.priority) || 0, weight: Number(form.value.weight) || 1,
      timeoutMs: Number(form.value.timeoutMs) || 300000, maxRetries: Number(form.value.maxRetries) || 0,
      keySelection: form.value.keySelection
    }) })
    form.value = { name: '', provider: '', protocol: 'OPENAI', baseUrl: '', priority: '', weight: '', timeoutMs: '', maxRetries: '', keySelection: 'WEIGHTED_RANDOM' }
    toast('渠道已创建')
    await load()
  } catch (value: any) { error.value = value.message }
}
async function addKey(id: string) {
  const key = (keyInput.value[id] || '').trim()
  if (!key) return error.value = '请输入 Key'
  try {
    await api(`/api/v1/admin/channels/${id}/keys`, { method: 'POST', body: JSON.stringify({ key }) })
    keyInput.value[id] = ''
    toast('Key 已添加')
    await load()
  } catch (value: any) { error.value = value.message }
}
async function toggle(channel: any) {
  try { await api(`/api/v1/admin/channels/${channel.id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled: !channel.enabled }) }); toast('渠道已更新'); await load() }
  catch (value: any) { error.value = value.message }
}
async function test(id: string) {
  notice.value = '正在测试…'
  try {
    const result = await api(`/api/v1/admin/channels/${id}/test`, { method: 'POST' })
    notice.value = `测试${result.ok ? '通过' : '失败'}：状态 ${result.status}，延迟 ${result.latencyMs}ms，健康 ${result.health}`
  } catch (value: any) { notice.value = value.message }
}
async function toggleKey(channelId: string, key: any) {
  try { await api(`/api/v1/admin/channels/${channelId}/keys/${key.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !key.enabled }) }); toast('Key 已更新'); await load() }
  catch (value: any) { error.value = value.message }
}
function startEdit(channel: any) {
  editing.value = channel.id
  editForm.value = {
    name: channel.name, provider: channel.provider, protocol: channel.protocol, baseUrl: channel.baseUrl,
    priority: String(channel.priority ?? 0), weight: String(channel.weight ?? 1),
    timeoutMs: String(channel.timeoutMs ?? 300000), maxRetries: String(channel.maxRetries ?? 1),
    keySelection: channel.keySelection || 'WEIGHTED_RANDOM'
  }
}
async function saveEdit(id: string) {
  try {
    await api(`/api/v1/admin/channels/${id}`, { method: 'PATCH', body: JSON.stringify({
      name: editForm.value.name, provider: editForm.value.provider, protocol: editForm.value.protocol, baseUrl: editForm.value.baseUrl,
      priority: Number(editForm.value.priority) || 0, weight: Number(editForm.value.weight) || 1,
      timeoutMs: Number(editForm.value.timeoutMs) || 300000, maxRetries: Number(editForm.value.maxRetries) || 0,
      keySelection: editForm.value.keySelection
    }) })
    editing.value = null
    toast('渠道已保存')
    await load()
  } catch (value: any) { error.value = value.message }
}
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>渠道与 Key</h1></div><button @click="load">刷新数据</button></header>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <section class="panel form-panel">
      <h2>新建渠道</h2>
      <div class="form-row">
        <input v-model="form.name" placeholder="名称（如 OpenAI）">
        <input v-model="form.provider" placeholder="供应商（如 openai）">
        <select v-model="form.protocol"><option value="OPENAI">OPENAI</option><option value="ANTHROPIC">ANTHROPIC</option><option value="GEMINI">GEMINI</option></select>
        <input v-model="form.baseUrl" placeholder="baseUrl（OpenAI 兼容端点，如 https://api.deepseek.com）">
        <select v-model="form.keySelection"><option value="WEIGHTED_RANDOM">加权随机</option><option value="ROUND_ROBIN">轮询</option></select>
        <input v-model="form.priority" type="number" placeholder="优先级">
        <input v-model="form.weight" type="number" placeholder="权重">
        <input v-model="form.timeoutMs" type="number" placeholder="超时ms">
        <input v-model="form.maxRetries" type="number" placeholder="重试次数">
        <button class="primary" @click="create">新建渠道</button>
      </div>
    </section>
    <section class="panel">
      <h2>渠道列表</h2>
      <p v-if="notice" class="state">{{ notice }}</p>
      <table v-if="channels.length">
        <thead><tr><th>名称</th><th>供应商</th><th>协议</th><th>baseUrl</th><th>健康</th><th>状态</th><th>Keys / 添加</th><th>操作</th></tr></thead>
        <tbody>
          <template v-for="channel in channels" :key="channel.id">
          <tr>
            <td>{{ channel.name }}</td>
            <td>{{ channel.provider }}</td>
            <td>{{ channel.protocol }}</td>
            <td class="mono">{{ channel.baseUrl }}</td>
            <td><i :class="channel.health === 'HEALTHY' ? 'ok' : 'bad'"></i>{{ channel.health }}</td>
            <td>{{ channel.enabled ? '启用' : '停用' }}</td>
            <td>
              <div class="keys"><span v-for="key in channel.keys" :key="key.id" class="key-chip">…{{ key.suffix }}<i :class="key.enabled ? 'ok' : 'bad'"></i><button @click="toggleKey(channel.id, key)">{{ key.enabled ? '停用' : '启用' }}</button></span><span v-if="!channel.keys.length" class="mono">无</span></div>
              <div class="inline"><input v-model="keyInput[channel.id]" placeholder="粘贴 API Key"><button @click="addKey(channel.id)">添加</button></div>
            </td>
            <td>
              <div class="actions">
                <button @click="toggle(channel)">{{ channel.enabled ? '停用' : '启用' }}</button>
                <button @click="test(channel.id)">测试</button>
                <button @click="startEdit(channel)">编辑</button>
              </div>
            </td>
          </tr>
          <tr v-if="editing === channel.id">
            <td colspan="8">
              <div class="inline">
                <input v-model="editForm.name" placeholder="名称">
                <input v-model="editForm.provider" placeholder="供应商">
                <select v-model="editForm.protocol"><option value="OPENAI">OPENAI</option><option value="ANTHROPIC">ANTHROPIC</option><option value="GEMINI">GEMINI</option></select>
                <input v-model="editForm.baseUrl" placeholder="baseUrl">
                <select v-model="editForm.keySelection"><option value="WEIGHTED_RANDOM">加权随机</option><option value="ROUND_ROBIN">轮询</option></select>
                <input v-model="editForm.priority" type="number" placeholder="优先级">
                <input v-model="editForm.weight" type="number" placeholder="权重">
                <input v-model="editForm.timeoutMs" type="number" placeholder="超时ms">
                <input v-model="editForm.maxRetries" type="number" placeholder="重试次数">
                <button class="primary" @click="saveEdit(channel.id)">保存</button>
                <button @click="editing = null">取消</button>
              </div>
            </td>
          </tr>
          </template>
        </tbody>
      </table>
      <p v-else class="empty">暂无渠道，请先在上方新建</p>
    </section>
  </template>
</template>
