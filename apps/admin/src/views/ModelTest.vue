<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import type { AdminModelTestResponse, ChannelDetail, ChannelModel, ChannelSummary, Page } from '../types/catalog'
import StatusBadge from '../components/StatusBadge.vue'

type Message = { role: 'system' | 'user' | 'assistant'; content: string }
const channels = ref<ChannelSummary[]>([]); const channelId = ref(''); const channel = ref<ChannelDetail | null>(null)
const models = ref<ChannelModel[]>([]); const channelModelId = ref(''); const keyId = ref('')
const messages = ref<Message[]>([{ role: 'system', content: 'You are a helpful assistant.' }])
const prompt = ref(''); const temperature = ref(0.2); const maxTokens = ref(1024)
const sending = ref(false); const error = ref(''); const result = ref<AdminModelTestResponse | null>(null)
const selectedModel = computed(() => models.value.find(model => model.id === channelModelId.value))

async function loadChannels() {
  const page = await api<Page<ChannelSummary>>('/api/v1/admin/channels?enabled=true&limit=200&offset=0')
  channels.value = page.items; channelId.value ||= page.items[0]?.id || ''
}
async function loadChannel() {
  if (!channelId.value) return
  error.value = ''
  try {
    const [detail, page] = await Promise.all([
      api<ChannelDetail>(`/api/v1/admin/channels/${channelId.value}`),
      api<Page<ChannelModel>>(`/api/v1/admin/channels/${channelId.value}/models?limit=200&offset=0`)
    ])
    channel.value = detail; models.value = page.items.filter(model => model.enabled)
    channelModelId.value = models.value.some(model => model.id === channelModelId.value) ? channelModelId.value : models.value[0]?.id || ''
    keyId.value = detail.keys.some(key => key.id === keyId.value) ? keyId.value : ''
  } catch (value: any) { error.value = value.message }
}
async function send() {
  if (!prompt.value.trim() || !channelModelId.value) return
  messages.value.push({ role: 'user', content: prompt.value.trim() }); prompt.value = ''; sending.value = true; error.value = ''
  try {
    const response = await api<AdminModelTestResponse>('/api/v1/admin/model-tests', { method: 'POST', body: JSON.stringify({
      channelModelId: channelModelId.value, messages: messages.value, temperature: temperature.value,
      maxTokens: maxTokens.value, ...(keyId.value ? { keyId: keyId.value } : {})
    }) })
    result.value = response
    if (response.assistantMessage) messages.value.push({ role: 'assistant', content: response.assistantMessage })
    else error.value = response.errorCode || `上游返回 HTTP ${response.statusCode}`
  } catch (value: any) { error.value = value.message } finally { sending.value = false }
}
function clearConversation() { messages.value = [{ role: 'system', content: 'You are a helpful assistant.' }]; prompt.value = ''; result.value = null; error.value = '' }
watch(channelId, loadChannel)
onMounted(async () => { try { await loadChannels(); await loadChannel() } catch (value: any) { error.value = value.message } })
</script>

<template>
  <header class="page-header"><div><p>FIXED ROUTE LAB</p><h1>模型对话测试</h1><span class="subtitle">固定渠道模型测试，不走故障切换；消息仅保存在当前浏览器内存，不会持久化。</span></div><button @click="clearConversation">清空对话</button></header>
  <p v-if="error" class="state error">{{ error }}</p>
  <div class="test-lab">
    <section class="panel test-settings"><h2>路由与参数</h2>
      <label>渠道<select v-model="channelId"><option v-for="item in channels" :key="item.id" :value="item.id">{{ item.name }} · {{ item.provider }}</option></select></label>
      <label>渠道模型<select v-model="channelModelId"><option v-for="model in models" :key="model.id" :value="model.id">{{ model.publicModelId }} → {{ model.upstreamModel }} · {{ model.protocol }}</option></select></label>
      <div v-if="selectedModel" class="route-summary"><StatusBadge :status="selectedModel.health" /><span>{{ selectedModel.protocol }}</span><small>{{ selectedModel.lastTestedAt ? `上次测试 ${new Date(selectedModel.lastTestedAt).toLocaleString()}` : '尚未测试' }}</small></div>
      <label>Key（可选）<select v-model="keyId"><option value="">按渠道策略选择</option><option v-for="key in channel?.keys.filter(item => item.enabled) || []" :key="key.id" :value="key.id">••••{{ key.suffix }} · {{ key.health }}</option></select></label>
      <label>Temperature <span>{{ temperature }}</span><input v-model.number="temperature" type="range" min="0" max="2" step="0.1"></label>
      <label>最大输出 Token<input v-model.number="maxTokens" type="number" min="1" max="8192"></label>
      <label>System 提示<textarea v-model="messages[0]!.content" rows="5" maxlength="20000"></textarea></label>
    </section>
    <section class="panel conversation"><div class="conversation-list">
      <article v-for="(message, index) in messages.slice(1)" :key="index" :class="['message', message.role]"><span>{{ message.role === 'user' ? '你' : '模型' }}</span><p>{{ message.content }}</p></article>
      <p v-if="messages.length === 1" class="empty">输入消息开始固定渠道对话测试</p>
    </div><form class="composer" @submit.prevent="send"><textarea v-model="prompt" rows="4" maxlength="20000" placeholder="输入测试消息；点击发送提交完整多轮上下文"></textarea><button class="primary" :disabled="sending || !prompt.trim() || !channelModelId">{{ sending ? '请求中…' : '发送' }}</button></form></section>
    <section class="panel test-metrics"><h2>本次结果</h2><template v-if="result"><StatusBadge :status="result.health" />
      <dl><dt>HTTP / 状态</dt><dd>{{ result.statusCode }} · {{ result.ok ? '成功' : result.errorCode }}</dd><dt>延迟 / 首字</dt><dd>{{ result.latencyMs }}ms / {{ result.firstTokenMs ?? '—' }}</dd><dt>输入 / 输出 Token</dt><dd>{{ result.inputTokens }} / {{ result.outputTokens }}</dd><dt>实际 Key</dt><dd>••••{{ result.keySuffix || '—' }}</dd><dt>采购成本</dt><dd>${{ result.estimatedProcurementCostUsd }}</dd><dt>成本来源</dt><dd>{{ result.appliedCost.source }}</dd><dt>输入 / 输出 $/M</dt><dd>{{ result.appliedCost.inputPerMillion }} / {{ result.appliedCost.outputPerMillion }}</dd></dl>
      <details><summary>原始 JSON</summary><pre>{{ JSON.stringify(result.rawResponse, null, 2) }}</pre></details></template><p v-else class="empty">发送后展示实际路由、Token、延迟和采购成本</p></section>
  </div>
</template>
