<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, downloadCsv } from '../api'
import TrendChart from '../components/TrendChart.vue'
import UsageFilters from '../components/UsageFilters.vue'
import Pagination from '../components/Pagination.vue'
import { defaultCompanyDateRange, usageQuery } from '../usage-filters'
import { createRequestLifecycle } from '../device-grants'
import { formatCny } from '../currency'

type Dimension = 'organization' | 'channel' | 'model' | 'channelModel' | 'account' | 'costRule' | 'group' | 'apiKey'
const route = useRoute(), router = useRouter(), lifecycle = createRequestLifecycle()
const exportLifecycle = createRequestLifecycle()
const loading = ref(false), exporting = ref(false), error = ref(''), role = ref(''), ready = ref(false)
const draft = ref<Record<string, string>>({}), applied = ref<Record<string, string>>({})
const overview = ref<any>(null), series = ref<any[]>([]), breakdown = ref<any>({ items: [], total: 0, limit: 50, offset: 0 })
const metric = ref<'requests' | 'tokens' | 'cost'>('requests'), dimension = ref<Dimension>('channel')
const sort = ref('costCny'), order = ref<'asc' | 'desc'>('desc'), offset = ref(0), limit = ref(50)
const sortLabels: Record<string, string> = { requests: '请求数', tokens: 'Token', costCny: '采购成本', costUsd: '采购成本', requestSuccessRate: '请求成功率', p95LatencyMs: 'P95 延迟' }
let lastRoute = ''
const dimensions = computed(() => [
  ...(role.value === 'PLATFORM_ADMIN' ? [{ id: 'organization', label: '组织' }] : []),
  { id: 'channel', label: '渠道' }, { id: 'model', label: '公共模型' }, { id: 'channelModel', label: '渠道模型' },
  { id: 'account', label: '员工' }, { id: 'costRule', label: '成本规则' }, { id: 'group', label: '用量组' }, { id: 'apiKey', label: '员工 Key' }
] as Array<{ id: Dimension; label: string }>)
const controls = new Set(['dimension', 'interval', 'sort', 'order', 'limit', 'offset', 'optionDimension', 'q'])
const logOnlyFields = ['requestId', 'sessionId', 'projectId']
const logOnly = computed(() => logOnlyFields.filter(key => applied.value[key]))
const rangeError = computed(() => {
  const days = (new Date(applied.value.end).getTime() - new Date(applied.value.start).getTime()) / 86_400_000
  if (!Number.isFinite(days) || days <= 0) return '请选择有效的开始和结束时间'
  return days > 90 ? '统计范围不能超过 90 天，请明确选择较短日期范围后统计' : ''
})
const filterLabels: Record<string, string> = { start: '开始', end: '结束（不含）', timezone: '时区', organizationId: '组织', accountId: '员工', groupId: '用量组', groupScope: '用量组范围', apiKeyId: '员工 Key', keyScope: 'Key 范围', credentialType: '凭据', channelId: '渠道', publicModelId: '模型', model: '兼容模型', channelModelId: '渠道模型', channelModelScope: '渠道模型范围', costRuleId: '成本规则', priceKey: '历史价格快照', allocation: '渠道核算', requestState: '请求状态', billingState: '计费状态', requestId: '请求 ID', sessionId: '会话 ID', projectId: '项目 ID' }
const filterValues: Record<string, string> = { UNGROUPED: '历史未归组', NO_KEY: '设备凭据', UNASSOCIATED: '未关联渠道模型', UNALLOCATED: '未分配到渠道的核算差额', SUCCESS: '成功', FAILED: '失败', CANCELLED: '取消', INTERRUPTED: '中断', CONFIRMED: '已确认', ESTIMATED: '估算', UNKNOWN: '待核对', NO_CHARGE: '无费用' }
const appliedSummary = computed(() => Object.entries(applied.value).map(([key, value]) => {
  const label = ['groupScope', 'keyScope', 'channelModelScope', 'allocation', 'requestState', 'billingState'].includes(key) ? filterValues[value] || value : value
  return `${filterLabels[key] || key}：${label}`
}).join(' · '))
const percent = (value: number | null | undefined) => value == null ? '未提供' : `${(value * 100).toFixed(1)}%`
const success = (value: any) => percent(value.requestSuccessRate === undefined ? value.successRate : value.requestSuccessRate)
const tokens = (value: string | number | null | undefined) => value == null ? '未提供' : BigInt(value).toLocaleString('zh-CN')
const lowCoverage = (value: any) => value.cacheCoverage && (value.cacheCoverage.unknownCalls > 0 || BigInt(value.cacheCoverage.knownInputTokens) < BigInt(value.cacheCoverage.totalInputTokens))
function schedule(price: any) {
  if (!price?.daysOfWeek?.length || price.startMinute == null || price.endMinute == null) return '规则时段未提供'
  if (price.startMinute === price.endMinute) return `周 ${price.daysOfWeek.join(',')} · 全天`
  const minute = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
  const overnight = price.endMinute < price.startMinute
  return `周 ${price.daysOfWeek.join(',')} · ${minute(price.startMinute)}–${overnight ? '次日 ' : ''}${minute(price.endMinute)}${overnight ? '（跨天，星期按开始日）' : ''}`
}
function dataFilters(value: Record<string, string>) {
  return Object.fromEntries(new URLSearchParams(usageQuery(Object.fromEntries(Object.entries(value).filter(([key]) => !controls.has(key))))))
}
function tableQuery(paged = true) {
  return usageQuery({ ...applied.value, dimension: dimension.value, sort: sort.value, order: order.value,
    ...(paged ? { limit: String(limit.value), offset: String(offset.value) } : {}) })
}
function syncRoute() {
  const query = Object.fromEntries(new URLSearchParams(tableQuery()))
  lastRoute = JSON.stringify(query); void router.replace({ query })
}
async function load() {
  const current = lifecycle.next(); loading.value = true; error.value = ''
  exportLifecycle.next(); exporting.value = false
  overview.value = null; series.value = []; breakdown.value = { items: [], total: 0, limit: limit.value, offset: offset.value }
  if (logOnly.value.length || rangeError.value) { loading.value = false; return }
  try {
    const days = (new Date(applied.value.end).getTime() - new Date(applied.value.start).getTime()) / 86_400_000
    const [nextOverview, nextSeries, nextBreakdown] = await Promise.all([
      api(`/api/v1/analytics/overview?${usageQuery(applied.value)}`),
      api(`/api/v1/analytics/timeseries?${usageQuery({ ...applied.value, interval: days <= 2 ? 'hour' : 'day' })}`),
      api(`/api/v1/analytics/breakdown?${tableQuery()}`)
    ])
    if (!lifecycle.isCurrent(current)) return
    overview.value = nextOverview; series.value = nextSeries as any[]; breakdown.value = nextBreakdown
  } catch (value: any) { if (lifecycle.isCurrent(current)) error.value = value.message }
  finally { if (lifecycle.isCurrent(current)) loading.value = false }
}
function apply(next: Record<string, string>) {
  applied.value = dataFilters(next); draft.value = { ...applied.value }; offset.value = 0
  syncRoute(); void load()
}
function clearLogOnly() { apply(Object.fromEntries(Object.entries(applied.value).filter(([key]) => !logOnlyFields.includes(key)))) }
function preset(days: number) {
  const range = defaultCompanyDateRange()
  range.start = new Date(new Date(range.end).getTime() - days * 86_400_000).toISOString()
  apply({ ...applied.value, ...range })
}
function selectDimension(value: Dimension) { dimension.value = value; offset.value = 0; syncRoute(); void load() }
function changeSort(value: string) {
  order.value = sort.value === value && order.value === 'desc' ? 'asc' : 'desc'; sort.value = value
  offset.value = 0; syncRoute(); void load()
}
function changePage(value: number) { offset.value = value; syncRoute(); void load() }
function drillFilters(row: { drillQuery: Record<string, string> }) {
  const next = { ...applied.value }
  for (const [id, scope] of [['groupId', 'groupScope'], ['apiKeyId', 'keyScope'], ['channelModelId', 'channelModelScope'], ['channelId', 'allocation'], ['costRuleId', 'priceKey'], ['model', 'publicModelId']]) {
    if (row.drillQuery[id]) delete next[scope]
    if (row.drillQuery[scope]) delete next[id]
  }
  return dataFilters({ ...next, ...row.drillQuery })
}
function openLogs(row: { drillQuery: Record<string, string> }) { void router.push({ path: '/usage', query: drillFilters(row) }) }
function drill(row: { drillQuery: Record<string, string> }) { apply(drillFilters(row)) }
async function exportCsv() {
  const current = exportLifecycle.next()
  exporting.value = true; error.value = ''
  try { await downloadCsv(`/api/v1/analytics/export?${tableQuery(false)}`, 'ucli-analytics.csv') }
  catch (value: any) { if (exportLifecycle.isCurrent(current)) error.value = value.message }
  finally { if (exportLifecycle.isCurrent(current)) exporting.value = false }
}
function restoreRoute() {
  const query = Object.fromEntries(Object.entries(route.query).map(([key, value]) => [key, Array.isArray(value) ? String(value[0] || '') : String(value || '')]))
  if (JSON.stringify(query) === lastRoute) return
  lastRoute = JSON.stringify(query)
  applied.value = dataFilters(query)
  if (!applied.value.start && !applied.value.end) Object.assign(applied.value, defaultCompanyDateRange())
  applied.value.timezone = 'Asia/Shanghai'; draft.value = { ...applied.value }
  dimension.value = dimensions.value.some(item => item.id === query.dimension) ? query.dimension as Dimension : 'channel'
  sort.value = Object.hasOwn(sortLabels, query.sort) ? query.sort : 'costCny'
  order.value = query.order === 'asc' ? 'asc' : 'desc'
  offset.value = /^\d+$/.test(query.offset || '') ? Number(query.offset) : 0
  limit.value = /^\d+$/.test(query.limit || '') && Number(query.limit) >= 1 && Number(query.limit) <= 200 ? Number(query.limit) : 50
  void load()
}
watch(() => route.query, () => { if (ready.value) restoreRoute() }, { deep: true })
onMounted(async () => {
  const current = lifecycle.next()
  try { const user = await api<any>('/api/v1/auth/me'); if (lifecycle.isCurrent(current)) role.value = user.role || '' }
  catch (value: any) { if (lifecycle.isCurrent(current)) error.value = value.message; return }
  if (lifecycle.isCurrent(current)) { ready.value = true; restoreRoute() }
})
onUnmounted(() => { lifecycle.dispose(); exportLifecycle.dispose() })
</script>

<template>
  <header class="page-header"><div><p>INTERNAL COST ANALYTICS</p><h1>统计分析</h1><span class="subtitle">人民币采购成本 · Asia/Shanghai 自然日 · 结束时间不含 · 最多 90 天</span></div><div class="actions"><button :disabled="!ready" @click="preset(7)">近 7 天</button><button :disabled="!ready" @click="preset(30)">近 30 天</button><button :disabled="!ready" @click="preset(90)">近 90 天</button><button aria-label="导出统计" :disabled="loading || exporting || !overview" @click="exportCsv">{{ exporting ? '正在导出…' : '导出统计' }}</button></div></header>
  <p v-if="ready" class="analytics-applied">已应用条件：{{ appliedSummary }}</p>
  <section v-if="logOnly.length" class="panel state error"><p>仅支持使用日志，请先清除此条件再统计</p><button aria-label="清除日志专属条件" @click="clearLogOnly">清除日志专属条件</button></section>
  <p v-if="ready && rangeError" class="state error">{{ rangeError }}。可使用上方近 7 / 30 / 90 天按钮。</p>
  <UsageFilters v-if="ready && !logOnly.length && !rangeError" :key="JSON.stringify(applied)" v-model="draft" :role="role" @apply="apply" />
  <p v-if="loading" class="state">正在加载…</p><p v-if="error" class="state error">{{ error }}</p>
  <template v-if="overview">
    <section class="analytics-cards">
      <article><span>请求数</span><strong>{{ tokens(overview.requests) }}</strong><small>请求成功率 {{ success(overview) }}</small><small v-if="overview.requestStates">成功 {{ overview.requestStates.SUCCESS }} · 失败 {{ overview.requestStates.FAILED }} · 取消 {{ overview.requestStates.CANCELLED }} · 中断 {{ overview.requestStates.INTERRUPTED }}</small></article>
      <article><span>采购成本</span><strong>{{ formatCny(overview.costCny) }}</strong><small>单请求均值 {{ formatCny(overview.avgCostPerRequestCny) }}</small><small>未分配到渠道 {{ formatCny(overview.unallocatedCostCny) }}</small></article>
      <article><span>估算成本</span><strong>{{ formatCny(overview.estimatedCostCny) }}</strong><small>已包含在采购成本中</small></article>
      <article><span>待核算请求</span><strong>{{ tokens(overview.unsettledRequests) }}</strong><small>计费状态与请求成功独立；金额只含已知成本，并非最终账单</small></article>
      <article><span>输入 / 输出 Token</span><strong>{{ tokens(overview.inputTokens) }} / {{ tokens(overview.outputTokens) }}</strong><small>未缓存输入 {{ tokens(overview.uncachedInputTokens) }} · 推理 {{ tokens(overview.reasoningTokens) }}</small></article>
      <article><span>缓存 Token</span><strong>{{ tokens(overview.cachedTokens) }}</strong><small>缓存命中率{{ percent(overview.cacheHitRate) }}</small><small v-if="overview.cacheCoverage">覆盖 {{ tokens(overview.cacheCoverage.knownInputTokens) }} / {{ tokens(overview.cacheCoverage.totalInputTokens) }} 输入 Token</small></article>
      <article><span>活跃员工</span><strong>{{ tokens(overview.activeAccounts) }}</strong><small>切换率 {{ percent(overview.failoverRate) }}</small></article>
      <article><span>P95 延迟</span><strong>{{ overview.p95LatencyMs ?? '—' }}ms</strong><small>P50 {{ overview.p50LatencyMs ?? '—' }}ms · 首字 P95 {{ overview.p95FirstTokenMs ?? '—' }}ms</small></article>
    </section>
    <p v-if="lowCoverage(overview)" class="state">缓存覆盖不足：命中率仅基于有可靠缓存数据的输入；{{ overview.cacheCoverage.unknownCalls }} 次调用未提供可靠缓存数据，不能视为全量命中率。</p>
    <p v-if="overview.tokenUsageIncomplete" class="state">部分调用 Token 数据不完整，汇总只含已知用量。</p>
    <section v-if="overview.errorCounts?.length" class="panel analytics-errors"><h2>错误码与核对标记</h2><p class="muted">请求结果见成功 / 失败 / 取消 / 中断；核对标记不代表请求失败。</p><p v-for="item in overview.errorCounts" :key="item.errorCode">{{ item.errorCode === 'RECONCILIATION_REQUIRED' ? '待核对标记' : '错误码' }} {{ item.errorCode }}：{{ item.requests }} 个请求</p></section>
    <section class="panel trend-panel"><div class="section-header"><div><h2>使用趋势</h2><p class="muted">请求成功率使用右侧坐标轴；无请求的时点不显示成功率。</p></div><div class="tabs compact"><button v-for="item in [['requests','请求'],['tokens','Token'],['cost','采购成本']]" :key="item[0]" :class="{ active: metric === item[0] }" @click="metric = item[0] as any">{{ item[1] }}</button></div></div><TrendChart :data="series" :metric="metric" timezone="Asia/Shanghai" /></section>
  </template>
  <section class="panel breakdown-panel"><div class="tabs"><button v-for="item in dimensions" :key="item.id" :disabled="!ready" :class="{ active: dimension === item.id }" @click="selectDimension(item.id)">{{ item.label }}</button></div>
    <p class="muted analytics-scope">排序：{{ sortLabels[sort] }} · {{ order === 'desc' ? '降序' : '升序' }}。点击列标题切换；导出全部匹配结果，最多 5000 行。</p>
    <p v-if="dimension === 'channel'" class="muted analytics-scope">渠道成本按实际路由分摊；请求数在各渠道内去重，跨渠道重试的请求不能相加作为总请求数。</p>
    <div v-if="overview && !loading && !error" class="table-panel"><table><thead><tr><th>名称</th><th><button @click="changeSort('requests')">请求数</button></th><th><button @click="changeSort('tokens')">Token</button></th><th><button @click="changeSort('costCny')">采购成本</button></th><th>缓存 / 命中率 / 覆盖</th><th><button @click="changeSort('requestSuccessRate')">请求成功率</button></th><th><button @click="changeSort('p95LatencyMs')">P95</button></th><th v-if="dimension === 'costRule'">历史采购单价（CNY / 1M）与时段</th><th>操作</th></tr></thead><tbody>
      <tr v-for="(row, index) in breakdown.items" :key="row.id ?? index"><td><strong>{{ row.name }}</strong><small>{{ row.id }}</small></td><td>{{ tokens(row.requests) }}</td><td>{{ tokens(row.totalTokens) }}</td><td>{{ formatCny(row.costCny) }}</td><td>{{ tokens(row.cachedTokens) }} / {{ percent(row.cacheHitRate) }}<small v-if="row.cacheCoverage">覆盖 {{ tokens(row.cacheCoverage.knownInputTokens) }} / {{ tokens(row.cacheCoverage.totalInputTokens) }} 输入 Token</small><small v-if="lowCoverage(row)">缓存覆盖不足 · {{ row.cacheCoverage.unknownCalls }} 次调用未知</small></td><td>{{ success(row) }}</td><td>{{ row.p95LatencyMs ?? '—' }}ms</td>
        <td v-if="dimension === 'costRule'" class="historical-price"><template v-if="row.price"><strong>输入 {{ formatCny(row.price.inputPerMillion) }} / 缓存 {{ formatCny(row.price.cachedPerMillion) }}</strong><strong>输出 {{ formatCny(row.price.outputPerMillion) }} / 推理 {{ formatCny(row.price.reasoningPerMillion) }}</strong><small>{{ row.price.timezone || '时区未提供' }} · {{ schedule(row.price) }}</small><small>有效期 [{{ row.price.validFrom || '未提供' }}, {{ row.price.validTo || '未提供' }})</small></template><span v-else>历史价格信息不足</span></td>
        <td class="analytics-row-actions"><button aria-label="继续分析" @click="drill(row)">继续分析</button><button aria-label="查看匹配日志" @click="openLogs(row)">查看匹配日志</button></td></tr>
    </tbody></table><p v-if="!breakdown.items.length" class="empty">当前维度没有数据</p><Pagination :total="breakdown.total" :limit="breakdown.limit" :offset="breakdown.offset" @change="changePage" /></div>
  </section>
</template>
