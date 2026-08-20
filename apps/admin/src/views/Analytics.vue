<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, token } from '../api'
import TrendChart from '../components/TrendChart.vue'

type Dimension = 'organization' | 'channel' | 'model' | 'channelModel' | 'account' | 'costRule'
const route = useRoute(); const router = useRouter(); const loading = ref(false); const error = ref(''); let requestToken = 0
function isoDate(value: Date) { return value.toISOString().slice(0, 10) }
const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
const weekAgo = new Date(); weekAgo.setUTCDate(weekAgo.getUTCDate() - 6)
const filters = reactive({ start: String(route.query.start || isoDate(weekAgo)), end: String(route.query.end || isoDate(tomorrow)),
  organizationId: String(route.query.organizationId || ''), channelId: String(route.query.channelId || ''),
  publicModelId: String(route.query.publicModelId || ''), channelModelId: String(route.query.channelModelId || ''),
  accountId: String(route.query.accountId || '') })
const overview = ref<any>(null); const series = ref<any[]>([]); const options = ref<any>({ organizations: [], channels: [], models: [], channelModels: [], accounts: [], costRules: [] })
const breakdown = ref<any>({ items: [], limit: 50, offset: 0 }); const metric = ref<'requests' | 'tokens' | 'cost'>('requests')
const dimension = ref<Dimension>((route.query.dimension as Dimension) || 'channel'); const sort = ref('costUsd'); const order = ref<'asc' | 'desc'>('desc')
function role() { try { const raw = token().split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '='))).role } catch { return '' } }
const dimensions = computed(() => [
  ...(role() === 'PLATFORM_ADMIN' ? [{ id: 'organization', label: '组织' }] : []),
  { id: 'channel', label: '渠道' }, { id: 'model', label: '公共模型' }, { id: 'channelModel', label: '渠道模型' },
  { id: 'account', label: '员工' }, { id: 'costRule', label: '成本规则' }
] as Array<{ id: Dimension; label: string }>)
function query(extra: Record<string, string> = {}) {
  return new URLSearchParams(Object.entries({ ...filters, ...extra }).filter(([, value]) => value !== '') as Array<[string, string]>).toString()
}
async function load() {
  const current = ++requestToken; loading.value = true; error.value = ''
  await router.replace({ query: { ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), dimension: dimension.value } })
  try {
    const common = query(); const rangeDays = (new Date(filters.end).getTime() - new Date(filters.start).getTime()) / 86_400_000
    const [nextOverview, nextSeries, nextBreakdown, nextOptions] = await Promise.all([
      api(`/api/v1/analytics/overview?${common}`), api(`/api/v1/analytics/timeseries?${query({ interval: rangeDays <= 2 ? 'hour' : 'day' })}`),
      api(`/api/v1/analytics/breakdown?${query({ dimension: dimension.value, sort: sort.value, order: order.value, limit: '50', offset: '0' })}`),
      api(`/api/v1/analytics/filter-options?${common}`)
    ])
    if (current !== requestToken) return
    overview.value = nextOverview; series.value = nextSeries as any[]; breakdown.value = nextBreakdown; options.value = nextOptions
  } catch (value: any) { if (current === requestToken) error.value = value.message } finally { if (current === requestToken) loading.value = false }
}
function preset(days: number) { const end = new Date(); end.setUTCDate(end.getUTCDate() + 1); const start = new Date(); start.setUTCDate(start.getUTCDate() - days + 1); filters.start = isoDate(start); filters.end = isoDate(end); void load() }
function selectDimension(value: Dimension) { dimension.value = value; void load() }
function changeSort(value: string) { if (sort.value === value) order.value = order.value === 'desc' ? 'asc' : 'desc'; else { sort.value = value; order.value = 'desc' }; void load() }
function drill(row: any) { const map: Partial<Record<Dimension, keyof typeof filters>> = { organization: 'organizationId', channel: 'channelId', model: 'publicModelId', channelModel: 'channelModelId', account: 'accountId' }; const key = map[dimension.value]; if (key) { filters[key] = row.id; void load() } }
function schedule(value: any) { if (!value) return '历史/兜底规则'; const minute = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; return `周 ${value.daysOfWeek.join(',')} · ${minute(value.startMinute)}–${minute(value.endMinute)}` }
onMounted(load)
</script>

<template><header class="page-header"><div><p>INTERNAL COST ANALYTICS</p><h1>统计分析</h1><span class="subtitle">公司内部模型用量与采购成本，不含销售价格、收入和利润。</span></div><div class="actions"><button @click="preset(7)">近 7 天</button><button @click="preset(30)">近 30 天</button><button @click="preset(90)">近 90 天</button><button class="primary" :disabled="loading" @click="load">{{ loading ? '加载中…' : '应用筛选' }}</button></div></header>
  <section class="panel analytics-filters"><label>开始<input v-model="filters.start" type="date"></label><label>结束（不含）<input v-model="filters.end" type="date"></label>
    <label v-if="role() === 'PLATFORM_ADMIN'">组织<select v-model="filters.organizationId"><option value="">全部组织</option><option v-for="item in options.organizations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <label>渠道<select v-model="filters.channelId"><option value="">全部渠道</option><option v-for="item in options.channels" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <label>模型<select v-model="filters.publicModelId"><option value="">全部模型</option><option v-for="item in options.models" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <label>员工<select v-model="filters.accountId"><option value="">全部员工</option><option v-for="item in options.accounts" :key="item.id" :value="item.id">{{ item.name }}</option></select></label></section>
  <p v-if="error" class="state error">{{ error }}</p>
  <section v-if="overview" class="analytics-cards"><article><span>请求数</span><strong>{{ overview.requests.toLocaleString() }}</strong><small>成功率 {{ (overview.successRate * 100).toFixed(1) }}%</small></article><article><span>Token</span><strong>{{ (Number(overview.inputTokens) + Number(overview.outputTokens)).toLocaleString() }}</strong><small>输入 {{ Number(overview.inputTokens).toLocaleString() }} · 输出 {{ Number(overview.outputTokens).toLocaleString() }}</small></article><article><span>采购成本</span><strong>${{ overview.costUsd }}</strong><small>单请求均值 ${{ overview.avgCostPerRequestUsd }}</small></article><article><span>活跃员工</span><strong>{{ overview.activeAccounts }}</strong><small>切换率 {{ (overview.failoverRate * 100).toFixed(1) }}%</small></article><article><span>P95 延迟</span><strong>{{ overview.p95LatencyMs ?? '—' }}ms</strong><small>P50 {{ overview.p50LatencyMs ?? '—' }}ms · 首字 P95 {{ overview.p95FirstTokenMs ?? '—' }}ms</small></article></section>
  <section class="panel trend-panel"><div class="section-header"><div><h2>使用趋势</h2><p class="muted">成功率使用右侧坐标轴</p></div><div class="tabs compact"><button v-for="item in [['requests','请求'],['tokens','Token'],['cost','采购成本']]" :key="item[0]" :class="{active: metric === item[0]}" @click="metric = item[0] as any">{{ item[1] }}</button></div></div><TrendChart :data="series" :metric="metric" /></section>
  <section class="panel breakdown-panel"><div class="tabs"><button v-for="item in dimensions" :key="item.id" :class="{active: dimension === item.id}" @click="selectDimension(item.id)">{{ item.label }}</button></div>
    <div class="table-panel"><table><thead><tr><th>名称</th><th><button @click="changeSort('requests')">请求数</button></th><th><button @click="changeSort('tokens')">Token</button></th><th><button @click="changeSort('costUsd')">采购成本</button></th><th><button @click="changeSort('successRate')">成功率</button></th><th><button @click="changeSort('p95LatencyMs')">P95</button></th><th v-if="dimension === 'costRule'">加权采购单价 / 时段</th></tr></thead><tbody><tr v-for="row in breakdown.items" :key="row.id" :class="{ 'clickable-row': dimension !== 'costRule' }" @click="dimension !== 'costRule' && drill(row)"><td><strong>{{ row.name }}</strong><small>{{ row.id }}</small></td><td>{{ row.requests.toLocaleString() }}</td><td>{{ Number(row.totalTokens).toLocaleString() }}</td><td>${{ row.costUsd }}</td><td>{{ (row.successRate * 100).toFixed(1) }}%</td><td>{{ row.p95LatencyMs ?? '—' }}ms</td><td v-if="dimension === 'costRule'"><strong>in {{ row.avgInputPerMillion ?? '—' }} / out {{ row.avgOutputPerMillion ?? '—' }}</strong><small>{{ schedule(row.schedule) }}</small></td></tr></tbody></table><p v-if="!breakdown.items.length" class="empty">当前维度没有数据</p></div></section>
</template>
