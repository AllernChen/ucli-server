<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'
import { toast } from '../toast'

const loading = ref(true)
const error = ref('')
const models = ref<any[]>([])
const channels = ref<any[]>([])
const form = ref({ id: '', displayName: '', contextSize: '' })
const ability = ref<Record<string, any>>({})
const price = ref<Record<string, any>>({})

async function load() {
  loading.value = true; error.value = ''
  try {
    [models.value, channels.value] = await Promise.all([
      api('/api/v1/admin/models'), api('/api/v1/admin/channels')
    ])
    for (const model of models.value) {
      if (!ability.value[model.id]) ability.value[model.id] = { channelId: channels.value[0]?.id || '', protocol: 'OPENAI_CHAT', supportsStream: true, supportsTools: true, upstreamModel: '' }
      if (!price.value[model.id]) price.value[model.id] = { inputPerMillion: '', outputPerMillion: '', cachedPerMillion: '', reasoningPerMillion: '' }
    }
  } catch (value: any) { error.value = value.message } finally { loading.value = false }
}
async function create() {
  if (!form.value.id || !form.value.displayName) return error.value = '请填写模型 ID 与名称'
  try {
    await api('/api/v1/admin/models', { method: 'POST', body: JSON.stringify({ id: form.value.id, displayName: form.value.displayName, contextSize: Number(form.value.contextSize) || null }) })
    form.value = { id: '', displayName: '', contextSize: '' }
    toast('模型已创建')
    await load()
  } catch (value: any) { error.value = value.message }
}
async function addAbility(id: string) {
  const a = ability.value[id]
  if (!a || !a.channelId || !a.upstreamModel) return error.value = '请选择渠道并填写上游模型'
  try {
    await api(`/api/v1/admin/models/${id}/abilities`, { method: 'POST', body: JSON.stringify({ channelId: a.channelId, upstreamModel: a.upstreamModel, protocol: a.protocol, supportsStream: a.supportsStream !== false, supportsTools: a.supportsTools !== false }) })
    delete ability.value[id]
    toast('能力已添加')
    await load()
  } catch (value: any) { error.value = value.message }
}
async function addPrice(id: string) {
  const p = price.value[id]
  if (!p || p.inputPerMillion === '' || p.outputPerMillion === '') return error.value = '请填写输入与输出单价'
  try {
    await api(`/api/v1/admin/models/${id}/prices`, { method: 'POST', body: JSON.stringify({ inputPerMillion: Number(p.inputPerMillion), outputPerMillion: Number(p.outputPerMillion), cachedPerMillion: Number(p.cachedPerMillion) || 0, reasoningPerMillion: Number(p.reasoningPerMillion) || 0 }) })
    delete price.value[id]
    toast('定价已添加')
    await load()
  } catch (value: any) { error.value = value.message }
}
async function publish(id: string) {
  try { await api(`/api/v1/admin/models/${id}/publish`, { method: 'POST' }); toast('模型已发布'); await load() }
  catch (value: any) { error.value = value.message }
}
async function unpublish(id: string) {
  try { await api(`/api/v1/admin/models/${id}/unpublish`, { method: 'POST' }); toast('模型已下线'); await load() }
  catch (value: any) { error.value = value.message }
}
async function removeAbility(id: string, a: any) {
  try { await api(`/api/v1/admin/models/${id}/abilities`, { method: 'DELETE', body: JSON.stringify({ channelId: a.channelId, protocol: a.protocol }) }); toast('能力已删除'); await load() }
  catch (value: any) { error.value = value.message }
}
async function removePrice(id: string, priceId: string) {
  try { await api(`/api/v1/admin/models/${id}/prices/${priceId}`, { method: 'DELETE' }); toast('定价已删除'); await load() }
  catch (value: any) { error.value = value.message }
}
function channelName(id: string) { return channels.value.find(channel => channel.id === id)?.name || id }
onMounted(load)
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>模型目录</h1></div><button @click="load">刷新数据</button></header>
  <p v-if="loading" class="state">正在加载…</p>
  <p v-else-if="error" class="state error">{{ error }}</p>
  <template v-else>
    <section class="panel form-panel">
      <h2>新建模型</h2>
      <div class="form-row">
        <input v-model="form.id" placeholder="模型 ID（如 gpt-4o）">
        <input v-model="form.displayName" placeholder="显示名称">
        <input v-model="form.contextSize" type="number" placeholder="上下文长度（可选）">
        <button class="primary" @click="create">新建模型</button>
      </div>
    </section>
    <section class="panel">
      <h2>模型列表</h2>
      <table v-if="models.length">
        <thead><tr><th>ID</th><th>名称</th><th>上下文</th><th>状态</th><th>能力（渠道 / 上游模型）</th><th>定价</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="model in models" :key="model.id">
            <td class="mono">{{ model.id }}</td>
            <td>{{ model.displayName }}</td>
            <td>{{ model.contextSize || '—' }}</td>
            <td>{{ model.enabled ? '已发布' : '未发布' }}</td>
            <td>
              <div v-for="a in model.abilities" :key="a.channelId + a.protocol" class="key-chip">{{ channelName(a.channelId) }} → {{ a.upstreamModel }} ({{ a.protocol }}) <button @click="removeAbility(model.id, a)">删</button></div>
              <div v-if="!model.abilities.length" class="mono">无</div>
              <div class="inline">
                <select v-model="ability[model.id].channelId"><option v-for="channel in channels" :key="channel.id" :value="channel.id">{{ channel.name }}</option></select>
                <input v-model="ability[model.id].upstreamModel" placeholder="上游模型名">
                <select v-model="ability[model.id].protocol"><option value="OPENAI_CHAT">OPENAI_CHAT</option><option value="OPENAI_RESPONSES">OPENAI_RESPONSES</option><option value="ANTHROPIC_MESSAGES">ANTHROPIC_MESSAGES</option><option value="GEMINI">GEMINI</option></select>
                <button @click="addAbility(model.id)">加能力</button>
              </div>
            </td>
            <td>
              <div v-for="p in model.prices" :key="p.id" class="key-chip">in ${{ p.inputPerMillion }} / out ${{ p.outputPerMillion }} <button @click="removePrice(model.id, p.id)">删</button></div>
              <div v-if="!model.prices.length" class="mono">无</div>
              <div class="inline">
                <input v-model="price[model.id].inputPerMillion" placeholder="输入$/M">
                <input v-model="price[model.id].outputPerMillion" placeholder="输出$/M">
                <button @click="addPrice(model.id)">加价</button>
              </div>
            </td>
            <td>
              <div class="actions">
                <button v-if="!model.enabled" @click="publish(model.id)">发布</button>
                <button v-else @click="unpublish(model.id)">下线</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">暂无模型，请先在上方新建</p>
    </section>
  </template>
</template>
