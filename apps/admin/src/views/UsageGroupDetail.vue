<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import { budgetLabel, operationId, type GroupBudget, type UsageGroup } from '../usage-groups'
import { formatCny } from '../currency'
import { toast } from '../toast'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import Pagination from '../components/Pagination.vue'
import Usage from './Usage.vue'
const route = useRoute(), router = useRouter(), lifecycle = createRequestLifecycle()
const id = computed(() => String(route.params.id)), base = computed(() => `/api/v1/admin/usage-groups/${id.value}`)
const group = ref<UsageGroup | null>(null), budget = ref<GroupBudget | null>(null)
const tab = ref('overview'), error = ref(''), loading = ref(false), pending = ref(false)
const members = ref<Page<any>>({ items: [], total: 0, offset: 0, limit: 20 }), entries = ref<Page<any>>({ items: [], total: 0, offset: 0, limit: 20 })
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
let generation = 0
// Retry an identical adjustment with its original ID; editing the payload starts a new operation.
let budgetRetry = { body: '', id: '' }
const optionLifecycle = createRequestLifecycle(), userLifecycle = createRequestLifecycle()
async function load() {
  const request = lifecycle.next(); loading.value = true; error.value = ''
  try {
    const [g, b, m, e] = await Promise.all([api<UsageGroup>(base.value), api<GroupBudget>(`${base.value}/budget`), api<Page<any>>(`${base.value}/members?offset=${memberOffset.value}&limit=20`), api<Page<any>>(`${base.value}/budget-entries?offset=${entryOffset.value}&limit=20`)])
    if (!lifecycle.isCurrent(request)) return
    if (!group.value) { adjust.limitCny = b.limitCny; adjust.unlimited = b.unlimited }
    group.value = g; budget.value = b; members.value = m; entries.value = e
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
  const payload = configuration ? { ...config } : { ...adjust, ...(adjust.scope === 'CURRENT' && budget.value?.periodId ? { periodId: budget.value.periodId } : {}) }
  const serialized = JSON.stringify({ configuration, ...payload })
  if (budgetRetry.body !== serialized) budgetRetry = { body: serialized, id: operationId() }
  if (await mutate(configuration ? '/budget-config' : '/budget-adjustments', configuration ? 'PATCH' : 'POST', { ...payload, operationId: budgetRetry.id })) {
    budgetRetry = { body: '', id: '' }; adjust.reason = ''; config.reason = ''
  }
}
watch(() => adjust.scope, () => {
  if (!budget.value) return
  adjust.limitCny = adjust.scope === 'CURRENT' ? budget.value.limitCny : budget.value.defaultLimitCny
  adjust.unlimited = adjust.scope === 'CURRENT' ? budget.value.unlimited : budget.value.defaultUnlimited
})
watch(tab, value => { if (value === 'models') loadModels(); if (value === 'members') searchUsers() })
watch(id, () => {
  generation++; pending.value = false; group.value = null; budget.value = null; confirmation.value = null
  memberOffset.value = 0; entryOffset.value = 0; previewAccount.value = ''; models.value = []; tab.value = 'overview'; budgetRetry = { body: '', id: '' }
  optionLifecycle.next(); userLifecycle.next(); load()
}, { immediate: true })
onUnmounted(() => { generation++; lifecycle.dispose(); optionLifecycle.dispose(); userLifecycle.dispose() })
</script>
<template>
  <header class="page-header"><div><button class="back-link" @click="router.push('/usage-groups')">← 返回用量组</button><h1>{{ group?.name || '用量组详情' }}</h1><span v-if="group" class="subtitle">{{ group.type === 'PROJECT' ? '项目组' : '部门组' }} · {{ group.archivedAt ? '已归档' : group.enabled ? '启用' : '停用' }}</span></div><button :disabled="loading || pending" @click="load">刷新</button></header>
  <nav class="actions" aria-label="用量组详情"><button v-for="t in [['overview','概览'],['members','成员'],['models','允许模型'],['budget','预算'],['usage','用量']]" :key="t[0]" :data-tab="t[0]" :class="{ primary: tab === t[0] }" :disabled="pending" @click="tab = t[0]">{{ t[1] }}</button></nav>
  <p v-if="error" class="state error" role="alert">{{ error }}</p><p v-if="loading" class="state">正在加载…</p>
  <template v-if="group && budget">
    <div class="detail-grid"><article class="panel metric-block"><span>当前额度 · {{ budget.periodKey }}</span><strong class="small-strong">{{ budgetLabel(budget) }}</strong></article><article class="panel metric-block"><span>已结算采购成本</span><strong class="small-strong">{{ formatCny(budget.spentCny) }}</strong></article><article class="panel metric-block"><span>预占（含待核对）</span><strong class="small-strong">{{ formatCny(budget.reservedCny) }}</strong><small>待核对 {{ formatCny(budget.uncertainCny) }}</small></article><article class="panel metric-block"><span>可用额度</span><strong class="small-strong">{{ budget.unlimited ? '不限额' : formatCny(budget.availableCny) }}</strong></article></div>
    <section v-if="tab === 'overview'" class="panel"><form class="stack-form" @submit.prevent="mutate('', 'PATCH', form)"><label>名称<input v-model="form.name" required maxlength="120" :disabled="!editable || pending"></label><label>说明<textarea v-model="form.description" maxlength="2000" :disabled="!editable || pending" /></label><div class="actions"><button :disabled="!editable || pending">保存资料</button><button type="button" :disabled="!editable || pending" @click="confirmation = { path: group.enabled ? '/disable' : '/enable', method: 'POST', message: '停用会阻止此组所有新模型调用；启用仍需满足成员、模型和预算条件。' }">{{ group.enabled ? '停用组' : '启用组' }}</button><button type="button" :disabled="!editable || pending" @click="confirmation = { path: '', method: 'DELETE', message: '归档不可恢复，将永久撤销组内 Key 和设备授权，历史成本保留。' }">归档组</button></div></form></section>
    <section v-if="tab === 'members'" class="panel table-panel"><h2>组成员</h2><p class="muted">移除成员会永久撤销该员工在本组的 Key 和设备授权；重新加入不会恢复。</p><table v-if="members.items.length"><thead><tr><th>员工</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="m in members.items" :key="m.accountId"><td><button @click="router.push(`/users/${m.accountId}`)">{{ m.membership.account.displayName }}</button><small>{{ m.membership.account.email }}</small></td><td>{{ m.membership.status }}</td><td><button :disabled="!editable || pending" @click="confirmation = { path: `/members/${m.accountId}`, method: 'DELETE', message: '永久撤销该员工本组凭据，并移除成员，确认继续？' }">移除</button><button @click="previewAccount = m.accountId; tab = 'models'">预览模型权限</button></td></tr></tbody></table><p v-else class="empty">暂无成员</p><Pagination :total="members.total" :offset="memberOffset" :limit="20" @change="memberOffset = $event; load()" />
      <form class="form-row" @submit.prevent="userOffset = 0; searchUsers()"><input v-model="userSearch" placeholder="搜索员工姓名或邮箱" aria-label="搜索员工"><button :disabled="pending">搜索员工</button></form><form class="form-row" @submit.prevent="mutate('/members', 'POST', { accountId })"><label>添加员工<select v-model="accountId" required><option value="">请选择</option><option v-for="u in users.items" :key="u.id" :value="u.id" :disabled="u.status !== 'ACTIVE'">{{ u.displayName }} · {{ u.email }}</option></select></label><button :disabled="!editable || pending || !accountId">加入组</button></form><Pagination :total="users.total" :offset="userOffset" :limit="20" @change="userOffset = $event; searchUsers()" />
    </section>
    <section v-if="tab === 'models'" class="panel"><h2>允许模型</h2><p class="muted">模型权限是组白名单与现有组织/员工/角色策略的交集。协议表示当前配置，不代表实时健康。</p><p v-if="previewAccount">正在预览成员 {{ members.items.find(m => m.accountId === previewAccount)?.membership.account.displayName || previewAccount }} 的已保存权限。<button @click="previewAccount = ''; loadModels()">退出预览</button></p><input v-model="modelSearch" placeholder="搜索模型" aria-label="搜索允许模型"><form @submit.prevent="mutate('/models', 'PUT', { publicModelIds: selected }).then(ok => ok && loadModels())"><div v-for="m in visibleModels" :key="m.id" class="panel"><label class="check-row"><input v-model="selected" type="checkbox" :value="m.id" :disabled="!editable || pending || (m.archived && !selected.includes(m.id))">{{ m.displayName }} · {{ m.id }}</label><small>{{ m.protocols.join(' / ') || '无可用协议' }}</small><p v-for="reason in m.reasons" :key="reason" class="muted">{{ reason }}</p><p v-if="m.allowed === true" class="muted">该员工可用</p></div><p v-if="!models.length" class="empty">暂无模型</p><button :disabled="!editable || pending">保存允许模型</button></form></section>
    <section v-if="tab === 'budget'" class="panel"><h2>人民币采购预算</h2><p class="muted">额度是上限，不是追加金额。0 表示不可调用；不限额必须显式勾选。当前调整不会改变下周期默认值。</p><form id="budget-adjust-form" class="stack-form" @submit.prevent="saveBudget()"><label>调整范围<select v-model="adjust.scope" :disabled="pending"><option value="CURRENT">当前周期总额度</option><option value="DEFAULT" :disabled="budget.budgetMode === 'TOTAL'">下周期默认额度</option></select></label><small>下周期默认：{{ budgetLabel({ unlimited: budget.defaultUnlimited, limitCny: budget.defaultLimitCny }) }}</small><label>额度（CNY）<input v-model="adjust.limitCny" aria-label="调整额度" inputmode="decimal" pattern="(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?" required :disabled="pending"></label><label class="check-row"><input v-model="adjust.unlimited" type="checkbox" :disabled="pending">显式不限额</label><label>调整原因<input v-model="adjust.reason" aria-label="调整原因" required maxlength="2000" :disabled="pending"></label><button :disabled="!editable || pending || !adjust.reason.trim()">保存额度</button></form>
      <h3>周期设置</h3><p class="muted">有请求记录的周期不能切换模式或时区。</p><form class="stack-form" @submit.prevent="saveBudget(true)"><label>模式<select v-model="config.budgetMode" :disabled="pending"><option value="TOTAL">项目总额（长期累计）</option><option value="MONTHLY">自然月（不结转）</option></select></label><label>时区<input v-model="config.budgetTimezone" required :disabled="pending"></label><label>变更原因<input v-model="config.reason" required maxlength="2000" :disabled="pending"></label><button :disabled="!editable || pending || !config.reason.trim()">保存周期设置</button></form>
      <h3>预算账目与调整记录</h3><table v-if="entries.items.length"><thead><tr><th>时间 / 请求</th><th>周期 / 类型</th><th>状态</th><th>预占 / 已结算</th><th>原因</th></tr></thead><tbody><tr v-for="e in entries.items" :key="e.id"><td>{{ new Date(e.startedAt).toLocaleString() }}<small class="mono">{{ e.requestId || e.operationId }}</small></td><td>{{ e.periodId }}<small>{{ e.kind }}</small></td><td>{{ e.status }}</td><td>{{ formatCny(e.reservedCny) }} / {{ formatCny(e.settledCny) }}</td><td>{{ e.reason || '—' }}<details v-if="e.kind !== 'REQUEST'"><summary>调整前后</summary><pre>{{ JSON.stringify({ before: e.snapshot?.before, after: e.snapshot?.after }, null, 2) }}</pre></details></td></tr></tbody></table><p v-else class="empty">暂无预算账目</p><Pagination :total="entries.total" :offset="entryOffset" :limit="20" @change="entryOffset = $event; load()" />
    </section>
    <section v-if="tab === 'usage'"><div class="actions"><button @click="router.push({ path: '/analytics', query: { groupId: id } })">组成本趋势与员工分析</button></div><Usage :group-id="id" embedded /></section>
  </template>
  <ConfirmDialog :open="Boolean(confirmation)" title="确认组管理操作" :message="confirmation?.message || ''" danger :close-disabled="pending" @cancel="confirmation = null" @confirm="confirmation && mutate(confirmation.path, confirmation.method)" />
</template>
