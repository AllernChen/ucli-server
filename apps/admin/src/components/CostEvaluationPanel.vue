<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { api } from '../api'
import { formatCny } from '../currency'
import { effectiveCostSource, formatProcurementPrice } from '../procurement-costs'
import type { CostEvaluation } from '../types/catalog'

const props = defineProps<{ channelModelId: string; timezone: string }>()
const emit = defineEmits<{ evaluated: [result: CostEvaluation] }>()
function localDateTimeInput() {
  const value = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
  return value.toISOString().slice(0, 16)
}
const form = reactive({ at: localDateTimeInput(), inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0, reasoningTokens: 0 })
const loading = ref(false)
const error = ref('')
const result = ref<CostEvaluation | null>(null)
let requestToken = 0
async function evaluate() {
  const current = ++requestToken
  loading.value = true; error.value = ''
  try {
    const at = new Date(form.at)
    if (!Number.isFinite(at.getTime())) throw new Error('请选择有效的测试时间')
    const next = await api<CostEvaluation>(`/api/v1/admin/channel-models/${props.channelModelId}/cost-evaluation`, {
      method: 'POST', body: JSON.stringify({ ...form, at: at.toISOString() })
    })
    if (current !== requestToken) return
    result.value = next; emit('evaluated', next)
  } catch (value: any) {
    if (current === requestToken) error.value = value.message
  } finally { if (current === requestToken) loading.value = false }
}
watch(() => props.channelModelId, () => { requestToken++; result.value = null; error.value = '' })
</script>

<template>
  <form class="cost-evaluation" @submit.prevent="evaluate"><div class="section-header"><div><h2>时间点试算</h2><p class="muted">选择一个真实时刻，按 {{ timezone }} 判断最终价格来源。</p></div><button class="primary" :disabled="loading">{{ loading ? '计算中…' : '计算采购成本' }}</button></div>
    <div class="cost-evaluation-inputs"><label>测试时间<input v-model="form.at" type="datetime-local" required></label><label>输入 Token<input v-model.number="form.inputTokens" type="number" min="0" step="1"></label><label>输出 Token<input v-model.number="form.outputTokens" type="number" min="0" step="1"></label><label>缓存 Token<input v-model.number="form.cachedTokens" type="number" min="0" step="1"></label><label>推理 Token<input v-model.number="form.reasoningTokens" type="number" min="0" step="1"></label></div>
    <p v-if="error" class="state error">{{ error }}</p>
    <div v-if="result" class="cost-evaluation-result"><template v-if="result.cost && result.estimate"><article><span>最终采购成本</span><strong>{{ formatCny(result.estimate.totalCost) }}</strong><small>{{ formatProcurementPrice(result.cost) }}</small></article><article><span>命中来源</span><strong>{{ effectiveCostSource(result.cost) }}</strong><small>{{ new Date(result.at).toLocaleString() }} · {{ result.timezone }}</small></article><div class="cost-part-grid"><span>输入 {{ formatCny(result.estimate.inputCost) }}</span><span>输出 {{ formatCny(result.estimate.outputCost) }}</span><span>缓存 {{ formatCny(result.estimate.cachedCost) }}</span><span>推理 {{ formatCny(result.estimate.reasoningCost) }}</span></div></template><p v-else class="warning-panel">该时间点没有可用采购成本，请配置渠道规则或公共模型兜底价。</p></div>
  </form>
</template>
