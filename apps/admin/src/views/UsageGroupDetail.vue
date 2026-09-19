<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import { budgetLabel, budgetWarning, budgetEntryStatus, operationId, type GroupBudget, type UsageGroup, type UsageProjectSummary } from '../usage-groups'
import { companyDateRange, defaultCompanyDateRange, usageQuery } from '../usage-filters'
import { formatCny } from '../currency'
import { toast } from '../toast'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import Pagination from '../components/Pagination.vue'
import Usage from './Usage.vue'
import UsageDetail from '../components/UsageDetail.vue'
import TrendChart from '../components/TrendChart.vue'
const route = useRoute(), router = useRouter(), lifecycle = createRequestLifecycle()
const id = computed(() => String(route.params.id)), base = computed(() => `/api/v1/admin/usage-groups/${id.value}`)
const group = ref<UsageGroup | null>(null), budget = ref<GroupBudget | null>(null)
const tab = ref('overview'), error = ref(''), loading = ref(false), pending = ref(false)
const members = ref<Page<any>>({ items: [], total: 0, offset: 0, limit: 20 }), entries = ref<Page<any>>({ items: [], total: 0, offset: 0, limit: 20 })
const regionProjects = ref<Page<UsageProjectSummary>>({ items: [], total: 0, offset: 0, limit: 100 })
const applications = ref<Page<any>>({ items: [], total: 0, offset: 0, limit: 20 })
const applicationOffset = ref(0)
const applicationForm = reactive({ requestedCny: '', reason: '' })
const adjustApplicationId = ref('')
const pendingApplications = computed(() => applications.value.items.filter(item => item.status === 'REGISTERED'))
const users = ref<Page<any>>({ items: [], total: 0, offset: 0, limit: 20 })
const memberOffset = ref(0), entryOffset = ref(0), userOffset = ref(0), userSearch = ref(''), accountId = ref(''), previewAccount = ref('')
type ModelOption = { id: string; displayName: string; protocols: string[]; selected: boolean; archived: boolean; allowed: boolean | null; reasons: string[] }
const models = ref<ModelOption[]>([]), selected = ref<string[]>([])
const modelsReady = ref(false)
const modelSearch = ref('')
const visibleModels = computed(() => models.value.filter(m => `${m.id} ${m.displayName}`.toLowerCase().includes(modelSearch.value.toLowerCase())))
const form = reactive({ name: '', description: '' })
const adjust = reactive({ scope: 'CURRENT', limitCny: '0', unlimited: false, reason: '' })
const config = reactive({ budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai', reason: '' })
const confirmation = ref<{ path: string; method: string; message: string } | null>(null)
const editable = computed(() => Boolean(group.value && !group.value.archivedAt))
const seriesLifecycle = createRequestLifecycle(), rankLifecycle = createRequestLifecycle(), requestLifecycle = createRequestLifecycle()
const projectLifecycle = createRequestLifecycle()
const groupSeries = ref<any[]>([]), ranking = ref<Page<any>>({ items: [], total: 0, offset: 0, limit: 20 })
const seriesError = ref(''), rankError = ref(''), analysisError = ref(''), seriesLoading = ref(false), rankLoading = ref(false)
const analysisLoaded = ref(false), dimension = ref('account'), rankOffset = ref(0)
const companyDay = (value: string) => new Date(new Date(value).getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
const analysisRange = ref(defaultCompanyDateRange())
const analysisDates = reactive({ start: companyDay(analysisRange.value.start), end: companyDay(new Date(new Date(analysisRange.value.end).getTime() - 1).toISOString()) })
const selectedId = ref<string | null>(null), requestQuery = ref(''), requestError = ref(''), requestLoading = ref(false)
const chinaTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value))
const sourceLabel = { MEMBER: '职责', KEY: 'Key' } as const
const projectLabel = (project: { name: string; sources?: Array<keyof typeof sourceLabel> }) =>
  `${project.name}${project.sources?.length ? `（${project.sources.map(source => sourceLabel[source]).join('/')}）` : ''}`
const tokens = (value: string | number | null | undefined) => value == null ? '—' : BigInt(value).toLocaleString('zh-CN')
const applicationStatus = (status: string) => status === 'REGISTERED' ? '待批复' : status === 'LINKED' ? '已批复' : '已驳回'
async function loadSeries() {
  const request = seriesLifecycle.next(); seriesLoading.value = true; seriesError.value = ''; groupSeries.value = []
  try {
    const result = await api<any[]>(`/api/v1/analytics/timeseries?${usageQuery({ ...analysisRange.value, interval: 'day' }, id.value)}`)
    if (seriesLifecycle.isCurrent(request)) groupSeries.value = result
  } catch (e: any) { if (seriesLifecycle.isCurrent(request)) seriesError.value = e.message }
  finally { if (seriesLifecycle.isCurrent(request)) seriesLoading.value = false }
}
async function loadRanking() {
  const request = rankLifecycle.next(); rankLoading.value = true; rankError.value = ''; ranking.value = { items: [], total: 0, offset: rankOffset.value, limit: 20 }
  try {
    const result = await api<Page<any>>(`/api/v1/analytics/breakdown?${usageQuery({ ...analysisRange.value, dimension: dimension.value, sort: 'costCny', order: 'desc', offset: String(rankOffset.value), limit: '20' }, id.value)}`)
    if (rankLifecycle.isCurrent(request)) ranking.value = result
  } catch (e: any) { if (rankLifecycle.isCurrent(request)) rankError.value = e.message }
  finally { if (rankLifecycle.isCurrent(request)) rankLoading.value = false }
}
function loadAnalysis() { analysisLoaded.value = true; void loadSeries(); void loadRanking() }
function openAnalytics() { void router.push({ path: '/analytics', query: Object.fromEntries(new URLSearchParams(usageQuery({ ...analysisRange.value, dimension: dimension.value }, id.value))) }) }
function applyAnalysis() {
  analysisError.value = ''
  try {
    const range = companyDateRange(analysisDates.start, analysisDates.end)
    if (new Date(range.end).getTime() - new Date(range.start).getTime() > 90 * 86_400_000) throw new Error('统计范围不能超过 90 天')
    analysisRange.value = range; rankOffset.value = 0; loadAnalysis()
  } catch (e: any) { analysisError.value = e.message }
}
async function openRequest(entry: { requestId: string; startedAt: string }) {
  const request = requestLifecycle.next(), groupId = id.value
  selectedId.value = null; requestError.value = ''; requestLoading.value = true
  try {
    const day = companyDay(entry.startedAt)
    const query = usageQuery({ ...companyDateRange(day, day), requestId: entry.requestId, limit: '1', offset: '0' }, groupId)
    const result = await api<Page<{ id: string; requestId: string; groupId: string }>>(`/api/v1/usage/logs-page?${query}`)
    if (!requestLifecycle.isCurrent(request)) return
    const match = result.items.find(row => row.requestId === entry.requestId && row.groupId === groupId)
    if (!match) { requestError.value = '未找到该组的请求记录'; return }
    requestQuery.value = query; selectedId.value = match.id
  } catch (e: any) { if (requestLifecycle.isCurrent(request)) requestError.value = e.message }
  finally { if (requestLifecycle.isCurrent(request)) requestLoading.value = false }
}
let generation = 0
// Retry an identical adjustment with its original ID; editing the payload starts a new operation.
let budgetRetry = { body: '', id: '' }
const optionLifecycle = createRequestLifecycle(), userLifecycle = createRequestLifecycle()
async function load() {
  const request = lifecycle.next(); loading.value = true; error.value = ''
  try {
    const [g, b, m, e, a] = await Promise.all([api<UsageGroup>(base.value), api<GroupBudget>(`${base.value}/budget`), api<Page<any>>(`${base.value}/members?offset=${memberOffset.value}&limit=20`), api<Page<any>>(`${base.value}/budget-entries?offset=${entryOffset.value}&limit=20`), api<Page<any>>(`${base.value}/budget-applications?offset=${applicationOffset.value}&limit=20`)])
    if (!lifecycle.isCurrent(request)) return
    if (!group.value) { adjust.limitCny = b.limitCny; adjust.unlimited = b.unlimited }
    group.value = g; budget.value = b; members.value = m; entries.value = e; applications.value = a
    if (!pendingApplications.value.some(item => item.id === adjustApplicationId.value)) adjustApplicationId.value = ''
    form.name = g.name; form.description = g.description || ''; config.budgetMode = b.budgetMode; config.budgetTimezone = b.budgetTimezone
  } catch (e: any) { if (lifecycle.isCurrent(request)) error.value = e.message }
  finally { if (lifecycle.isCurrent(request)) loading.value = false }
}
async function loadModels() {
  const request = optionLifecycle.next(); modelsReady.value = false
  try {
    const result = await api<ModelOption[]>(`${base.value}/model-options${previewAccount.value ? `?accountId=${encodeURIComponent(previewAccount.value)}` : ''}`)
    if (optionLifecycle.isCurrent(request)) { models.value = result; selected.value = result.filter(m => m.selected).map(m => m.id); modelsReady.value = true }
  } catch (e: any) { if (optionLifecycle.isCurrent(request)) error.value = e.message }
}
async function loadProjects() {
  const request = projectLifecycle.next(); regionProjects.value = { items: [], total: 0, offset: 0, limit: 100 }
  try {
    const result = await api<Page<UsageProjectSummary>>(`${base.value}/projects`)
    if (projectLifecycle.isCurrent(request)) regionProjects.value = result
  } catch (e: any) { if (projectLifecycle.isCurrent(request)) error.value = e.message }
}
async function searchUsers() {
  const request = userLifecycle.next()
  try {
    const result = await api<Page<any>>(`/api/v1/admin/users?limit=20&offset=${userOffset.value}${userSearch.value.trim() ? `&q=${encodeURIComponent(userSearch.value.trim())}` : ''}`)
    if (userLifecycle.isCurrent(request)) users.value = result
  } catch (e: any) { if (userLifecycle.isCurrent(request)) error.value = e.message }
}
async function mutate(path: string, method: string, body?: unknown) {
  if (pending.value || !editable.value) return false
  if (path === '/models' && !modelsReady.value) { error.value = '模型列表尚未加载成功，请刷新后重试'; return false }
  const current = generation; pending.value = true; error.value = ''
  try {
    await api(base.value + path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    if (current !== generation) return false
    confirmation.value = null; toast('已保存'); await load(); return current === generation
  } catch (e: any) { if (current === generation) { error.value = e.message; confirmation.value = null } return false }
  finally { if (current === generation) pending.value = false }
}
async function saveBudget(configuration = false) {
  const payload = configuration ? { ...config } : {
    ...adjust,
    ...(adjust.scope === 'CURRENT' && budget.value?.periodId ? { periodId: budget.value.periodId } : {}),
    ...(adjust.scope === 'CURRENT' && adjustApplicationId.value ? { applicationId: adjustApplicationId.value } : {})
  }
  const serialized = JSON.stringify({ configuration, ...payload })
  if (budgetRetry.body !== serialized) budgetRetry = { body: serialized, id: operationId() }
  if (await mutate(configuration ? '/budget-config' : '/budget-adjustments', configuration ? 'PATCH' : 'POST', { ...payload, operationId: budgetRetry.id })) {
    budgetRetry = { body: '', id: '' }; adjust.reason = ''; config.reason = ''; adjustApplicationId.value = ''
  }
}
async function submitApplication() {
  if (pending.value || !editable.value || !applicationForm.requestedCny || !applicationForm.reason.trim()) return
  const current = generation; pending.value = true; error.value = ''
  try {
    await api(`${base.value}/budget-applications`, { method: 'POST', body: JSON.stringify({ ...applicationForm }) })
    if (current !== generation) return
    toast('申请已登记'); applicationForm.requestedCny = ''; applicationForm.reason = ''; await load()
  } catch (e: any) { if (current === generation) error.value = e.message }
  finally { if (current === generation) pending.value = false }
}
async function rejectApplication(application: any) {
  if (pending.value || !editable.value) return
  const current = generation; pending.value = true; error.value = ''
  try {
    await api(`${base.value}/budget-applications/${application.id}/decision`, { method: 'POST', body: JSON.stringify({ note: '' }) })
    if (current !== generation) return
    toast('已驳回'); await load()
  } catch (e: any) { if (current === generation) error.value = e.message }
  finally { if (current === generation) pending.value = false }
}
watch(() => adjust.scope, () => {
  if (!budget.value) return
  adjust.limitCny = adjust.scope === 'CURRENT' ? budget.value.limitCny : budget.value.defaultLimitCny
  adjust.unlimited = adjust.scope === 'CURRENT' ? budget.value.unlimited : budget.value.defaultUnlimited
})
watch(tab, value => { if (value === 'models') loadModels(); if (value === 'projects') loadProjects(); if (value === 'members') searchUsers(); if (value === 'analysis' && !analysisLoaded.value) loadAnalysis() }, { immediate: true })
watch(id, () => {
  generation++; pending.value = false; group.value = null; budget.value = null; confirmation.value = null
  memberOffset.value = 0; entryOffset.value = 0; applicationOffset.value = 0; previewAccount.value = ''; models.value = []; tab.value = 'overview'; budgetRetry = { body: '', id: '' }
  members.value = { items: [], total: 0, offset: 0, limit: 20 }; entries.value = { items: [], total: 0, offset: 0, limit: 20 }; applications.value = { items: [], total: 0, offset: 0, limit: 20 }; users.value = { items: [], total: 0, offset: 0, limit: 20 }
  regionProjects.value = { items: [], total: 0, offset: 0, limit: 100 }
  applicationForm.requestedCny = ''; applicationForm.reason = ''; adjustApplicationId.value = ''
  userOffset.value = 0; userSearch.value = ''; accountId.value = ''; modelsReady.value = false; selected.value = []; modelSearch.value = ''
  adjust.scope = 'CURRENT'; adjust.reason = ''; config.reason = ''
  seriesLifecycle.next(); rankLifecycle.next(); requestLifecycle.next()
  groupSeries.value = []; ranking.value = { items: [], total: 0, offset: 0, limit: 20 }; analysisLoaded.value = false; dimension.value = 'account'; rankOffset.value = 0
  seriesError.value = ''; rankError.value = ''; analysisError.value = ''; seriesLoading.value = false; rankLoading.value = false
  selectedId.value = null; requestQuery.value = ''; requestError.value = ''; requestLoading.value = false
  analysisRange.value = defaultCompanyDateRange(); analysisDates.start = companyDay(analysisRange.value.start); analysisDates.end = companyDay(new Date(new Date(analysisRange.value.end).getTime() - 1).toISOString())
  optionLifecycle.next(); userLifecycle.next(); load()
}, { immediate: true })
onUnmounted(() => { generation++; lifecycle.dispose(); optionLifecycle.dispose(); userLifecycle.dispose(); seriesLifecycle.dispose(); rankLifecycle.dispose(); requestLifecycle.dispose() })
</script>
<template>
  <header class="page-header"><div><button class="back-link" @click="router.push('/usage-groups')">← 返回用量组</button><h1>{{ group?.name || '用量组详情' }}</h1><span v-if="group" class="subtitle">{{ group.type === 'REGION' ? '区域组' : group.type === 'PROJECT' ? '项目组' : '部门组' }} · {{ group.archivedAt ? '已归档' : group.enabled ? '启用' : '停用' }}</span></div><button :disabled="loading || pending" @click="load">刷新</button></header>
  <nav class="actions" aria-label="用量组详情"><button v-for="t in [['overview','概览'],['members','成员'],...(group?.type === 'REGION' ? [['projects','关联项目']] : []),['models','允许模型'],['budget','预算'],['analysis','使用分析'],['usage','用量']]" :key="t[0]" :data-tab="t[0]" :class="{ primary: tab === t[0] }" :disabled="pending || !group" @click="tab = t[0]">{{ t[1] }}</button></nav>
  <p v-if="error" class="state error" role="alert">{{ error }}</p><p v-if="loading" class="state">正在加载…</p>
  <template v-if="group && budget">
    <div class="detail-grid"><article class="panel metric-block"><span>当前周期 · {{ budget.periodKey }}</span><strong class="small-strong">{{ budgetLabel(budget) }}</strong><small>{{ budget.budgetMode === 'TOTAL' ? '项目总额（长期累计）' : '自然月' }} · {{ budget.budgetTimezone }}</small><small v-if="budgetWarning(budget)">{{ budgetWarning(budget) }}</small></article><article class="panel metric-block"><span>已结算采购成本</span><strong class="small-strong">{{ formatCny(budget.spentCny) }}</strong></article><article class="panel metric-block"><span>预占</span><strong class="small-strong">{{ formatCny(budget.reservedCny) }}</strong><small>待核算（包含在预占内）{{ formatCny(budget.uncertainCny) }}</small></article><article class="panel metric-block"><span>可用额度</span><strong class="small-strong">{{ budget.unlimited ? '不限额' : formatCny(budget.availableCny) }}</strong></article></div>
    <section v-if="tab === 'overview'" class="panel"><form class="stack-form" @submit.prevent="mutate('', 'PATCH', form)"><label>名称<input v-model="form.name" required maxlength="120" :disabled="!editable || pending"></label><label>说明<textarea v-model="form.description" maxlength="2000" :disabled="!editable || pending" /></label><div class="actions"><button :disabled="!editable || pending">保存资料</button><button type="button" :disabled="!editable || pending" @click="confirmation = { path: group.enabled ? '/disable' : '/enable', method: 'POST', message: '停用会阻止此组所有新模型调用；启用仍需满足成员、模型和预算条件。' }">{{ group.enabled ? '停用组' : '启用组' }}</button><button type="button" :disabled="!editable || pending" @click="confirmation = { path: '', method: 'DELETE', message: '归档不可恢复，将永久撤销组内 Key 和设备授权，历史成本保留。' }">归档组</button></div></form></section>
    <section v-if="tab === 'projects'" class="panel table-panel"><h2>关联项目</h2><p class="muted">区域下当前启用项目；额度、职责成员和有效 Key 汇总直接来自项目档案。</p><table v-if="regionProjects.items.length"><thead><tr><th>项目 / 编码</th><th>项目额度</th><th>已用 / 预占 / 可用</th><th>人员</th><th>有效 Key</th><th>操作</th></tr></thead><tbody><tr v-for="project in regionProjects.items" :key="project.id"><td>{{ project.name }}<small>{{ project.code }}</small></td><td>{{ project.budget?.unlimited ? '不限额' : formatCny(project.budget?.limitCny || '0') }}</td><td>{{ formatCny(project.budget?.spentCny || '0') }} / {{ formatCny(project.budget?.reservedCny || '0') }} / {{ project.budget?.unlimited ? '不限额' : formatCny(project.budget?.availableCny || '0') }}</td><td><strong>职责成员 {{ project.memberCount }}</strong><small v-if="project.owners.length">负责人：{{ project.owners.map(owner => owner.displayName).join('、') }}</small></td><td>{{ project.activeKeyCount }}</td><td><button data-action="view-project-keys" @click="router.push({ path: `/projects/${project.id}`, query: { tab: 'keys' } })">查看 Key</button></td></tr></tbody></table><p v-else class="empty">暂无关联项目</p></section>
    <section v-if="tab === 'members'" class="panel table-panel"><h2>组成员</h2><p class="muted">移除成员会永久撤销该员工在本组的 Key 和设备授权；重新加入不会恢复。成员用量统计为近 30 天、当前组内请求。</p><table v-if="members.items.length"><thead><tr><th>员工</th><th>组内角色</th><th>所属项目</th><th>近 30 天用量</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="m in members.items" :key="m.accountId"><td><button @click="router.push(`/users/${m.accountId}`)">{{ m.membership.account.displayName }}</button><small>{{ m.membership.account.email }}</small></td><td>{{ m.role === 'LEADER' ? '负责人' : '成员' }}</td><td><template v-if="m.projects?.length"><span v-for="project in m.projects" :key="project.id">{{ projectLabel(project) }}</span></template><span v-else>—</span></td><td><strong>{{ m.usage?.requests ?? 0 }} 次</strong><small>Token {{ tokens(m.usage?.totalTokens) }} · 采购成本 {{ formatCny(m.usage?.costCny || '0') }}</small><small>最后使用 {{ m.usage?.lastUsedAt ? chinaTime(m.usage.lastUsedAt) : '—' }}</small></td><td>{{ m.membership.status }}</td><td><button :disabled="!editable || pending" @click="confirmation = { path: `/members/${m.accountId}`, method: 'DELETE', message: '永久撤销该员工本组凭据，并移除成员，确认继续？' }">移除</button><button :disabled="!editable || pending" @click="mutate(`/members/${m.accountId}/leader`, m.role === 'LEADER' ? 'DELETE' : 'POST')">{{ m.role === 'LEADER' ? '取消负责人' : '设为负责人' }}</button><button @click="previewAccount = m.accountId; tab = 'models'">预览模型权限</button></td></tr></tbody></table><p v-else class="empty">暂无成员</p><Pagination :total="members.total" :offset="memberOffset" :limit="20" @change="memberOffset = $event; load()" />
      <form class="form-row" @submit.prevent="userOffset = 0; searchUsers()"><input v-model="userSearch" placeholder="搜索员工姓名或邮箱" aria-label="搜索员工"><button :disabled="pending">搜索员工</button></form><form class="form-row" @submit.prevent="mutate('/members', 'POST', { accountId })"><label>添加员工<select v-model="accountId" required><option value="">请选择</option><option v-for="u in users.items" :key="u.id" :value="u.id" :disabled="u.status !== 'ACTIVE'">{{ u.displayName }} · {{ u.email }}</option></select></label><button :disabled="!editable || pending || !accountId">加入组</button></form><Pagination :total="users.total" :offset="userOffset" :limit="20" @change="userOffset = $event; searchUsers()" />
    </section>
    <section v-if="tab === 'models'" class="panel"><h2>允许模型</h2><p class="muted">模型权限是组白名单与现有组织/员工/角色策略的交集。协议表示当前配置，不代表实时健康。</p><p v-if="previewAccount">正在预览成员 {{ members.items.find(m => m.accountId === previewAccount)?.membership.account.displayName || previewAccount }} 的已保存权限。<button @click="previewAccount = ''; loadModels()">退出预览</button></p><input v-model="modelSearch" placeholder="搜索模型" aria-label="搜索允许模型"><form @submit.prevent="mutate('/models', 'PUT', { publicModelIds: selected }).then(ok => ok && loadModels())"><div v-for="m in visibleModels" :key="m.id" class="panel"><label class="check-row"><input v-model="selected" type="checkbox" :value="m.id" :disabled="!editable || pending || (m.archived && !selected.includes(m.id))">{{ m.displayName }} · {{ m.id }}</label><small>{{ m.protocols.join(' / ') || '无可用协议' }}</small><p v-for="reason in m.reasons" :key="reason" class="muted">{{ reason }}</p><p v-if="m.allowed === true" class="muted">该员工可用</p></div><p v-if="!models.length" class="empty">暂无模型</p><button :disabled="!editable || pending">保存允许模型</button></form></section>
    <section v-if="tab === 'budget'" class="panel"><h2>人民币采购预算</h2><p class="muted">额度是上限，不是追加金额。0 表示不可调用；不限额必须显式勾选。当前调整不会改变下周期默认值。</p><form id="budget-adjust-form" class="stack-form" @submit.prevent="saveBudget()"><label>调整范围<select v-model="adjust.scope" :disabled="pending"><option value="CURRENT">当前周期总额度</option><option value="DEFAULT" :disabled="budget.budgetMode === 'TOTAL'">下周期默认额度</option></select></label><label v-if="adjust.scope === 'CURRENT' && pendingApplications.length">关联预算申请<select v-model="adjustApplicationId" :disabled="pending"><option value="">不关联申请</option><option v-for="a in pendingApplications" :key="a.id" :value="a.id">{{ a.applicant?.account?.displayName || '未知' }} · 申请 {{ formatCny(a.requestedCny) }} · {{ a.reason }}</option></select></label><small>下周期默认：{{ budgetLabel({ unlimited: budget.defaultUnlimited, limitCny: budget.defaultLimitCny }) }}</small><label>额度（CNY）<input v-model="adjust.limitCny" aria-label="调整额度" inputmode="decimal" pattern="(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?" required :disabled="pending"></label><label class="check-row"><input v-model="adjust.unlimited" type="checkbox" :disabled="pending">显式不限额</label><label>调整原因<input v-model="adjust.reason" aria-label="调整原因" required maxlength="2000" :disabled="pending"></label><button :disabled="!editable || pending || !adjust.reason.trim()">保存额度</button></form>
      <h3>周期设置</h3><p class="muted">有请求记录的周期不能切换模式或时区。</p><form class="stack-form" @submit.prevent="saveBudget(true)"><label>模式<select v-model="config.budgetMode" :disabled="pending"><option value="TOTAL">项目总额（长期累计）</option><option value="MONTHLY">自然月（不结转）</option></select></label><label>时区<input v-model="config.budgetTimezone" required :disabled="pending"></label><label>变更原因<input v-model="config.reason" required maxlength="2000" :disabled="pending"></label><button :disabled="!editable || pending || !config.reason.trim()">保存周期设置</button></form>
      <h3>预算账目与调整记录</h3><p v-if="requestLoading" class="state">正在查找请求…</p><p v-if="requestError" class="state error" role="alert">{{ requestError }}</p><table v-if="entries.items.length"><thead><tr><th>时间（中国标准时间） / 请求</th><th>周期 / 类型</th><th>状态</th><th>历史预留 / 当前保留 / 已结算</th><th>原因</th></tr></thead><tbody><tr v-for="e in entries.items" :key="e.id"><td>{{ chinaTime(e.startedAt) }}<small class="mono"><button v-if="e.requestId" :aria-label="`查看请求 ${e.requestId} 详情`" :disabled="requestLoading" @click="openRequest(e)">{{ e.requestId }}</button><template v-else>{{ e.operationId }}</template></small></td><td>{{ e.periodId }}<small>{{ e.kind }}</small></td><td>{{ budgetEntryStatus(e.status) }}</td><td>{{ ['SETTLED', 'RELEASED'].includes(e.status) ? '历史预留' : '当前保留' }} {{ formatCny(e.reservedCny) }}<small>已结算 {{ formatCny(e.settledCny) }}</small></td><td>{{ e.reason || '—' }}<details v-if="e.kind !== 'REQUEST'"><summary>调整前后</summary><pre>{{ JSON.stringify({ before: e.snapshot?.before, after: e.snapshot?.after }, null, 2) }}</pre></details></td></tr></tbody></table><p v-else class="empty">暂无预算账目</p><Pagination :total="entries.total" :offset="entryOffset" :limit="20" @change="entryOffset = $event; load()" />
      <h3>预算申请记录</h3><p class="muted">登记线下预算申请；批复时在上方额度调整中选择关联申请（批复金额=批复后总额度），或在列表中驳回。</p>
      <form class="form-row" @submit.prevent="submitApplication"><label>登记申请金额（CNY）<input v-model="applicationForm.requestedCny" inputmode="decimal" pattern="(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?" required :disabled="!editable || pending"></label><label>事由<input v-model="applicationForm.reason" required maxlength="2000" :disabled="!editable || pending"></label><button :disabled="!editable || pending || !applicationForm.requestedCny || !applicationForm.reason.trim()">登记申请</button></form>
      <table v-if="applications.items.length"><thead><tr><th>申请时间</th><th>申请人</th><th>申请金额</th><th>状态</th><th>批复金额</th><th>事由 / 说明</th><th>关联调整</th><th>操作</th></tr></thead><tbody><tr v-for="a in applications.items" :key="a.id"><td>{{ chinaTime(a.createdAt) }}</td><td>{{ a.applicant?.account?.displayName || '—' }}</td><td>{{ formatCny(a.requestedCny) }}</td><td>{{ applicationStatus(a.status) }}</td><td>{{ a.approvedCny != null ? formatCny(a.approvedCny) : '—' }}</td><td>{{ a.reason }}<small v-if="a.decisionNote">{{ a.decisionNote }}</small></td><td><span v-if="a.linkedEntryId" class="mono">{{ a.linkedEntryId.slice(0, 8) }}…</span><span v-else>—</span></td><td><button v-if="a.status === 'REGISTERED'" :disabled="!editable || pending" @click="rejectApplication(a)">驳回</button><span v-else>—</span></td></tr></tbody></table><p v-else class="empty">暂无申请记录</p><Pagination :total="applications.total" :offset="applicationOffset" :limit="20" @change="applicationOffset = $event; load()" />
    </section>
    <section v-if="tab === 'analysis'" class="panel">
      <h2>使用分析</h2><p class="muted">当前用量组 · 人民币采购成本 · Asia/Shanghai 自然日 · 默认近 7 天，最多 90 天；分析日期不改变当前预算周期。</p>
      <button aria-label="查看完整分析" @click="openAnalytics">查看完整分析</button>
      <form id="group-analysis-form" class="form-row" @submit.prevent="applyAnalysis"><label>开始日期<input v-model="analysisDates.start" type="date" aria-label="分析开始日期" required></label><label>结束日期（含当日）<input v-model="analysisDates.end" type="date" aria-label="分析结束日期" required></label><button>应用日期</button></form>
      <p v-if="analysisError" class="state error" role="alert">{{ analysisError }}</p><p class="muted">已应用：{{ companyDay(analysisRange.start) }} 至 {{ companyDay(new Date(new Date(analysisRange.end).getTime() - 1).toISOString()) }}</p>
      <h3>采购成本趋势</h3><p v-if="seriesLoading" class="state">正在加载趋势…</p><p v-else-if="seriesError" class="state error" role="alert">{{ seriesError }} <button @click="loadSeries">重试趋势</button></p><TrendChart v-else :data="groupSeries" metric="cost" timezone="Asia/Shanghai" />
      <h3>成本排行</h3><select v-model="dimension" aria-label="排行维度" @change="rankOffset = 0; loadRanking()"><option value="account">员工</option><option value="model">模型</option><option value="apiKey">员工 Key</option></select>
      <p v-if="rankLoading" class="state">正在加载排行…</p><p v-else-if="rankError" class="state error" role="alert">{{ rankError }} <button @click="loadRanking">重试排行</button></p>
      <template v-else><table v-if="ranking.items.length"><thead><tr><th>名称</th><th>请求数</th><th>Token</th><th>采购成本</th></tr></thead><tbody><tr v-for="(row, index) in ranking.items" :key="row.id ?? index"><td>{{ row.name }}<small>{{ row.id }}</small></td><td>{{ row.requests }}</td><td>{{ row.totalTokens ?? '未提供' }}</td><td>{{ formatCny(row.costCny) }}</td></tr></tbody></table><p v-else class="empty">当前维度没有数据</p><Pagination :total="ranking.total" :offset="rankOffset" :limit="20" @change="rankOffset = $event; loadRanking()" /></template>
    </section>
    <section v-if="tab === 'usage'"><Usage :group-id="id" embedded /></section>
  </template>
  <UsageDetail v-if="selectedId" :id="selectedId" :query="requestQuery" @close="selectedId = null" />
  <ConfirmDialog :open="Boolean(confirmation)" title="确认组管理操作" :message="confirmation?.message || ''" danger :close-disabled="pending" @cancel="confirmation = null" @confirm="confirmation && mutate(confirmation.path, confirmation.method)" />
</template>
