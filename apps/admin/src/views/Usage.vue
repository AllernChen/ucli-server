<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import Decimal from 'decimal.js'
import { useRoute, useRouter } from 'vue-router'
import { api, downloadCsv } from '../api'
import { formatCny } from '../currency'
import { createRequestLifecycle } from '../device-grants'
import { defaultCompanyDateRange, usageQuery } from '../usage-filters'
import Pagination from '../components/Pagination.vue'
import UsageDetail from '../components/UsageDetail.vue'
import UsageFilters from '../components/UsageFilters.vue'

const props = defineProps<{ groupId?: string; embedded?: boolean }>()
const route = useRoute(); const router = useRouter(); const lifecycle = createRequestLifecycle()
const loading = ref(true); const error = ref(''); const exporting = ref(false); const role = ref('')
const rows = ref<any[]>([]); const page = ref({ total: 0, limit: 50, offset: 0 }); const selectedId = ref<string | null>(null)
const draft = ref<Record<string, string>>({ limit: '50' }); const applied = ref<Record<string, string>>({ limit: '50' })
let lastRoute = ''
const first = (value: unknown) => Array.isArray(value) ? String(value[0] || '') : typeof value === 'string' ? value : ''
const routeFilters = () => Object.fromEntries(Object.entries(route.query).map(([key, value]) => [key, first(value)]).filter(([, value]) => value)) as Record<string, string>
const appliedQuery = () => usageQuery({ ...applied.value, limit: String(page.value.limit), offset: String(page.value.offset) }, props.groupId)
const chinaTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value))
const integer = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value) ? new Decimal(value) : null
const uncached = (input: unknown, cached: unknown) => { const total = integer(input), cache = integer(cached); return total && cache ? Decimal.max(total.minus(cache), 0).toFixed(0) : '未提供' }
const requestState = (value: string) => ({ SUCCESS: '成功', FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '已中断' }[value] || '未提供')
const billingState = (value: string) => ({ CONFIRMED: '已确认', ESTIMATED: '估算', UNKNOWN: '待核对', NO_CHARGE: '无费用' }[value] || '未提供')
const appliedSummary = computed(() => {
  const labels = [['start', '开始'], ['end', '结束'], ['timezone', '时区'], ['organizationId', '组织'], ['accountId', '员工'], ['groupId', '用量组'], ['groupScope', '用量组'], ['apiKeyId', '员工 Key'], ['keyScope', '员工 Key'], ['credentialType', '凭据'], ['publicModelId', '模型'], ['model', '兼容模型'], ['channelId', '渠道'], ['channelModelId', '渠道模型'], ['channelModelScope', '渠道模型'], ['costRuleId', '成本规则'], ['priceKey', '价格快照'], ['requestState', '请求状态'], ['billingState', '计费状态'], ['allocation', '渠道核算'], ['requestId', '请求 ID'], ['sessionId', '会话'], ['projectId', '项目']]
  const readable = (key: string, value: string) => {
    if (key === 'credentialType') return value === 'API_KEY' ? '员工 API Key' : value === 'DEVICE' ? 'UCLI 设备' : value
    if (key === 'requestState') return requestState(value)
    if (key === 'billingState') return billingState(value)
    if (key === 'groupScope' && value === 'UNGROUPED') return '历史未归组'
    if (key === 'keyScope' && value === 'NO_KEY') return '设备凭据'
    if (key === 'channelModelScope' && value === 'UNASSOCIATED') return '未关联渠道模型'
    if (key === 'allocation' && value === 'UNALLOCATED') return '未分配到渠道的核算差额'
    return value
  }
  const values = labels.flatMap(([key, label]) => applied.value[key] ? [`${label}：${readable(key, applied.value[key])}`] : [])
  return values.length ? values.join(' · ') : '默认近 7 天'
})
async function load() {
  const current = lifecycle.next(); loading.value = true; error.value = ''
  try {
    const result: any = await api(`/api/v1/usage/logs-page?${appliedQuery()}`)
    if (lifecycle.isCurrent(current)) { rows.value = result.items || []; page.value = { total: result.total || 0, limit: result.limit || page.value.limit, offset: result.offset || 0 } }
  } catch (value: any) { if (lifecycle.isCurrent(current)) error.value = value.message } finally { if (lifecycle.isCurrent(current)) loading.value = false }
}
function apply(next: Record<string, string>) {
  applied.value = { ...next, ...(props.groupId ? { groupId: props.groupId } : {}) }; draft.value = { ...applied.value }; page.value.offset = 0; selectedId.value = null
  const query = Object.fromEntries(new URLSearchParams(usageQuery(applied.value, props.groupId)))
  lastRoute = JSON.stringify(query); void router.replace({ query }); void load()
}
function replaceRoute() { const query = Object.fromEntries(new URLSearchParams(appliedQuery())); lastRoute = JSON.stringify(query); void router.replace({ query }) }
function changePage(offset: number) { page.value.offset = offset; replaceRoute(); void load() }
async function exportCsv() {
  exporting.value = true; error.value = ''
  try { await downloadCsv(`/api/v1/usage/export?${usageQuery(applied.value, props.groupId)}`, 'usage-logs.csv') }
  catch (value: any) { error.value = value.message } finally { exporting.value = false }
}
watch(() => route.query, () => {
  const next = { ...routeFilters(), ...(props.groupId ? { groupId: props.groupId } : {}) }
  if (!next.start && !next.end) Object.assign(next, defaultCompanyDateRange())
  const key = JSON.stringify(next)
  if (key === lastRoute) return
  lastRoute = key; draft.value = { ...next, limit: next.limit || '50' }; applied.value = { ...draft.value }; page.value.limit = Math.min(200, Math.max(1, Math.trunc(Number(next.limit) || 50))); page.value.offset = Number(next.offset) || 0; selectedId.value = null; void load()
}, { immediate: true, deep: true })
watch(() => props.groupId, () => { const next = { ...applied.value, ...(props.groupId ? { groupId: props.groupId } : {}) }; apply(next) })
onMounted(async () => { try { role.value = (await api<any>('/api/v1/auth/me')).role || '' } catch { /* Server scope remains authoritative. */ } })
onUnmounted(() => lifecycle.dispose())
</script>

<template>
  <header v-if="!embedded" class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>使用日志</h1><span class="subtitle">中国标准时间（Asia/Shanghai）· 默认近 7 天</span></div><div class="actions"><button @click="load">刷新数据</button><button :disabled="exporting" @click="exportCsv">{{ exporting ? '正在导出…' : '导出 CSV' }}</button></div></header>
  <UsageFilters v-model="draft" :role="role" :pinned-group-id="groupId" mode="logs" @apply="apply" />
  <p v-if="loading" class="state">正在加载…</p><p v-else-if="error" class="state error">{{ error }}</p>
  <section v-else class="panel"><p class="muted">当前结果：{{ appliedSummary }}</p><table v-if="rows.length"><thead><tr><th>时间</th><th>员工 / 用量组</th><th>凭据</th><th>模型 / 渠道</th><th>未缓存输入 / 缓存 / 推理 / 输出</th><th>匹配记录成本</th><th>状态</th><th>详情</th></tr></thead><tbody><tr v-for="row in rows" :key="row.id"><td>{{ chinaTime(row.startedAt) }}</td><td><strong>{{ row.employeeName || '未提供' }}</strong><small>{{ row.groupName || '历史未归组' }}</small></td><td>{{ row.keyName || '设备凭据' }}<small class="mono">{{ row.keyHint || '未提供' }}</small></td><td>{{ row.publicModelId || '未提供' }}<small>{{ row.channelName || '未提供' }} · {{ row.upstreamModel || '未提供' }}</small></td><td>{{ uncached(row.inputTokens, row.cachedTokens) }} / {{ row.cachedTokens ?? '未提供' }} / {{ row.reasoningTokens ?? '未提供' }} / {{ row.outputTokens ?? '未提供' }}</td><td>{{ formatCny(row.matchedCostCny) }}<small>{{ billingState(row.billingState) }}</small><small v-if="row.billingState === 'UNKNOWN'">待核对费用，非最终成本</small></td><td>{{ requestState(row.requestState) }} · {{ billingState(row.billingState) }} · {{ row.statusCode ?? '未提供' }}</td><td><small class="mono">{{ row.requestId || '未提供' }}</small><button :aria-label="`查看请求 ${row.requestId} 详情`" @click="selectedId = row.id">查看</button></td></tr></tbody></table><p v-else class="empty">暂无日志</p><Pagination v-if="rows.length" :total="page.total" :limit="page.limit" :offset="page.offset" @change="changePage" /></section>
  <UsageDetail :id="selectedId" :query="appliedQuery()" @close="selectedId = null" />
</template>
