<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import { toast } from '../toast'
import Drawer from './Drawer.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import Pagination from './Pagination.vue'

const props = withDefaults(defineProps<{ managed?: boolean; accountId?: string }>(), { managed: false })
type Group = { id: string; name: string }
type Person = { id: string; displayName: string; email: string }
type Key = { id: string; name: string; groupId: string; accountId?: string; organizationId?: string; secretHint: string; expiresAt: string | null; disabledAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdAt?: string; account?: Person; group?: Group; createdBy?: { id: string; displayName: string } }
type KeyPage = Page<Key> & { filterGroups?: Group[] }
const rows = ref<KeyPage>({ items: [], total: 0, offset: 0, limit: 20 })
const groups = ref<Group[]>([]), people = ref<Page<Person>>({ items: [], total: 0, offset: 0, limit: 20 }), groupOptions = ref<Page<Group>>({ items: [], total: 0, offset: 0, limit: 20 })
const pageFilterGroups = ref<Group[]>([])
const offset = ref(0), loading = ref(false), pending = ref(false), error = ref(''), formError = ref('')
const open = ref(false), editing = ref<Key | null>(null), detail = ref<Key | null>(null), secret = ref('')
const selectedPerson = ref<Person | null>(null)
const filters = reactive({ q: '', accountId: '', groupId: '', status: '' })
const form = reactive({ accountId: '', name: '', groupId: '', expiresAt: '' })
const optionSearch = reactive({ people: '', groups: '', peopleOffset: 0, groupsOffset: 0 })
const action = ref<{ key: Key; verb: 'revoke' | 'delete' | 'enable' | 'disable' } | null>(null)
const managed = computed(() => props.managed)
const adminMode = computed(() => managed.value || Boolean(props.accountId))
const filterGroups = computed(() => Array.from(new Map([...groups.value, ...pageFilterGroups.value, ...groupOptions.value.items, ...rows.value.items.flatMap(key => key.group ? [key.group] : [])].map(group => [group.id, group])).values()))
const formPeople = computed(() => selectedPerson.value && !people.value.items.some(person => person.id === selectedPerson.value?.id) ? [selectedPerson.value, ...people.value.items] : people.value.items)
const listPath = computed(() => managed.value ? '/api/v1/admin/employee-api-keys' : props.accountId ? `/api/v1/admin/users/${props.accountId}/api-keys` : '/api/v1/me/api-keys')
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
  Object.assign(filters, { q: '', accountId: '', groupId: '', status: '' }); Object.assign(form, { accountId: '', name: '', groupId: '', expiresAt: '' })
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
  } catch (value: unknown) { if (request === groupRequest && open.value) formError.value = value instanceof Error && value.message ? value.message : '加载员工用量组失败' }
}
function edit(key: Key | null = null) {
  editing.value = key; detail.value = null; formError.value = ''; secret.value = ''
  form.accountId = key?.accountId || props.accountId || ''; selectedPerson.value = key?.account || null; form.name = key?.name || ''; form.groupId = key?.groupId || ''
  form.expiresAt = key?.expiresAt ? new Date(new Date(key.expiresAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
  open.value = true
  if (managed.value && !key) void loadEmployeeGroups(form.accountId)
}
function closeForm() { if (!pending.value) { groupRequest++; open.value = false; formError.value = ''; secret.value = '' } }
function applyFilters() { offset.value = 0; detail.value = null; void load() }
function selectEmployee() { selectedPerson.value = people.value.items.find(person => person.id === form.accountId) || selectedPerson.value; formError.value = ''; void loadEmployeeGroups(form.accountId) }
async function save() {
  const accountId = managed.value ? form.accountId : props.accountId
  if (pending.value || !adminMode.value || !accountId || !form.name.trim() || !form.groupId) return
  const current = viewGeneration; pending.value = true; formError.value = ''
  try {
    const body = { name: form.name.trim(), ...(!editing.value ? { groupId: form.groupId } : {}), expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null }
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
async function copySecret() { try { await navigator.clipboard.writeText(secret.value); toast('Key 已复制，请安全保管') } catch { formError.value = '复制失败，请手动复制' } }
function keyLogs(key: Key) { return `/usage?${new URLSearchParams({ accountId: key.accountId || props.accountId || '', organizationId: key.organizationId || '', apiKeyId: key.id })}` }
watch(() => [props.managed, props.accountId], () => { resetView(); offset.value = 0; void load() }, { immediate: true })
watch(() => filters.accountId, () => { if (managed.value) { filters.groupId = ''; applyFilters() } })
onUnmounted(() => { viewGeneration++; lifecycle.dispose(); secret.value = ''; groupRequest++ })
</script>

<template>
  <section class="panel table-panel">
    <div class="section-header"><div><h2>{{ managed ? '组织 API Key' : '员工 API Key' }}</h2><p class="muted">每个 Key 固定归属一个员工和用量组；撤销不可恢复。轮换时先创建新 Key，再撤销旧 Key。</p></div><div class="actions"><button :disabled="loading || pending" @click="load">刷新 Key</button><button v-if="adminMode" data-action="create-key" :disabled="loading || pending" @click="edit()">创建 Key</button></div></div>
    <form class="toolbar" @submit.prevent="applyFilters"><input v-model="filters.q" aria-label="搜索 Key" placeholder="搜索 Key 或尾号" @change="applyFilters"><select v-if="managed" v-model="filters.accountId" aria-label="筛选员工"><option value="">全部员工</option><option v-for="person in people.items" :key="person.id" :value="person.id">{{ person.displayName }} · {{ person.email }}</option></select><select v-model="filters.groupId" aria-label="筛选用量组" @change="applyFilters"><option value="">全部用量组</option><option v-for="group in filterGroups" :key="group.id" :value="group.id">{{ group.name }}</option></select><select v-model="filters.status" aria-label="Key 状态" @change="applyFilters"><option value="">全部状态</option><option value="active">可用</option><option value="disabled">已停用</option><option value="expired">已过期</option><option value="revoked">已撤销</option></select><button type="submit">搜索</button></form>
    <div v-if="managed && !open" class="actions option-pages"><label>员工选项<input v-model="optionSearch.people" aria-label="搜索员工选项" @change="optionSearch.peopleOffset = 0; load()"></label><button :disabled="optionSearch.peopleOffset === 0" @click="optionSearch.peopleOffset -= 20; load()">上一页</button><button :disabled="optionSearch.peopleOffset + 20 >= people.total" @click="optionSearch.peopleOffset += 20; load()">下一页</button><label>用量组选项<input v-model="optionSearch.groups" aria-label="搜索用量组选项" @change="optionSearch.groupsOffset = 0; load()"></label><button :disabled="optionSearch.groupsOffset === 0" @click="optionSearch.groupsOffset -= 20; load()">上一页</button><button :disabled="optionSearch.groupsOffset + 20 >= groupOptions.total" @click="optionSearch.groupsOffset += 20; load()">下一页</button></div>
    <p v-if="!managed && !loading && !groups.length" class="state">暂无可用用量组；请联系管理员添加成员。</p><p v-else-if="!managed" class="muted">所属组：{{ groups.map(group => group.name).join('、') }}</p>
    <p v-if="error" role="alert" class="state error">{{ error }} <button @click="load">重试</button></p><p v-else-if="loading" class="state">正在加载 Key…</p>
    <table v-else-if="rows.items.length"><thead><tr><th>名称 / 尾号</th><th v-if="managed">员工</th><th>归属组</th><th>状态</th><th>创建 / 到期 / 最后使用</th><th>操作</th></tr></thead><tbody><tr v-for="key in rows.items" :key="key.id" :data-key-row="key.id"><td>{{ key.name }}<small class="mono">{{ key.secretHint }}</small></td><td v-if="managed">{{ key.account?.displayName || key.accountId || '—' }}<small>{{ key.account?.email }}</small></td><td>{{ key.group?.name || groups.find(group => group.id === key.groupId)?.name || key.groupId }}</td><td>{{ status(key) }}</td><td>{{ date(key.createdAt) }}<small>{{ key.expiresAt ? `到期：${date(key.expiresAt)}` : '不设到期时间' }}</small><small>最后使用：{{ date(key.lastUsedAt) }}</small></td><td class="actions"><button data-action="key-details" @click="detail = key">详情</button><template v-if="adminMode && !key.revokedAt"><button :disabled="pending" @click="edit(key)">编辑</button><button :disabled="pending" @click="action = { key, verb: key.disabledAt ? 'enable' : 'disable' }">{{ key.disabledAt ? '启用' : '停用' }}</button></template><button v-if="!key.revokedAt" data-action="revoke-key" :disabled="pending" @click="action = { key, verb: 'revoke' }">撤销</button><button v-if="adminMode" :disabled="pending" @click="action = { key, verb: 'delete' }">删除</button></td></tr></tbody></table><p v-else class="empty">暂无 API Key。{{ adminMode ? '管理员可创建 Key；已有 Key 可按平台接入说明配置客户端。' : '请联系管理员签发；已有 Key 可按平台接入说明配置客户端。' }}</p>
    <Pagination :total="rows.total" :offset="offset" :limit="20" @change="offset = $event; load()" />
  </section>
  <Drawer :open="open" :title="editing ? '编辑 API Key' : '创建 API Key'" :close-disabled="pending" @close="closeForm"><form id="employee-key-form" class="stack-form" @submit.prevent="save"><template v-if="managed && !editing"><label>搜索员工<input v-model="optionSearch.people" aria-label="创建 Key 搜索员工" @change="optionSearch.peopleOffset = 0; load()"></label><div class="actions"><button type="button" :disabled="optionSearch.peopleOffset === 0" @click="optionSearch.peopleOffset -= 20; load()">上一页</button><button type="button" :disabled="optionSearch.peopleOffset + 20 >= people.total" @click="optionSearch.peopleOffset += 20; load()">下一页</button></div><label>员工<select v-model="form.accountId" aria-label="Key 员工" required @change="selectEmployee"><option value="">请选择员工</option><option v-for="person in formPeople" :key="person.id" :value="person.id">{{ person.displayName }} · {{ person.email }}</option></select></label></template><label>名称<input v-model="form.name" aria-label="Key 名称" maxlength="120" required></label><label>所属组<select v-model="form.groupId" aria-label="Key 所属组" :disabled="Boolean(editing) || (managed && !form.accountId)" required><option value="">请选择员工所属组</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option><option v-if="editing && !groups.some(group => group.id === editing?.groupId)" :value="editing.groupId">{{ editing.group?.name || editing.groupId }}</option></select></label><label>到期时间（留空不设到期）<input v-model="form.expiresAt" type="datetime-local"></label><p v-if="formError" class="state error" role="alert">{{ formError }}</p></form><template #footer><button :disabled="pending" @click="closeForm">取消</button><button form="employee-key-form" type="submit" data-action="save-key" :disabled="pending || !form.name.trim() || !form.groupId || (managed && !form.accountId)">保存</button></template></Drawer>
  <Drawer :open="Boolean(detail)" title="API Key 详情" @close="detail = null"><template v-if="detail"><p>名称：{{ detail.name }}</p><p>尾号：<span class="mono">{{ detail.secretHint }}</span></p><p>员工：{{ detail.account?.displayName || detail.accountId || '—' }} {{ detail.account?.email }}</p><p>用量组：{{ detail.group?.name || detail.groupId }}</p><p>创建人：{{ detail.createdBy?.displayName || '—' }}</p><p>创建时间：{{ date(detail.createdAt) }}</p><p>到期时间：{{ detail.expiresAt ? date(detail.expiresAt) : '不设到期时间' }}</p><p>最后使用：{{ date(detail.lastUsedAt) }}</p><p>状态：{{ status(detail) }}</p><a data-action="key-logs" :href="keyLogs(detail)">查看该 Key 使用日志</a></template></Drawer>
  <Drawer :open="Boolean(secret)" title="请立即保存 Key" description="明文仅显示这一次；关闭或离开页面后无法再次查看。" @close="secret = ''; formError = ''"><textarea aria-label="完整 API Key" readonly :value="secret" spellcheck="false" /><p v-if="formError" class="state error">{{ formError }}</p><template #footer><button @click="copySecret">复制 Key</button><button data-action="close-secret" @click="secret = ''; formError = ''">已保存，关闭</button></template></Drawer>
  <ConfirmDialog :open="Boolean(action)" title="确认变更 Key" :message="action?.verb === 'delete' ? '撤销并从列表移除，历史记录保留。确认继续？' : action?.verb === 'revoke' ? '此 Key 将永久失效，历史使用记录保留。确认继续？' : '该操作将改变 Key 的可用状态，确认继续？'" danger :close-disabled="pending" @cancel="action = null" @confirm="confirm" />
</template>
