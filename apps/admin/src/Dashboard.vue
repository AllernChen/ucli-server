<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { api, publicApi } from './api'
import { formatCny } from './currency'
import { companyDateRange, defaultCompanyDateRange, usageQuery } from './usage-filters'
import { createRequestLifecycle } from './device-grants'
import { budgetWarning } from './usage-groups'
import TrendChart from './components/TrendChart.vue'

const sectionNames = ['apiHealth', 'gatewayHealth', 'costs', 'metrics', 'trend', 'channels', 'alerts'] as const
type Section = typeof sectionNames[number]
const states = reactive(Object.fromEntries(sectionNames.map(key => [key, { data: null, loading: false, error: '', updatedAt: '' }])) as Record<Section, { data: any; loading: boolean; error: string; updatedAt: string }>)
const lifecycles = Object.fromEntries(sectionNames.map(key => [key, createRequestLifecycle()])) as Record<Section, ReturnType<typeof createRequestLifecycle>>
const controllers = new Map<Section, AbortController>()
const period = ref<'today' | 'month'>('today')
const metric = ref<'cost' | 'requests'>('cost')
const healthSections = [{ key: 'apiHealth' as const, label: 'API', path: '/healthz' }, { key: 'gatewayHealth' as const, label: 'Gateway', path: '/gateway/healthz' }]
const percent = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(1)}%`
const tokens = (value: string | number | null | undefined) => value == null ? '—' : BigInt(value).toLocaleString('zh-CN')
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
function ranges() {
  const day = new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10)
  return { today: companyDateRange(day, day), month: companyDateRange(`${day.slice(0, 7)}-01`, day), week: defaultCompanyDateRange() }
}
const unsettledLink = computed(() => {
  const value = states.alerts.data?.unsettled
  return value?.total && value.start ? { path: '/usage', query: { billingState: 'UNKNOWN', start: value.start, end: value.end, timezone: 'Asia/Shanghai' } } : null
})
const lowCoverage = computed(() => {
  const coverage = states.metrics.data?.value.cacheCoverage
  return coverage && (coverage.unknownCalls > 0 || BigInt(coverage.knownInputTokens) < BigInt(coverage.totalInputTokens))
})

async function loadSection(key: Section, read: (signal: AbortSignal) => Promise<any>, health = false, clear = false) {
  const lifecycle = lifecycles[key], current = lifecycle.next(), state = states[key]
  controllers.get(key)?.abort()
  const controller = new AbortController(); controllers.set(key, controller)
  state.loading = true; state.error = ''
  if (clear) state.data = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const request = read(controller.signal)
    const data = health ? await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('请求超时（10 秒）')) }, 10_000)
      controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
    })]) : await request
    if (!lifecycle.isCurrent(current)) return
    state.data = data; state.updatedAt = health ? data.timestamp : new Date().toISOString()
  } catch (error: any) {
    if (lifecycle.isCurrent(current)) state.error = error instanceof SyntaxError ? '响应不是有效 JSON' : error.message || '未取得有效响应'
  } finally {
    clearTimeout(timer)
    if (lifecycle.isCurrent(current)) { state.loading = false; controllers.delete(key) }
  }
}
function loadHealth(item: typeof healthSections[number]) {
  return loadSection(item.key, async signal => {
    const result = await publicApi(item.path, { signal })
    if (result?.status !== 'ok' || typeof result.timestamp !== 'string' || !Number.isFinite(Date.parse(result.timestamp))) throw new Error('健康接口未返回有效健康结果')
    return result
  }, true)
}
function loadCosts() {
  const range = ranges()
  return loadSection('costs', async signal => {
    const [today, month] = await Promise.all(['today', 'month'].map(key => api(`/api/v1/analytics/overview?${usageQuery(range[key as 'today' | 'month'])}`, { signal })))
    return { today, month }
  })
}
function loadMetrics() {
  const selected = period.value, range = ranges()[selected]
  return loadSection('metrics', async signal => ({ value: await api(`/api/v1/analytics/overview?${usageQuery(range)}`, { signal }), period: selected, range }), false, true)
}
function selectPeriod(value: 'today' | 'month') { period.value = value; void loadMetrics() }
function loadTrend() {
  const range = ranges().week
  return loadSection('trend', signal => api(`/api/v1/analytics/timeseries?${usageQuery({ ...range, interval: 'day' })}`, { signal }))
}
const loadChannels = () => loadSection('channels', signal => api('/api/v1/admin/channels?limit=5&offset=0', { signal }))
const loadAlerts = () => loadSection('alerts', signal => api('/api/v1/monitoring/overview', { signal }))
function refresh() { healthSections.forEach(item => void loadHealth(item)); void loadCosts(); void loadMetrics(); void loadTrend(); void loadChannels(); void loadAlerts() }
onMounted(refresh)
onUnmounted(() => { sectionNames.forEach(key => lifecycles[key].dispose()); controllers.forEach(controller => controller.abort()) })
</script>

<template>
  <header class="page-header"><div><p>UCLI CONTROL PLANE</p><h1>模型服务总览</h1><span class="subtitle">人民币采购成本 · 平台范围 · Asia/Shanghai 自然日 · 结束时间不含</span></div><button @click="refresh">刷新数据</button></header>
  <section class="panel dashboard-section"><h2>服务健康</h2><div class="cards">
    <article v-for="item in healthSections" :key="item.key" :data-health="item.key"><span>{{ item.label }}</span>
      <strong>{{ states[item.key].loading ? '检查中…' : states[item.key].error ? '检查失败' : states[item.key].data ? '可达' : '未取得结果' }}</strong>
      <p v-if="states[item.key].error" class="error">{{ states[item.key].error }}</p>
      <small v-if="states[item.key].updatedAt">{{ states[item.key].loading || states[item.key].error ? '上次成功（非当前成功）' : '健康接口检查时间' }}：{{ time(states[item.key].updatedAt) }}</small>
      <small v-else>未取得成功检查结果</small><button :aria-label="`重试 ${item.label} 健康检查`" @click="loadHealth(item)">重新检查</button>
    </article>
  </div></section>
  <section class="panel dashboard-section" data-section="costs"><div class="section-header"><h2>采购成本 · 平台范围</h2><button aria-label="重试成本" @click="loadCosts">刷新成本</button></div>
    <p v-if="states.costs.loading" class="state">成本加载中…</p><p v-if="states.costs.error" class="error">{{ states.costs.error }}</p>
    <p v-if="states.costs.updatedAt" class="muted">最后成功更新：{{ time(states.costs.updatedAt) }}{{ states.costs.error ? '（本次刷新失败）' : '' }}</p>
    <div class="cards"><article v-for="item in [{ key: 'today', label: '今日' }, { key: 'month', label: '本月' }]" :key="item.key"><span>{{ item.label }}采购成本</span>
      <strong>{{ states.costs.data ? formatCny(states.costs.data[item.key].costCny) : '—' }}</strong><small v-if="states.costs.data">其中估算 {{ formatCny(states.costs.data[item.key].estimatedCostCny) }} · 待核算 {{ states.costs.data[item.key].unsettledRequests }} 个请求</small>
    </article></div><p class="muted">金额只含已知成本，并非最终账单；待核算金额不能视为零。</p>
  </section>
  <section class="panel dashboard-section" data-section="metrics"><div class="section-header"><h2>期间用量 · 平台范围</h2><div class="tabs compact"><button :aria-pressed="period === 'today'" @click="selectPeriod('today')">今日</button><button :aria-pressed="period === 'month'" @click="selectPeriod('month')">本月</button><button aria-label="重试期间用量" @click="loadMetrics">刷新用量</button></div></div>
    <p v-if="states.metrics.loading" class="state">用量加载中…</p><p v-if="states.metrics.error" class="error">{{ states.metrics.error }}</p><p v-if="states.metrics.updatedAt" class="muted">最后成功更新：{{ time(states.metrics.updatedAt) }}</p>
    <template v-if="states.metrics.data"><p class="muted">{{ states.metrics.data.period === 'today' ? '今日' : '本月' }}：[{{ time(states.metrics.data.range.start) }}, {{ time(states.metrics.data.range.end) }})</p>
      <div class="cards"><article><span>请求数</span><strong>{{ tokens(states.metrics.data.value.requests) }}</strong></article>
        <article><span>请求成功率</span><strong>{{ percent(states.metrics.data.value.requestSuccessRate) }}</strong><small>成功 / 全部请求，与计费状态独立</small></article>
        <article><span>活跃员工</span><strong>{{ tokens(states.metrics.data.value.activeAccounts) }}</strong></article>
        <article><span>输入 / 输出 Token</span><strong>{{ tokens(states.metrics.data.value.inputTokens) }} / {{ tokens(states.metrics.data.value.outputTokens) }}</strong></article>
        <article><span>缓存 Token / 命中率</span><strong>{{ tokens(states.metrics.data.value.cachedTokens) }} / {{ percent(states.metrics.data.value.cacheHitRate) }}</strong><small v-if="states.metrics.data.value.cacheCoverage">已知缓存输入覆盖 {{ tokens(states.metrics.data.value.cacheCoverage.knownInputTokens) }} / {{ tokens(states.metrics.data.value.cacheCoverage.totalInputTokens) }} 输入 Token</small></article>
      </div><p v-if="lowCoverage" class="state">缓存覆盖不足：{{ states.metrics.data.value.cacheCoverage.unknownCalls }} 次调用未知，命中率仅基于可靠缓存数据，不能视为全量命中率。</p><p v-if="states.metrics.data.value.tokenUsageIncomplete" class="state">部分调用 Token 数据不完整，汇总只含已知用量。</p>
      <RouterLink :to="{ path: '/analytics', query: states.metrics.data.range }">查看期间分析</RouterLink>
    </template>
  </section>
  <section class="panel dashboard-section trend-panel" data-section="trend"><div class="section-header"><h2>近 7 天成本与请求趋势 · 平台范围</h2><div class="tabs compact"><button @click="metric = 'cost'">采购成本趋势</button><button @click="metric = 'requests'">请求趋势</button><button aria-label="重试趋势" @click="loadTrend">刷新趋势</button></div></div>
    <p v-if="states.trend.loading" class="state">趋势加载中…</p><p v-if="states.trend.error" class="error">{{ states.trend.error }}</p><p v-if="states.trend.updatedAt" class="muted">最后成功更新：{{ time(states.trend.updatedAt) }}{{ states.trend.error ? '（本次刷新失败）' : '' }}</p>
    <TrendChart v-if="states.trend.data" :data="states.trend.data" :metric="metric" timezone="Asia/Shanghai" />
  </section>
  <section class="panel dashboard-section" data-section="channels"><div class="section-header"><h2>渠道状态</h2><button aria-label="重试渠道" @click="loadChannels">刷新渠道</button></div>
    <p v-if="states.channels.loading" class="state">渠道加载中…</p><p v-if="states.channels.error" class="error">{{ states.channels.error }}</p><p v-if="states.channels.updatedAt" class="muted">最后成功更新：{{ time(states.channels.updatedAt) }}{{ states.channels.error ? '（本次刷新失败）' : '' }}</p>
    <template v-if="states.channels.data"><p class="muted">共 {{ states.channels.data.total }} 个渠道，最多展示前 5 项。近24小时最终渠道请求；P95 为最终渠道请求耗时，不代表路由整体或所有尝试延迟。</p>
      <div class="table-panel"><table><thead><tr><th>渠道</th><th>配置状态</th><th>已有健康状态</th><th>近24小时请求</th><th>实测 P95</th></tr></thead><tbody><tr v-for="row in states.channels.data.items" :key="row.id"><td><RouterLink :to="`/channels/${row.id}`">{{ row.name }}</RouterLink></td><td>{{ row.enabled ? '已启用' : '已停用' }}</td><td>{{ row.health }}</td><td>{{ row.usage24h?.requests ?? '—' }}</td><td>{{ row.usage24h?.p95LatencyMs == null ? '—' : `${row.usage24h.p95LatencyMs} ms` }}</td></tr></tbody></table></div>
      <p v-if="!states.channels.data.items.length" class="empty">暂无渠道</p><RouterLink to="/channels">查看全部渠道</RouterLink>
    </template>
  </section>
  <section class="panel dashboard-section" data-section="alerts"><div class="section-header"><h2>当前提醒</h2><button aria-label="重试当前提醒" @click="loadAlerts">刷新提醒</button></div><p class="muted">当前状态不受期间用量或趋势日期影响；每区最多展示前 5 项。</p>
    <p v-if="states.alerts.loading" class="state">提醒加载中…</p><p v-if="states.alerts.error" class="error">{{ states.alerts.error }}</p><p v-if="states.alerts.updatedAt" class="muted">最后成功更新：{{ time(states.alerts.updatedAt) }}{{ states.alerts.error ? '（本次刷新失败）' : '' }}</p>
    <template v-if="states.alerts.data"><div class="dashboard-alerts">
      <article><h3>异常渠道 · 平台范围（{{ states.alerts.data.channels.total }}）</h3><p v-for="row in states.alerts.data.channels.items" :key="row.id"><RouterLink :to="`/channels/${row.id}`">{{ row.name }}</RouterLink> · {{ row.health }}</p><p v-if="!states.alerts.data.channels.total">暂无异常渠道</p><RouterLink to="/channels?enabled=true&amp;health=DEGRADED">查看全部降级渠道</RouterLink><br><RouterLink to="/channels?enabled=true&amp;health=UNHEALTHY">查看全部不健康渠道</RouterLink></article>
      <article><h3>预算提醒 · 当前组织（{{ states.alerts.data.budgets.total }}）</h3><small>组织 ID：{{ states.alerts.data.budgetOrganizationId }}</small><p v-for="row in states.alerts.data.budgets.items" :key="row.id"><RouterLink :to="`/usage-groups/${row.id}`">{{ row.name }}</RouterLink> · {{ budgetWarning(row.budget) }}<br>可用 {{ row.budget.unlimited ? '不限额' : formatCny(row.budget.availableCny) }} · 待核算 {{ formatCny(row.budget.uncertainCny) }}</p><p v-if="!states.alerts.data.budgets.total">暂无预算提醒</p><RouterLink to="/usage-groups?budgetRisk=ATTENTION&amp;status=active">查看全部预算提醒</RouterLink></article>
      <article><h3>待核算请求 · 平台范围（{{ states.alerts.data.unsettled.total }}）</h3><p v-for="row in states.alerts.data.unsettled.items" :key="row.id">{{ row.requestId }} · {{ row.label }}<br>已知成本 {{ formatCny(row.costCny) }} · {{ time(row.startedAt) }}</p><p v-if="!states.alerts.data.unsettled.total">暂无待核算请求</p><RouterLink v-if="unsettledLink" :to="unsettledLink">查看全部待核算请求</RouterLink></article>
    </div></template>
  </section>
</template>

<style scoped>
.dashboard-section { margin-bottom: 20px; padding: 20px; }
.dashboard-section .cards { margin: 16px 0; }
.dashboard-section small { display: block; margin-top: 6px; }
.dashboard-alerts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; overflow-wrap: anywhere; }
.dashboard-section .table-panel { overflow-x: auto; }
@media (max-width: 900px) { .dashboard-alerts { grid-template-columns: 1fr; } }
</style>
