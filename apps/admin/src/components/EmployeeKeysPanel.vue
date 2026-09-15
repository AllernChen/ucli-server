<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { api } from '../api'
import { createRequestLifecycle, type Page } from '../device-grants'
import { toast } from '../toast'
import Drawer from './Drawer.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import Pagination from './Pagination.vue'

const props = defineProps<{ accountId?: string }>()
type Key = { id: string; name: string; groupId: string; secretHint: string; expiresAt: string | null; disabledAt: string | null; revokedAt: string | null; lastUsedAt: string | null }
const rows = ref<Page<Key>>({ items: [], total: 0, offset: 0, limit: 20 })
const groups = ref<Array<{ id: string; name: string }>>([])
const offset = ref(0), loading = ref(false), pending = ref(false), error = ref(''), formError = ref('')
const open = ref(false), editing = ref<Key | null>(null), secret = ref('')
const form = reactive({ name: '', groupId: '', expiresAt: '' })
const action = ref<{ key: Key; verb: 'revoke' | 'delete' | 'enable' | 'disable' } | null>(null)
const prefix = computed(() => props.accountId ? `/api/v1/admin/users/${props.accountId}` : '/api/v1/me')
const lifecycle = createRequestLifecycle()
let generation = 0
const date = (value: string | null) => value ? new Date(value).toLocaleString() : '—'
function status(key: Key) { return key.revokedAt ? '已撤销' : key.disabledAt ? '已停用' : key.expiresAt && new Date(key.expiresAt) <= new Date() ? '已过期' : '可用' }
async function load() {
  const request = lifecycle.next(); loading.value = true; error.value = ''
  try {
    const [keys, memberships] = await Promise.all([api<Page<Key>>(`${prefix.value}/api-keys?offset=${offset.value}&limit=20`), api<Array<{ id: string; name: string }>>(`${prefix.value}/usage-groups`)])
    if (lifecycle.isCurrent(request)) { rows.value = keys; groups.value = memberships }
  } catch (e: any) { if (lifecycle.isCurrent(request)) error.value = e.message }
  finally { if (lifecycle.isCurrent(request)) loading.value = false }
}
function edit(key: Key | null = null) {
  editing.value = key; form.name = key?.name || ''; form.groupId = key?.groupId || ''; form.expiresAt = key?.expiresAt ? new Date(new Date(key.expiresAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
  formError.value = ''; secret.value = ''; open.value = true
}
async function save() {
  if (pending.value || !props.accountId || !form.name.trim() || !form.groupId) return
  const current = generation; pending.value = true; formError.value = ''
  try {
    const body = { name: form.name.trim(), ...(!editing.value ? { groupId: form.groupId } : {}), expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null }
    const result = await api(editing.value ? `/api/v1/admin/employee-api-keys/${editing.value.id}` : `${prefix.value}/api-keys`, { method: editing.value ? 'PATCH' : 'POST', body: JSON.stringify(body) })
    if (current !== generation) return
    open.value = false; secret.value = result.secret || ''; toast('Key 已保存'); await load()
  } catch (e: any) { if (current === generation) formError.value = e.message }
  finally { if (current === generation) pending.value = false }
}
async function confirm() {
  if (!action.value || pending.value) return
  const current = generation; const { key, verb } = action.value; pending.value = true; error.value = ''
  try {
    const base = props.accountId ? '/api/v1/admin/employee-api-keys' : '/api/v1/me/api-keys'
    await api(`${base}/${key.id}${verb === 'delete' ? '' : `/${verb}`}`, { method: verb === 'delete' ? 'DELETE' : 'POST' })
    if (current !== generation) return
    action.value = null; toast('Key 状态已更新'); await load()
  } catch (e: any) { if (current === generation) { error.value = e.message; action.value = null } }
  finally { if (current === generation) pending.value = false }
}
async function copySecret() {
  try { await navigator.clipboard.writeText(secret.value); toast('Key 已复制，请安全保管') }
  catch { formError.value = '复制失败，请手动复制' }
}
watch(() => props.accountId, () => {
  generation++; open.value = false; secret.value = ''; pending.value = false; action.value = null; offset.value = 0
  rows.value = { items: [], total: 0, offset: 0, limit: 20 }; groups.value = []; load()
}, { immediate: true })
onUnmounted(() => { generation++; lifecycle.dispose(); secret.value = '' })
</script>

<template>
  <section class="panel table-panel">
    <div class="section-header"><div><h2>员工 API Key</h2><p class="muted">每个 Key 固定归属一个员工和用量组；撤销不可恢复。轮换时先创建新 Key，再撤销旧 Key。</p></div><div class="actions"><button :disabled="loading || pending" @click="load">刷新 Key</button><button v-if="accountId" data-action="create-key" :disabled="loading || pending || !groups.length" @click="edit()">创建 Key</button></div></div>
    <p v-if="!loading && !groups.length" class="state">暂无可用用量组；请联系管理员添加成员。</p>
    <p v-else class="muted">所属组：{{ groups.map(g => g.name).join('、') }}</p>
    <p v-if="error" role="alert" class="state error">{{ error }}</p><p v-if="loading" class="state">正在加载 Key…</p>
    <table v-else-if="rows.items.length"><thead><tr><th>名称 / 尾号</th><th>归属组</th><th>状态</th><th>到期 / 最后使用</th><th>操作</th></tr></thead><tbody>
      <tr v-for="key in rows.items" :key="key.id"><td>{{ key.name }}<small class="mono">{{ key.secretHint }}</small></td><td>{{ groups.find(g => g.id === key.groupId)?.name || key.groupId }}</td><td>{{ status(key) }}</td><td>{{ key.expiresAt ? date(key.expiresAt) : '不设到期时间' }}<small>{{ date(key.lastUsedAt) }}</small></td><td class="actions">
        <template v-if="accountId && !key.revokedAt"><button :disabled="pending" @click="edit(key)">编辑</button><button :disabled="pending" @click="action = { key, verb: key.disabledAt ? 'enable' : 'disable' }">{{ key.disabledAt ? '启用' : '停用' }}</button></template>
        <button v-if="!key.revokedAt" data-action="revoke-key" :disabled="pending" @click="action = { key, verb: 'revoke' }">撤销</button><button v-if="accountId" :disabled="pending" @click="action = { key, verb: 'delete' }">删除</button>
      </td></tr></tbody></table><p v-else class="empty">暂无 API Key</p>
    <Pagination :total="rows.total" :offset="offset" :limit="20" @change="offset = $event; load()" />
  </section>
  <Drawer :open="open" :title="editing ? '编辑 API Key' : '创建 API Key'" :close-disabled="pending" @close="open = false">
    <form id="employee-key-form" class="stack-form" @submit.prevent="save"><label>名称<input v-model="form.name" aria-label="Key 名称" maxlength="120" required></label><label>所属组<select v-model="form.groupId" aria-label="Key 所属组" :disabled="Boolean(editing)" required><option value="">请选择员工所属组</option><option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option><option v-if="editing && !groups.some(g => g.id === editing?.groupId)" :value="editing.groupId">{{ editing.groupId }}</option></select></label><label>到期时间（留空不设到期）<input v-model="form.expiresAt" type="datetime-local"></label><p v-if="formError" class="state error" role="alert">{{ formError }}</p></form>
    <template #footer><button :disabled="pending" @click="open = false">取消</button><button form="employee-key-form" type="submit" data-action="save-key" :disabled="pending || !form.name.trim() || !form.groupId">保存</button></template>
  </Drawer>
  <Drawer :open="Boolean(secret)" title="请立即保存 Key" description="明文仅显示这一次；关闭或离开页面后无法再次查看。" @close="secret = ''; formError = ''"><textarea aria-label="完整 API Key" readonly :value="secret" spellcheck="false" /><p v-if="formError" class="state error">{{ formError }}</p><template #footer><button @click="copySecret">复制 Key</button><button data-action="close-secret" @click="secret = ''; formError = ''">已保存，关闭</button></template></Drawer>
  <ConfirmDialog :open="Boolean(action)" title="确认变更 Key" :message="action?.verb === 'revoke' || action?.verb === 'delete' ? '此 Key 将永久失效，历史使用记录保留。确认继续？' : '该操作将改变 Key 的可用状态，确认继续？'" danger :close-disabled="pending" @cancel="action = null" @confirm="confirm" />
</template>
