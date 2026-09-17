<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Decimal from 'decimal.js'
import { api } from '../api'
import { toast } from '../toast'
import { formatCny } from '../currency'
import { createRequestLifecycle, type Page } from '../device-grants'
import { companyDateRange, defaultCompanyDateRange, usageQuery } from '../usage-filters'
import EmployeeKeysPanel from '../components/EmployeeKeysPanel.vue'
import KeyConnectionHelp from '../components/KeyConnectionHelp.vue'
import Drawer from '../components/Drawer.vue'
import Pagination from '../components/Pagination.vue'
import type { AnalyticsOverview } from '../../../../packages/usage/src/analytics-types'

const props = defineProps<{ principal: { id: string; displayName: string; email?: string; organizationId: string; organizationName?: string; role: string; status?: string } }>()
const emit = defineEmits<{ 'profile-updated': []; 'password-changed': []; logout: [] }>()
const route = useRoute(), router = useRouter()
const tabs = [['basic', '基本资料'], ['security', '账号安全'], ['api-keys', 'API Keys'], ['groups', '我的用量组'], ['usage', '我的用量']]
const tab = computed(() => tabs.some(([key]) => key === route.query.tab) ? String(route.query.tab) : 'basic')
const admin = computed(() => ['PLATFORM_ADMIN', 'ORG_ADMIN'].includes(props.principal.role))
const roleLabel = computed(() => ({ PLATFORM_ADMIN: '平台管理员', ORG_ADMIN: '组织管理员', MEMBER: '员工' }[props.principal.role] || props.principal.role))
const name = ref(props.principal.displayName), pending = ref(false), formError = ref('')
const currentPassword = ref(''), newPassword = ref(''), confirmPassword = ref('')
const managed = ref(false), helpOpen = ref(false), loading = ref(false), error = ref('')
const reads = createRequestLifecycle(), mutations = createRequestLifecycle(), modelReads = createRequestLifecycle()
type Group = { id: string; name: string; type: string; enabled: boolean; archivedAt: string | null; joinedAt: string }
type Model = { id: string; displayName: string; protocols: string[] }
const groups = ref<Group[]>([]), selectedGroup = ref<Group | null>(null), models = ref<Model[]>([])
const modelsLoading = ref(false), modelsError = ref('')
type GroupUsage = { id: string | null; name: string; requests: number; totalTokens: string; costCny: string; estimatedCostCny?: string; unsettledRequests?: number }
const usage = ref<{ overview: AnalyticsOverview; groups: Page<GroupUsage> } | null>(null)
const range = ref(defaultCompanyDateRange()), offset = ref(0)
const day = (value: string | number) => new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
const startDay = ref(day(range.value.start)), endDay = ref(day(new Date(range.value.end).getTime() - 1))
const totalTokens = computed(() => usage.value ? new Decimal(usage.value.overview.inputTokens || 0).plus(usage.value.overview.outputTokens || 0).toFixed(0) : '0')
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

async function saveName() {
  if (pending.value) return
  formError.value = ''
  if (!name.value.trim() || name.value.trim().length > 120) { formError.value = '显示名称需为 1–120 个字符'; return }
  const request = mutations.next(); pending.value = true
  try {
    await api('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ displayName: name.value.trim() }) })
    if (mutations.isCurrent(request)) { toast('个人资料已更新'); emit('profile-updated') }
  } catch (caught: any) { if (mutations.isCurrent(request)) formError.value = caught.message }
  finally { if (mutations.isCurrent(request)) pending.value = false }
}
async function changePassword() {
  if (pending.value) return
  formError.value = ''
  if (!currentPassword.value || !newPassword.value || !confirmPassword.value) { formError.value = '请填写完整'; return }
  if (newPassword.value !== confirmPassword.value) { formError.value = '两次新密码不一致'; return }
  if (newPassword.value.length < 8) { formError.value = '新密码至少 8 位'; return }
  const request = mutations.next(); pending.value = true
  try {
    await api('/api/v1/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: currentPassword.value, newPassword: newPassword.value }) })
    if (mutations.isCurrent(request)) { currentPassword.value = ''; newPassword.value = ''; confirmPassword.value = ''; emit('password-changed') }
  } catch (caught: any) { if (mutations.isCurrent(request)) formError.value = caught.message }
  finally { if (mutations.isCurrent(request)) pending.value = false }
}
async function load() {
  const request = reads.next(); loading.value = true; error.value = ''
  try {
    if (tab.value === 'groups') {
      const result = await api<Group[]>('/api/v1/me/profile/usage-groups')
      if (reads.isCurrent(request)) groups.value = result
    } else if (tab.value === 'usage') {
      const result = await api<NonNullable<typeof usage.value>>(`/api/v1/me/profile/usage?${usageQuery({ ...range.value, limit: '20', offset: String(offset.value) })}`)
      if (reads.isCurrent(request)) usage.value = result
    }
  } catch (caught: any) { if (reads.isCurrent(request)) error.value = caught.message }
  finally { if (reads.isCurrent(request)) loading.value = false }
}
async function showModels(group: Group) {
  const request = modelReads.next(); selectedGroup.value = group; models.value = []; modelsError.value = ''; modelsLoading.value = true
  try {
    const result = await api<Model[]>(`/api/v1/me/profile/usage-groups/${group.id}/models`)
    if (modelReads.isCurrent(request)) models.value = result
  } catch (caught: any) { if (modelReads.isCurrent(request)) modelsError.value = caught.message }
  finally { if (modelReads.isCurrent(request)) modelsLoading.value = false }
}
function closeModels() { modelReads.next(); selectedGroup.value = null }
function applyDates() {
  try { range.value = companyDateRange(startDay.value, endDay.value); offset.value = 0; void load() }
  catch (caught: any) { error.value = caught.message }
}
function changePage(value: number) { offset.value = value; void load() }
function usageLink(path: string, group?: GroupUsage) {
  const query = Object.fromEntries(new URLSearchParams(usageQuery({ ...range.value, accountId: props.principal.id, organizationId: props.principal.organizationId,
    ...(group ? group.id ? { groupId: group.id } : { groupScope: 'UNGROUPED' } : {}) })))
  void router.push({ path, query })
}
watch(() => props.principal.displayName, value => { name.value = value })
watch(() => [props.principal.id, props.principal.organizationId], () => {
  mutations.next(); pending.value = false; range.value = defaultCompanyDateRange()
  startDay.value = day(range.value.start); endDay.value = day(new Date(range.value.end).getTime() - 1)
})
watch(() => [tab.value, props.principal.id, props.principal.organizationId], () => {
  reads.next(); closeModels(); helpOpen.value = false; managed.value = false; formError.value = ''; error.value = ''; loading.value = false
  currentPassword.value = ''; newPassword.value = ''; confirmPassword.value = ''; groups.value = []; usage.value = null; offset.value = 0
  if (tab.value === 'groups' || tab.value === 'usage') void load()
}, { immediate: true })
onUnmounted(() => { reads.dispose(); mutations.dispose(); modelReads.dispose(); currentPassword.value = ''; newPassword.value = ''; confirmPassword.value = '' })
</script>

<template>
  <header class="page-header"><div><p>MY ACCOUNT</p><h1>个人中心</h1><span class="subtitle">{{ principal.displayName }} · {{ principal.email || '—' }} · {{ principal.organizationName || '—' }} · {{ roleLabel }}</span></div></header>
  <nav class="profile-tabs" aria-label="个人中心导航"><RouterLink v-for="[key, label] in tabs" :key="key" :to="{ path: '/profile', query: { tab: key } }" :aria-current="tab === key ? 'page' : undefined" :class="{ selected: tab === key }">{{ label }}</RouterLink></nav>
  <section v-if="tab === 'basic'" class="panel profile-section">
    <h2>基本资料</h2><form data-profile-form class="stack-form profile-form" @submit.prevent="saveName">
      <label>显示名称<input v-model="name" aria-label="显示名称" maxlength="120" required autocomplete="name"></label>
      <dl class="profile-facts"><div><dt>登录邮箱</dt><dd>{{ principal.email || '—' }}</dd></div><div><dt>当前组织</dt><dd>{{ principal.organizationName || '—' }}</dd></div><div><dt>角色</dt><dd>{{ roleLabel }}</dd></div><div><dt>账号状态</dt><dd>{{ principal.status === 'DISABLED' ? '已停用' : '正常' }}</dd></div></dl>
      <p class="muted">邮箱、组织和角色由管理员维护。</p><p v-if="formError" class="state error" role="alert">{{ formError }}</p><button class="primary" :disabled="pending || !name.trim()">{{ pending ? '正在保存…' : '保存资料' }}</button>
    </form>
  </section>
  <section v-else-if="tab === 'security'" class="panel profile-section">
    <h2>账号安全</h2><p class="muted">修改密码后，旧的网页会话和设备访问 Token 将失效，设备可通过有效的刷新凭据重新获取访问权限。API Key 不会因此撤销。</p>
    <form data-password-form class="stack-form profile-form" @submit.prevent="changePassword"><label>当前密码<input v-model="currentPassword" aria-label="当前密码" type="password" autocomplete="current-password" required></label><label>新密码<input v-model="newPassword" aria-label="新密码" type="password" autocomplete="new-password" minlength="8" required></label><label>确认新密码<input v-model="confirmPassword" aria-label="确认新密码" type="password" autocomplete="new-password" minlength="8" required></label><p v-if="formError" role="alert" class="state error">{{ formError }}</p><button class="primary" :disabled="pending">{{ pending ? '正在修改…' : '修改密码并重新登录' }}</button></form>
    <button class="profile-logout" @click="emit('logout')">退出当前登录</button>
  </section>
  <section v-else-if="tab === 'api-keys'" class="profile-keys">
    <div class="section-header"><div class="actions"><button data-scope="mine" :class="{ primary: !managed }" :aria-pressed="!managed" @click="managed = false">我的 Key</button><button v-if="admin" data-scope="organization" :class="{ primary: managed }" :aria-pressed="managed" @click="managed = true">组织 Key</button></div><button @click="helpOpen = true">接入说明</button></div>
    <p v-if="managed" class="muted">管理当前组织内的员工 Key。</p>
    <EmployeeKeysPanel :key="`${principal.organizationId}:${principal.id}:${managed}`" :managed="admin && managed" :account-id="admin && !managed ? principal.id : undefined" />
    <Drawer :open="helpOpen" title="客户端接入说明" @close="helpOpen = false"><KeyConnectionHelp /></Drawer>
  </section>
  <section v-else-if="tab === 'groups'" class="panel profile-section">
    <div class="section-header"><h2>我的用量组</h2><button :disabled="loading" @click="load">刷新</button></div>
    <p v-if="loading" class="state" role="status">正在加载用量组…</p><div v-else-if="error" role="alert"><p class="state error">{{ error }}</p><button data-retry @click="load">重试</button></div>
    <template v-else><table v-if="groups.length"><thead><tr><th>用量组</th><th>类型</th><th>状态</th><th>加入时间</th><th>模型</th></tr></thead><tbody><tr v-for="group in groups" :key="group.id"><td>{{ group.name }}</td><td>{{ group.type === 'PROJECT' ? '项目组' : '部门组' }}</td><td>{{ group.archivedAt ? '已归档' : group.enabled ? '正常' : '已停用' }}</td><td>{{ date(group.joinedAt) }}</td><td><button data-models :disabled="!group.enabled || Boolean(group.archivedAt)" @click="showModels(group)">查看可用模型</button></td></tr></tbody></table><p v-else class="empty">暂无用量组，请联系管理员添加。</p></template>
    <Drawer :open="Boolean(selectedGroup)" :title="`${selectedGroup?.name || ''} · 可用模型`" @close="closeModels"><p v-if="modelsLoading" role="status">正在加载模型…</p><div v-else-if="modelsError" role="alert"><p class="state error">{{ modelsError }}</p><button @click="selectedGroup && showModels(selectedGroup)">重试</button></div><template v-else><p class="muted">目录表示当前模型权限和协议，实际调用还受组预算与服务可用性限制。</p><ul v-if="models.length" class="model-list"><li v-for="model in models" :key="model.id"><strong>{{ model.displayName }}</strong><small>{{ model.id }} · {{ model.protocols.join(' / ') }}</small></li></ul><p v-else class="empty">当前组没有可用模型。</p></template></Drawer>
  </section>
  <section v-else class="panel profile-section">
    <h2>我的用量</h2><form class="profile-date-range" @submit.prevent="applyDates"><label>开始日期<input v-model="startDay" aria-label="开始日期" type="date" required></label><label>结束日期<input v-model="endDay" aria-label="结束日期" type="date" required></label><button :disabled="loading">查询</button></form><p class="muted">中国标准时间 · 按个人实际使用归集成本，组预算为共享额度。</p>
    <p v-if="loading" class="state" role="status">正在加载用量…</p><div v-else-if="error" role="alert"><p class="state error">{{ error }}</p><button data-retry @click="load">重试</button></div>
    <template v-else-if="usage"><div class="profile-metrics"><div><small>请求数</small><strong>{{ usage.overview.requests }}</strong></div><div><small>输入 + 输出 Token</small><strong>{{ totalTokens }}</strong></div><div><small>人民币成本</small><strong>{{ formatCny(usage.overview.costCny) }}</strong></div></div>
      <p class="muted">其中估算成本 {{ formatCny(usage.overview.estimatedCostCny) }} · 待核对 {{ usage.overview.unsettledRequests }} 次</p><p v-if="usage.overview.tokenUsageIncomplete" class="state">部分请求未提供完整 Token 用量。</p>
      <div class="actions"><button data-usage-logs @click="usageLink('/usage')">我的使用日志</button><button @click="usageLink('/analytics')">查看统计分析</button></div>
      <table v-if="usage.groups.items.length"><thead><tr><th>用量组</th><th>请求数</th><th>Token</th><th>个人成本</th><th>明细</th></tr></thead><tbody><tr v-for="group in usage.groups.items" :key="group.id || 'ungrouped'"><td>{{ group.name || '历史未分组' }}</td><td>{{ group.requests }}</td><td>{{ group.totalTokens }}</td><td>{{ formatCny(group.costCny) }}<small v-if="group.estimatedCostCny">估算 {{ formatCny(group.estimatedCostCny) }}</small><small v-if="group.unsettledRequests">待核对 {{ group.unsettledRequests }} 次</small></td><td><button @click="usageLink('/usage', group)">查看</button></td></tr></tbody></table><p v-else class="empty">所选时间内暂无使用记录。</p>
      <Pagination :total="usage.groups.total" :limit="usage.groups.limit" :offset="usage.groups.offset" @change="changePage" />
    </template>
  </section>
</template>

<style scoped>
.profile-tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px;border-bottom:1px solid #223046;padding-bottom:12px}.profile-tabs a{padding:10px 16px;border-radius:8px;color:#8293aa;text-decoration:none}.profile-tabs .selected{background:#16283a;color:#72e3c2}.profile-tabs a:focus-visible{outline:2px solid #72e3c2;outline-offset:2px}.profile-section h2{margin-top:0}.profile-form{max-width:480px}.profile-facts{display:grid;gap:14px;margin:8px 0}.profile-facts div{display:grid;grid-template-columns:90px 1fr;gap:12px}.profile-facts dt{color:#8293aa}.profile-facts dd{margin:0;overflow-wrap:anywhere}.profile-logout{margin-top:24px}.profile-date-range{display:flex;align-items:end;flex-wrap:wrap;gap:12px}.profile-date-range label{display:grid;gap:8px}.profile-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:20px 0}.profile-metrics div{padding:16px;border:1px solid #223046;border-radius:10px;display:grid;gap:8px}.profile-metrics strong{font-size:24px;overflow-wrap:anywhere}.model-list{padding-left:20px}.model-list li{padding:12px 0}.model-list small{display:block;color:#8293aa;overflow-wrap:anywhere}.profile-keys>.section-header{margin-bottom:16px}@media(max-width:600px){.profile-metrics{grid-template-columns:1fr}.profile-tabs a{padding:8px}.profile-date-range label{width:100%}}
</style>
