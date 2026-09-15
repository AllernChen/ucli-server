<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import Decimal from 'decimal.js'
import { api } from '../api'
import { formatCny } from '../currency'
import { createRequestLifecycle } from '../device-grants'
import Drawer from './Drawer.vue'

const props = defineProps<{ id: string | null; query: string }>()
const emit = defineEmits<{ close: [] }>()
const lifecycle = createRequestLifecycle()
const loading = ref(false); const error = ref(''); const detail = ref<any>(null); const copied = ref(false); const copyError = ref('')
const open = computed(() => Boolean(props.id))
const number = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value) ? new Decimal(value).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '未提供'
const requestState = (value: string) => ({ SUCCESS: '成功', FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '已中断' }[value] || '未提供')
const billingState = (value: string) => ({ CONFIRMED: '已确认', ESTIMATED: '估算', UNKNOWN: '待核对', NO_CHARGE: '无费用' }[value] || '未提供')
const budgetStatus = (value: string) => ({ RESERVED: '已保留', RECONCILIATION_REQUIRED: '待核算', SETTLED: '已结算', RELEASED: '已释放' }[value] || value || '未提供')
function schedule(price: any) {
  if (!price?.daysOfWeek || price.startMinute === null || price.endMinute === null) return '未提供'
  const minute = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
  return `周 ${price.daysOfWeek.join(',')} · ${minute(price.startMinute)}–${minute(price.endMinute)}`
}
async function load() {
  const current = lifecycle.next(); copied.value = false; copyError.value = ''
  if (!props.id) { detail.value = null; loading.value = false; return }
  loading.value = true; error.value = ''; detail.value = null
  try { const result = await api(`/api/v1/usage/logs/${props.id}${props.query ? `?${props.query}` : ''}`); if (lifecycle.isCurrent(current)) detail.value = result }
  catch (value: any) { if (lifecycle.isCurrent(current)) error.value = value.message } finally { if (lifecycle.isCurrent(current)) loading.value = false }
}
async function copyRequestId() {
  const request = detail.value
  if (!request?.requestId) return
  copied.value = false; copyError.value = ''
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(request.requestId)
    if (detail.value === request) copied.value = true
  } catch { if (detail.value === request) copyError.value = '无法复制，请手动选择并复制上方请求 ID' }
}
watch(() => [props.id, props.query], load, { immediate: true })
onUnmounted(() => lifecycle.dispose())
</script>

<template>
  <Drawer :open="open" title="请求详情" description="历史价格和预算快照" @close="emit('close')">
    <p v-if="loading" class="state">正在加载…</p><p v-else-if="error" class="state error">{{ error }} <button @click="load">重试</button></p>
    <template v-else-if="detail">
      <div class="actions"><code>{{ detail.requestId }}</code><button aria-label="复制请求 ID" @click="copyRequestId">{{ copied ? '已复制' : '复制请求 ID' }}</button><RouterLink :to="`/analytics?${query}`">查看对应分析</RouterLink></div>
      <p v-if="copyError" class="state error" role="alert">{{ copyError }}</p>
      <dl class="detail-list"><dt>员工</dt><dd>{{ detail.employeeName || '未提供' }}</dd><dt>用量组</dt><dd>{{ detail.groupName || '未提供' }}</dd><dt>模型 / 渠道</dt><dd>{{ detail.publicModelId || '未提供' }} / {{ detail.channelName || '未提供' }}</dd><dt>完整请求成本</dt><dd>{{ formatCny(detail.costCny) }}</dd><dt>匹配部分成本</dt><dd>{{ formatCny(detail.matchedCostCny) }}</dd><dt>未分配路由成本差额</dt><dd>{{ formatCny(detail.unallocatedCostCny) }}</dd><dt>请求状态</dt><dd>{{ requestState(detail.requestState) }}</dd><dt>计费状态</dt><dd>{{ billingState(detail.billingState) }}</dd><template v-if="detail.budget"><dt>预算状态</dt><dd>{{ budgetStatus(detail.budget.status) }}</dd><dt>初始预估</dt><dd>{{ formatCny(detail.budget.initialEstimateCny) }}</dd><dt>追加预估</dt><dd>{{ formatCny(detail.budget.extendedCny) }}</dd><dt>累计预留</dt><dd>{{ formatCny(detail.budget.cumulativeReservedCny) }}</dd><dt>当前保留 / 已结算</dt><dd>{{ formatCny(detail.budget.currentHeldCny) }} / {{ formatCny(detail.budget.settledCny) }}</dd><dt>人工核算</dt><dd>{{ detail.budget.manualFinal ? '是' : '否' }}</dd></template><template v-else><dt>预算</dt><dd>{{ detail.budgetAvailability === 'NOT_FOUND' ? '未提供（历史预算记录不存在）' : detail.budgetAvailability === 'NOT_APPLICABLE' ? '不适用组预算' : '未提供' }}</dd></template></dl>
      <section v-if="detail.requestPrice" class="panel"><h3>请求级历史价格</h3><p>输入 {{ formatCny(detail.requestPrice.inputPerMillion) }} / 缓存 {{ formatCny(detail.requestPrice.cachedPerMillion) }} / 输出 {{ formatCny(detail.requestPrice.outputPerMillion) }} / 推理 {{ formatCny(detail.requestPrice.reasoningPerMillion) }} / 1M</p><p>{{ detail.requestPrice.ruleName || detail.requestPrice.source || '历史价格' }} · {{ detail.requestPrice.timezone || '未提供时区' }} · {{ detail.requestPrice.validFrom || '未提供' }} 至 {{ detail.requestPrice.validTo || '未提供' }} · {{ schedule(detail.requestPrice) }}</p></section><p v-else>请求级历史价格：未提供</p>
      <h3>路由与历史价格</h3><article v-for="route in detail.routes || []" :key="route.attempt" class="panel"><strong>#{{ route.attempt }} {{ route.channelName || '未提供' }}</strong><p>输入 {{ number(route.inputTokens) }} · 缓存 {{ number(route.cachedTokens) }} · 输出 {{ number(route.outputTokens) }} · 推理 {{ number(route.reasoningTokens) }}</p><p>记录成本 {{ formatCny(route.costCny) }} · {{ billingState(route.billingState) }}</p><template v-if="route.price"><p>价格：输入 {{ formatCny(route.price.inputPerMillion) }} / 缓存 {{ formatCny(route.price.cachedPerMillion) }} / 输出 {{ formatCny(route.price.outputPerMillion) }} / 推理 {{ formatCny(route.price.reasoningPerMillion) }} / 1M</p><p>{{ route.price.ruleName || route.price.source || '历史价格' }} · {{ route.price.timezone || '未提供时区' }} · {{ route.price.validFrom || '未提供' }} 至 {{ route.price.validTo || '未提供' }} · {{ schedule(route.price) }}</p><p v-if="route.formulaCosts">输入公式成本 {{ formatCny(route.formulaCosts.inputCost) }} · 缓存 {{ formatCny(route.formulaCosts.cachedCost) }} · 输出 {{ formatCny(route.formulaCosts.outputCost) }} · 推理 {{ formatCny(route.formulaCosts.reasoningCost) }} · 合计 {{ formatCny(route.formulaCosts.totalCost) }} · 差额 {{ formatCny(route.formulaCosts.differenceCny) }}</p><p v-else>公式成本：未提供</p></template><p v-else>价格：未提供</p></article>
    </template>
  </Drawer>
</template>
