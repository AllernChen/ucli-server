<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { api } from '../api'
import Drawer from './Drawer.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import Pagination from './Pagination.vue'
const props = defineProps<{ organizationId?: string }>()
const emit = defineEmits<{ changed: [] }>()
const status = ref<{ total: number; requireDeviceGroup: boolean; items: Array<{ id: string; accountId: string; deviceId: string | null; account: { displayName: string }; device?: { name: string } | null }> } | null>(null)
const offset = ref(0), error = ref(''), pending = ref(false), confirm = ref(false)
const selected = ref<{ id: string; accountId: string } | null>(null), groupId = ref('')
const groups = ref<Array<{ id: string; name: string }>>([])
const base = computed(() => props.organizationId ? `/api/v1/admin/organizations/${props.organizationId}` : '/api/v1/admin/device-grants')
let generation = 0, request = 0
async function load() {
  const current = ++request; error.value = ''
  try { const result = await api(`${base.value}/${props.organizationId ? 'device-group-migration' : 'ungrouped'}?offset=${offset.value}&limit=20`); if (current === request) status.value = result }
  catch (e: any) { if (current === request) error.value = e.message }
}
async function choose(item: { id: string; accountId: string }) {
  if (pending.value) return
  const current = generation; pending.value = true; error.value = ''; groups.value = []; groupId.value = ''; selected.value = item
  try { const result = await api(`/api/v1/admin/users/${item.accountId}/usage-groups`); if (current === generation) groups.value = result }
  catch (e: any) { if (current === generation) error.value = e.message }
  finally { if (current === generation) pending.value = false }
}
async function save(assignment = false) {
  if (pending.value || !status.value || (assignment && (!selected.value || !groupId.value))) return
  const current = generation; pending.value = true; error.value = ''
  try {
    await api(assignment ? `/api/v1/admin/device-grants/${selected.value!.id}/group` : `${base.value}/${props.organizationId ? 'device-group-requirement' : 'group-requirement'}`, { method: 'PATCH', body: JSON.stringify(assignment ? { accountId: selected.value!.accountId, groupId: groupId.value } : { required: !status.value.requireDeviceGroup }) })
    if (current !== generation) return
    selected.value = null; confirm.value = false; emit('changed'); await load()
  } catch (e: any) { if (current === generation) { error.value = e.message; confirm.value = false } }
  finally { if (current === generation) pending.value = false }
}
watch(() => props.organizationId, () => { generation++; request++; selected.value = null; status.value = null; offset.value = 0; pending.value = false; load() }, { immediate: true })
onUnmounted(() => { generation++; request++ })
defineExpose({ choose })
</script>
<template>
  <section class="panel"><div class="section-header"><div><h2>设备归组迁移</h2><p>有效授权包含已绑定与待绑定授权；归组不重新签发 Token，已归组授权不可改组。</p></div><button :disabled="pending" @click="load">刷新迁移状态</button></div>
    <p v-if="error" class="state error" role="alert">{{ error }}</p>
    <template v-if="status"><p>未归组有效授权：{{ status.total }} · 强制归组：{{ status.requireDeviceGroup ? '已开启' : '未开启' }}</p><button data-action="group-requirement" :disabled="pending || (!status.requireDeviceGroup && status.total > 0)" @click="confirm = true">{{ status.requireDeviceGroup ? '关闭强制归组' : '开启强制归组' }}</button><p class="muted">开启前必须归组或撤销全部有效授权。关闭强制模式不会取消已经归组设备的组权限与预算。</p>
      <table v-if="status.items.length"><thead><tr><th>员工</th><th>设备</th><th>授权</th><th v-if="!organizationId">操作</th></tr></thead><tbody><tr v-for="item in status.items" :key="item.id"><td>{{ item.account.displayName }}</td><td>{{ item.device?.name || '待绑定' }}</td><td class="mono">{{ item.id }}</td><td v-if="!organizationId"><button :disabled="pending" @click="choose(item)">首次归组</button></td></tr></tbody></table><Pagination :total="status.total" :offset="offset" :limit="20" @change="offset = $event; load()" />
    </template>
    <Drawer :open="Boolean(selected)" title="首次归组" description="新请求将按组权限与预算执行，原设备不需要重新兑换。" :close-disabled="pending" @close="selected = null"><form id="assign-device-group" class="stack-form" @submit.prevent="save(true)"><label>员工所属组<select v-model="groupId" aria-label="迁移目标组" required :disabled="pending"><option value="">请选择</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label><p v-if="!groups.length && !pending">该员工暂无有效组，请先在用量组中添加成员。</p><p v-if="error" class="state error">{{ error }}</p></form><template #footer><button form="assign-device-group" type="submit" :disabled="pending || !groupId">确认归组</button></template></Drawer>
    <ConfirmDialog :open="confirm" title="切换设备归组要求" message="该组织的新请求立即执行新要求；在途请求保留开始时的归属。确认继续？" :close-disabled="pending" @confirm="save()" @cancel="confirm = false" />
  </section>
</template>
