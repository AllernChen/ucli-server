<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import { toast } from '../toast'
import Drawer from './Drawer.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import Pagination from './Pagination.vue'
import { formatCny } from '../currency'

const props = withDefaults(defineProps<{ managed?: boolean; accountId?: string; selfAccountId?: string }>(), { managed: false })
type Group = { id: string; name: string; type?: string }
type Project = { id: string; name: string; code: string }
type Person = { id: string; displayName: string; email: string }
type Key = { id: string; name: string; groupId: string; projectId?: string | null; accountId?: string; organizationId?: string; secretHint: string; expiresAt: string | null; disabledAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdAt?: string; account?: Person; group?: Group; project?: Project | null; createdBy?: { id: string; displayName: string }; usage?: { requests: number; totalTokens: string; costCny: string }; budget?: { keyCostSharePercent: number | null; projectUsageSharePercent: number | null } }
type KeyPage = Page<Key> & { filterGroups?: Group[] }
const rows = ref<KeyPage>({ items: [], total: 0, offset: 0, limit: 20 })
const groups = ref<Group[]>([]), people = ref<Page<Person>>({ items: [], total: 0, offset: 0, limit: 20 }), groupOptions = ref<Page<Group>>({ items: [], total: 0, offset: 0, limit: 20 })
const projects = ref<Project[]>([])
const pageFilterGroups = ref<Group[]>([])
const offset = ref(0), loading = ref(false), pending = ref(false), error = ref(''), formError = ref('')
const open = ref(false), editing = ref<Key | null>(null), detail = ref<Key | null>(null), secret = ref('')
const revealPassword = ref(''), revealedOwnSecret = ref(''), revealError = ref(''), revealingOwn = ref(false), copyState = ref('')
const selectedPerson = ref<Person | null>(null)
const filters = reactive({ q: '', accountId: '', groupId: '', projectId: '', status: '' })
const form = reactive({ accountId: '', name: '', groupId: '', projectId: '', expiresAt: '' })
const optionSearch = reactive({ people: '', groups: '', peopleOffset: 0, groupsOffset: 0 })
const action = ref<{ key: Key; verb: 'revoke' | 'delete' | 'enable' | 'disable' } | null>(null)
const managed = computed(() => props.managed)
const selfMode = computed(() => !managed.value && (!props.accountId || props.accountId === props.selfAccountId))
const adminMode = computed(() => managed.value || (Boolean(props.accountId) && !selfMode.value))
const filterGroups = computed(() => Array.from(new Map([...groups.value, ...pageFilterGroups.value, ...groupOptions.value.items, ...rows.value.items.flatMap(key => key.group ? [key.group] : [])].map(group => [group.id, group])).values()))
const formPeople = computed(() => selectedPerson.value && !people.value.items.some(person => person.id === selectedPerson.value?.id) ? [selectedPerson.value, ...people.value.items] : people.value.items)
const listPath = computed(() => {
  if (managed.value) return '/api/v1/admin/employee-api-keys'
  if (selfMode.value || !props.accountId) return '/api/v1/me/api-keys'
  return `/api/v1/admin/users/${props.accountId}/api-keys`
})
const lifecycle = createRequestLifecycle()
let viewGeneration = 0, groupRequest = 0
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '—'
function status(key: Key) { return key.revokedAt ? '已撤销' : key.disabledAt ? '已停用' : key.expiresAt && new Date(key.expiresAt) <= new Date() ? '已过期' : '可用' }
function keyQuery() {
  const query = new URLSearchParams({ limit: '20', offset: String(offset.value) })
  for (const [name, value] of Object.entries(filters)) if (value.trim()) query.set(name, value.trim())
  return query.toString()
}
function optionQuery(q: string, optionOffset: number) {
  const query = new URLSearchParams({ limit: '20', offset: String(optionOffset) })
  if (q.trim()) query.set('q', q.trim())
  return query.toString()
}
function groupOptionQuery() {
  const query = new URLSearchParams(optionQuery(optionSearch.groups, optionSearch.groupsOffset))
  query.set('status', 'all')
  return query.toString()
}
function resetView() {
  viewGeneration++; lifecycle.next(); loading.value = false; pending.value = false; error.value = ''
  rows.value = { items: [], total: 0, offset: 0, limit: 20 }; groups.value = []; pageFilterGroups.value = []
  detail.value = null; action.value = null; secret.value = ''; open.value = false; editing.value = null; selectedPerson.value = null; formError.value = ''
  Object.assign(filters, { q: '', accountId: '', groupId: '', projectId: '', status: '' }); Object.assign(form, { accountId: '', name: '', groupId: '', projectId: '', expiresAt: '' })
}
async function loadOptions(request: number) {
  if (!managed.value) return
  const [loadedPeople, loadedGroups] = await Promise.all([
    api<Page<Person>>(`/api/v1/admin/users?${optionQuery(optionSearch.people, optionSearch.peopleOffset)}`),
    api<Page<Group>>(`/api/v1/admin/usage-groups?${groupOptionQuery()}`)
  ])
  if (lifecycle.isCurrent(request)) { people.value = loadedPeople; groupOptions.value = loadedGroups }
}
async function load() {
  const request = lifecycle.next(); loading.value = true; error.value = ''
  try {
    const [keys, membershipGroups] = await Promise.all([
      api<KeyPage>(`${listPath.value}?${keyQuery()}`),
      managed.value ? Promise.resolve([] as Group[]) : api<Group[]>(`${props.accountId ? `/api/v1/admin/users/${props.accountId}` : '/api/v1/me'}/usage-groups`),
      loadOptions(request)
    ])
    if (lifecycle.isCurrent(request)) { rows.value = keys; groups.value = membershipGroups; pageFilterGroups.value = managed.value ? [] : keys.filterGroups || [] }
  } catch (value: unknown) {
    if (lifecycle.isCurrent(request)) error.value = value instanceof Error && value.message ? value.message : '加载 Key 失败'
  } finally { if (lifecycle.isCurrent(request)) loading.value = false }
}
async function loadEmployeeGroups(accountId: string) {
  const request = ++groupRequest
  form.groupId = ''; groups.value = []
  if (!accountId) return
  try {
    const loaded = await api<Group[]>(`/api/v1/admin/users/${accountId}/usage-groups`)
    if (request === groupRequest && open.value) groups.value = loaded
  } catch (value: unknown) { if (request === groupRequest && open.value) formError.value = value instanceof Error && value.message ? value.message : '加载员工组织失败' }
}
async function loadEmployeeProjects(accountId: string, regionId: string) {
  form.projectId = ''; projects.value = []
  if (!accountId || !regionId) return
  try {
    const path = managed.value ? `/api/v1/admin/users/${accountId}/projects` : '/api/v1/me/projects'
    projects.value = await api<Project[]>(`${path}?regionId=${encodeURIComponent(regionId)}`)
  } catch { projects.value = [] }
}
function edit(key: Key | null = null) {
  editing.value = key; detail.value = null; formError.value = ''; secret.value = ''
  form.accountId = key?.accountId || props.accountId || ''; selectedPerson.value = key?.account || null; form.name = key?.name || ''; form.groupId = key?.groupId || ''; form.projectId = key?.projectId || ''
  form.expiresAt = key?.expiresAt ? new Date(new Date(key.expiresAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
  open.value = true
  if (managed.value && !key) void loadEmployeeGroups(form.accountId)
}
function closeForm() { if (!pending.value) { groupRequest++; open.value = false; formError.value = ''; secret.value = '' } }
function applyFilters() { offset.value = 0; detail.value = null; void load() }
function openDetail(key: Key) {
  detail.value = key
  revealPassword.value = ''; revealedOwnSecret.value = ''; revealError.value = ''
  copyState.value = ''
}
function closeDetail() {
  detail.value = null
  revealPassword.value = ''; revealedOwnSecret.value = ''; revealError.value = ''
  copyState.value = ''
}
async function revealOwn() {
  if (!detail.value || revealingOwn.value || !revealPassword.value) return
  revealingOwn.value = true; revealError.value = ''
  try {
    const revealPath = selfMode.value
      ? `/api/v1/me/api-keys/${detail.value.id}/reveal`
      : `/api/v1/admin/employee-api-keys/${detail.value.id}/reveal`
    const result = await api<{ id: string; secret: string }>(revealPath, {
      method: 'POST', body: JSON.stringify({ password: revealPassword.value })
    })
    revealedOwnSecret.value = result.secret; revealPassword.value = ''
  } catch (value: any) { revealError.value = value.message }
  finally { revealingOwn.value = false }
}
function selectEmployee() { selectedPerson.value = people.value.items.find(person => person.id === form.accountId) || selectedPerson.value; formError.value = ''; void loadEmployeeGroups(form.accountId) }
function selectGroup() {
  if (form.groupId) void loadEmployeeProjects(form.accountId || props.accountId || '', form.groupId)
  else { projects.value = []; form.projectId = '' }
}
async function save() {
  const accountId = managed.value ? form.accountId : props.accountId
  if (pending.value || !adminMode.value || !accountId || !form.name.trim() || !form.groupId || !form.projectId) return
  const current = viewGeneration; pending.value = true; formError.value = ''
  try {
    const body = { name: form.name.trim(), ...(!editing.value ? { projectId: form.projectId || null } : {}), expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null }
    const result = await api<{ secret?: string }>(editing.value ? `/api/v1/admin/employee-api-keys/${editing.value.id}` : `/api/v1/admin/users/${accountId}/api-keys`, { method: editing.value ? 'PATCH' : 'POST', body: JSON.stringify(body) })
    if (current !== viewGeneration) return
    open.value = false; secret.value = result.secret || ''; toast('Key 已保存'); await load()
  } catch (value: unknown) { if (current === viewGeneration) formError.value = value instanceof Error && value.message ? value.message : '保存 Key 失败' }
  finally { if (current === viewGeneration) pending.value = false }
}
async function confirm() {
  if (!action.value || pending.value) return
  const current = viewGeneration; const { key, verb } = action.value; pending.value = true; error.value = ''
  try {
    const base = adminMode.value ? '/api/v1/admin/employee-api-keys' : '/api/v1/me/api-keys'
    await api(`${base}/${key.id}${verb === 'delete' ? '' : `/${verb}`}`, { method: verb === 'delete' ? 'DELETE' : 'POST' })
    if (current !== viewGeneration) return
    action.value = null; detail.value = null; toast('Key 状态已更新'); await load()
  } catch (value: unknown) { if (current === viewGeneration) { error.value = value instanceof Error && value.message ? value.message : '更新 Key 失败'; action.value = null } }
  finally { if (current === viewGeneration) pending.value = false }
}
async function copySecret() {
  const value = secret.value || revealedOwnSecret.value
  try { await navigator.clipboard.writeText(value); copyState.value = '已复制'; toast('Key 已复制，请安全保管') }
  catch { copyState.value = '复制失败'; formError.value = '复制失败，请手动复制' }
}
function keyLogs(key: Key) { return `/usage?${new URLSearchParams({ accountId: key.accountId || props.accountId || '', organizationId: key.organizationId || '', apiKeyId: key.id })}` }
watch(() => [props.managed, props.accountId], () => { resetView(); offset.value = 0; void load() }, { immediate: true })
watch(() => filters.accountId, () => { if (managed.value) { filters.groupId = ''; applyFilters() } })
onUnmounted(() => { viewGeneration++; lifecycle.dispose(); secret.value = ''; groupRequest++ })
</script>

<template>
  <section class="panel table-panel">
    <div class="section-header"><div><h2>{{ managed ? '组织 API Key' : '员工 API Key' }}</h2><p class="muted">每个 Key 固定归属一个员工和项目；撤销不可恢复。轮换时先创建新 Key，再撤销旧 Key。</p></div><div class="actions"><button :disabled="loading || pending" @click="load">刷新 Key</button><button v-if="adminMode" data-action="create-key" :disabled="loading || pending" @click="edit()">创建 Key</button></div></div>
    <form class="toolbar" @submit.prevent="applyFilters"><input v-model="filters.q" aria-label="搜索 Key" placeholder="搜索 Key 或尾号" @change="applyFilters"><select v-if="managed" v-model="filters.accountId" aria-label="筛选员工"><option value="">全部员工</option><option v-for="person in people.items" :key="person.id" :value="person.id">{{ person.displayName }} · {{ person.email }}</option></select><select v-model="filters.groupId" aria-label="筛选组织" @change="applyFilters"><option value="">全部组织</option><option v-for="group in filterGroups" :key="group.id" :value="group.id">{{ group.name }}</option></select><select v-model="filters.projectId" aria-label="筛选项目" @change="applyFilters"><option value="">全部项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select><select v-model="filters.status" aria-label="Key 状态" @change="applyFilters"><option value="">全部状态</option><option value="active">可用</option><option value="disabled">已停用</option><option value="expired">已过期</option><option value="revoked">已撤销</option></select><button type="submit">搜索</button></form>
    <div v-if="managed && !open" class="actions option-pages"><label>员工选项<input v-model="optionSearch.people" aria-label="搜索员工选项" @change="optionSearch.peopleOffset = 0; load()"></label><button :disabled="optionSearch.peopleOffset === 0" @click="optionSearch.peopleOffset -= 20; load()">上一页</button><button :disabled="optionSearch.peopleOffset + 20 >= people.total" @click="optionSearch.peopleOffset += 20; load()">下一页</button><label>组织选项<input v-model="optionSearch.groups" aria-label="搜索组织选项" @change="optionSearch.groupsOffset = 0; load()"></label><button :disabled="optionSearch.groupsOffset === 0" @click="optionSearch.groupsOffset -= 20; load()">上一页</button><button :disabled="optionSearch.groupsOffset + 20 >= groupOptions.total" @click="optionSearch.groupsOffset += 20; load()">下一页</button></div>
    <p v-if="!managed && !loading && !groups.length" class="state">暂无可用组织；请联系管理员添加成员。</p><p v-else-if="!managed" class="muted">所属组织：{{ groups.map(group => group.name).join('、') }}</p>
    <p v-if="error" role="alert" class="state error">{{ error }} <button @click="load">重试</button></p><p v-else-if="loading" class="state">正在加载 Key…</p>
    <table v-else-if="rows.items.length"><thead><tr><th>名称 / 尾号</th><th v-if="managed">员工</th><th>归属组织 / 项目</th><th>累计用量</th><th>预算占比</th><th>状态</th><th>创建 / 到期 / 最后使用</th><th>操作</th></tr></thead><tbody><tr v-for="key in rows.items" :key="key.id" :data-key-row="key.id"><td>{{ key.name }}<small class="mono">{{ key.secretHint }}</small></td><td v-if="managed">{{ key.account?.displayName || key.accountId || '—' }}<small>{{ key.account?.email }}</small></td><td>{{ key.group?.name || groups.find(group => group.id === key.groupId)?.name || key.groupId }}<small v-if="key.project"> · {{ key.project.name }}</small></td><td>{{ key.usage?.requests ?? 0 }} / {{ key.usage?.totalTokens ?? 0 }}<small>{{ formatCny(key.usage?.costCny || '0') }}</small></td><td>{{ key.budget?.keyCostSharePercent == null ? '—' : `${key.budget.keyCostSharePercent}%` }}<small v-if="key.budget?.projectUsageSharePercent != null">项目用量 {{ key.budget.projectUsageSharePercent }}%</small></td><td>{{ status(key) }}</td><td>{{ date(key.createdAt) }}<small>{{ key.expiresAt ? `到期：${date(key.expiresAt)}` : '不设到期时间' }}</small><small>最后使用：{{ date(key.lastUsedAt) }}</small></td><td class="actions"><button data-action="key-details" @click="openDetail(key)">详情</button><template v-if="adminMode && !key.revokedAt"><button :disabled="pending" @click="edit(key)">编辑</button><button :disabled="pending" @click="action = { key, verb: key.disabledAt ? 'enable' : 'disable' }">{{ key.disabledAt ? '启用' : '停用' }}</button></template><button v-if="!key.revokedAt" data-action="revoke-key" :disabled="pending" @click="action = { key, verb: 'revoke' }">撤销</button><button v-if="adminMode" :disabled="pending" @click="action = { key, verb: 'delete' }">删除</button></td></tr></tbody></table><p v-else class="empty">暂无 API Key。{{ adminMode ? '管理员可创建 Key；已有 Key 可按平台接入说明配置客户端。' : '请联系管理员签发；已有 Key 可按平台接入说明配置客户端。' }}</p>
    <Pagination :total="rows.total" :offset="offset" :limit="20" @change="offset = $event; load()" />
  </section>
  <Drawer :open="open" :title="editing ? '编辑 API Key' : '创建 API Key'" :close-disabled="pending" @close="closeForm"><form id="employee-key-form" class="stack-form" @submit.prevent="save"><template v-if="managed && !editing"><label>搜索员工<input v-model="optionSearch.people" aria-label="创建 Key 搜索员工" @change="optionSearch.peopleOffset = 0; load()"></label><div class="actions"><button type="button" :disabled="optionSearch.peopleOffset === 0" @click="optionSearch.peopleOffset -= 20; load()">上一页</button><button type="button" :disabled="optionSearch.peopleOffset + 20 >= people.total" @click="optionSearch.peopleOffset += 20; load()">下一页</button></div><label>员工<select v-model="form.accountId" aria-label="Key 员工" required @change="selectEmployee"><option value="">请选择员工</option><option v-for="person in formPeople" :key="person.id" :value="person.id">{{ person.displayName }} · {{ person.email }}</option></select></label></template><label>名称<input v-model="form.name" aria-label="Key 名称" maxlength="120" required></label><label>所属组<select v-model="form.groupId" aria-label="Key 所属组织" :disabled="Boolean(editing) || (managed && !form.accountId)" required @change="selectGroup"><option value="">请选择员工所属组织</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option><option v-if="editing && !groups.some(group => group.id === editing?.groupId)" :value="editing.groupId">{{ editing.group?.name || editing.groupId }}</option></select></label><label>项目<select v-model="form.projectId" aria-label="项目" :disabled="Boolean(editing) || !projects.length" required><option value="">请选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label>到期时间（留空不设到期）<input v-model="form.expiresAt" type="datetime-local"></label><p v-if="formError" class="state error" role="alert">{{ formError }}</p></form><template #footer><button :disabled="pending" @click="closeForm">取消</button><button form="employee-key-form" type="submit" data-action="save-key" :disabled="pending || !form.name.trim() || !form.groupId || !form.projectId || (managed && !form.accountId)">保存</button></template></Drawer>
  <Drawer :open="Boolean(detail)" title="API Key 详情" @close="closeDetail"><template v-if="detail"><p>名称：{{ detail.name }}</p><p>尾号：<span class="mono">{{ detail.secretHint }}</span></p><p>员工：{{ detail.account?.displayName || detail.accountId || '—' }} {{ detail.account?.email }}</p><p>组织：{{ detail.group?.name || detail.groupId }}</p><p v-if="detail.project">项目：{{ detail.project.name }}</p><p>创建人：{{ detail.createdBy?.displayName || '—' }}</p><p>创建时间：{{ date(detail.createdAt) }}</p><p>到期时间：{{ detail.expiresAt ? date(detail.expiresAt) : '不设到期时间' }}</p><p>最后使用：{{ date(detail.lastUsedAt) }}</p><p>状态：{{ status(detail) }}</p><a data-action="key-logs" :href="keyLogs(detail)">查看该 Key 使用日志</a><template v-if="selfMode || adminMode"><form v-if="!revealedOwnSecret" class="stack-form" @submit.prevent="revealOwn"><label>{{ selfMode ? '当前登录密码' : '管理员密码' }}<input v-model="revealPassword" type="password" :aria-label="selfMode ? '当前登录密码' : '管理员密码'" autocomplete="current-password" required :disabled="revealingOwn || !detail.secretRecoverable"></label><button type="button" data-action="reveal-own-key" :disabled="revealingOwn || !revealPassword || !detail.secretRecoverable" @click="revealOwn">{{ revealingOwn ? '验证中…' : '验证并显示 Key' }}</button><p v-if="!detail.secretRecoverable" class="muted">此 Key 创建于支持明文查看之前，系统未保存可恢复密文；请签发替代 Key。</p></form><p v-if="revealError" class="state error">{{ revealError }}</p><template v-else-if="revealedOwnSecret"><p>完整 Key：<code data-own-secret class="mono">{{ revealedOwnSecret }}</code></p><div class="actions"><button @click="copySecret">复制 Key</button><span v-if="copyState">{{ copyState }}</span></div><p class="muted">关闭详情后明文不会保留。</p></template></template></template></Drawer>
  <Drawer :open="Boolean(secret)" title="请立即保存 Key" description="明文仅显示这一次；关闭或离开页面后无法再次查看。" @close="secret = ''; formError = ''"><textarea aria-label="完整 API Key" readonly :value="secret" spellcheck="false" /><p v-if="formError" class="state error">{{ formError }}</p><template #footer><button @click="copySecret">复制 Key</button><button data-action="close-secret" @click="secret = ''; formError = ''">已保存，关闭</button></template></Drawer>
  <ConfirmDialog :open="Boolean(action)" title="确认变更 Key" :message="action?.verb === 'delete' ? '撤销并从列表移除，历史记录保留。确认继续？' : action?.verb === 'revoke' ? '此 Key 将永久失效，历史使用记录保留。确认继续？' : '该操作将改变 Key 的可用状态，确认继续？'" danger :close-disabled="pending" @cancel="action = null" @confirm="confirm" />
</template>
