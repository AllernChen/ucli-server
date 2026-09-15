<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { api } from '../api'
import { companyDateRange, defaultCompanyDateRange, usageQuery } from '../usage-filters'
import { createRequestLifecycle } from '../device-grants'

type Option = { id: string | null; name: string; drillQuery?: Record<string, string> }
type Dimension = 'organization' | 'channel' | 'model' | 'channelModel' | 'account' | 'group' | 'apiKey' | 'costRule'
const props = withDefaults(defineProps<{ modelValue: Record<string, string>; role: string; pinnedGroupId?: string; mode?: 'analytics' | 'logs' }>(), { mode: 'analytics' })
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, string>]; apply: [value: Record<string, string>] }>()
const lifecycle = createRequestLifecycle()
const loading = ref(false)
const error = ref('')
const options = ref<Record<string, Option[]>>({ organizations: [], channels: [], models: [], channelModels: [], accounts: [], costRules: [], groups: [], apiKeys: [] })
const draft = ref<Record<string, string>>({})
const startDay = ref('')
const endDay = ref('')
const dateTouched = ref(false)
const endpoint = computed(() => props.mode === 'logs' ? '/api/v1/usage/filter-options' : '/api/v1/analytics/filter-options')
const keyByDimension: Record<Dimension, string> = { organization: 'organizations', channel: 'channels', model: 'models', channelModel: 'channelModels', account: 'accounts', group: 'groups', apiKey: 'apiKeys', costRule: 'costRules' }
const filterByDimension: Record<Dimension, string> = { organization: 'organizationId', channel: 'channelId', model: 'publicModelId', channelModel: 'channelModelId', account: 'accountId', group: 'groupId', apiKey: 'apiKeyId', costRule: 'priceKey' }

function asDay(value: string, end = false) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1000 - (end ? 1 : 0))
  return `${china.getUTCFullYear()}-${String(china.getUTCMonth() + 1).padStart(2, '0')}-${String(china.getUTCDate()).padStart(2, '0')}`
}
function selected(dimension: Dimension): Option[] {
  const key = filterByDimension[dimension], value = draft.value[key]
  if (dimension === 'channelModel' && draft.value.channelModelScope === 'UNASSOCIATED') return [{ id: null, name: '未关联渠道模型', drillQuery: { channelModelScope: 'UNASSOCIATED' } }]
  if (!value || options.value[keyByDimension[dimension]].some(item => item.id === value)) return options.value[keyByDimension[dimension]]
  return [{ id: value, name: `历史值 ${value}`, drillQuery: { [key]: value } }, ...options.value[keyByDimension[dimension]]]
}
function patch(key: string, value: string) {
  draft.value = { ...draft.value, [key]: value }
  if (key === 'channelModelId') draft.value.channelModelScope = ''
  if (key === 'channelModelScope') draft.value.channelModelId = ''
  if (key === 'groupId') draft.value.groupScope = ''
  if (key === 'groupScope') draft.value.groupId = ''
  if (key === 'apiKeyId') draft.value.keyScope = ''
  if (key === 'keyScope') draft.value.apiKeyId = ''
  if (key === 'publicModelId') draft.value.model = ''
  if (key === 'priceKey') draft.value.costRuleId = ''
  emit('update:modelValue', { ...draft.value })
}
function choose(dimension: Dimension, value: string) {
  if (dimension === 'channelModel' && value === '__UNASSOCIATED__') { patch('channelModelScope', 'UNASSOCIATED'); return }
  if (dimension === 'group' && value === '__UNGROUPED__') { patch('groupScope', 'UNGROUPED'); return }
  if (dimension === 'apiKey' && value === '__NO_KEY__') { patch('keyScope', 'NO_KEY'); return }
  const option = selected(dimension).find(item => String(item.id ?? '') === value)
  if (option?.drillQuery) draft.value = { ...draft.value, ...option.drillQuery }
  else patch(filterByDimension[dimension], value)
  emit('update:modelValue', { ...draft.value })
}
async function loadOptions(dimension?: Dimension, q = '', offset = 0) {
  const current = lifecycle.next(); loading.value = true; error.value = ''
  const query = { ...draft.value, ...(dimension ? { optionDimension: dimension, q, limit: '50', offset: String(offset) } : {}) }
  try {
    const result: any = await api(`${endpoint.value}?${usageQuery(query, props.pinnedGroupId)}`)
    if (!lifecycle.isCurrent(current)) return
    if (result.page) options.value = { ...options.value, [keyByDimension[result.page.dimension as Dimension]]: result.page.items }
    else options.value = { ...options.value, ...result }
  } catch (value: any) { if (lifecycle.isCurrent(current)) error.value = value.message } finally { if (lifecycle.isCurrent(current)) loading.value = false }
}
function apply() {
  const next = { ...draft.value }
  if (dateTouched.value) {
    if (!startDay.value || !endDay.value) { error.value = '请选择完整日期范围'; return }
    Object.assign(next, companyDateRange(startDay.value, endDay.value))
  }
  if (props.pinnedGroupId) next.groupId = props.pinnedGroupId
  emit('update:modelValue', next); emit('apply', next)
}
function clear() {
  const range = defaultCompanyDateRange()
  draft.value = { ...range, ...(props.pinnedGroupId ? { groupId: props.pinnedGroupId } : {}) }
  startDay.value = asDay(range.start); endDay.value = asDay(range.end, true); dateTouched.value = false
  emit('update:modelValue', { ...draft.value }); emit('apply', { ...draft.value })
}
watch(() => props.modelValue, value => {
  draft.value = { ...value, ...(props.pinnedGroupId ? { groupId: props.pinnedGroupId } : {}) }
  startDay.value = asDay(value.start || '')
  endDay.value = asDay(value.end || '', true)
  dateTouched.value = false
}, { immediate: true, deep: true })
watch(() => [props.mode, props.pinnedGroupId], () => { void loadOptions() })
onUnmounted(() => lifecycle.dispose())
</script>

<template>
  <section class="panel form-panel usage-filters">
    <div class="form-row">
      <label>开始日期<input v-model="startDay" type="date" @input="dateTouched = true"></label>
      <label>结束日期（含）<input v-model="endDay" type="date" @input="dateTouched = true"></label>
      <label v-if="role === 'PLATFORM_ADMIN'">组织<select :value="draft.organizationId || ''" @focus="loadOptions('organization')" @change="choose('organization', ($event.target as HTMLSelectElement).value)"><option value="">全部组织</option><option v-for="item in selected('organization')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>渠道<select :value="draft.channelId || ''" @focus="loadOptions('channel')" @change="choose('channel', ($event.target as HTMLSelectElement).value)"><option value="">全部渠道</option><option v-for="item in selected('channel')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>模型<select :value="draft.publicModelId || ''" @focus="loadOptions('model')" @change="choose('model', ($event.target as HTMLSelectElement).value)"><option value="">全部模型</option><option v-for="item in selected('model')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>渠道模型<select :value="draft.channelModelScope === 'UNASSOCIATED' ? '__UNASSOCIATED__' : draft.channelModelId || ''" @focus="loadOptions('channelModel')" @change="choose('channelModel', ($event.target as HTMLSelectElement).value)"><option value="">全部渠道模型</option><option value="__UNASSOCIATED__">未关联渠道模型</option><option v-for="item in selected('channelModel').filter(item => item.id)" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>员工<select :value="draft.accountId || ''" @focus="loadOptions('account')" @change="choose('account', ($event.target as HTMLSelectElement).value)"><option value="">{{ role === 'MEMBER' ? '仅本人' : '全部员工' }}</option><option v-for="item in selected('account')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>用量组<select aria-label="用量组筛选" :disabled="Boolean(pinnedGroupId)" :value="draft.groupScope === 'UNGROUPED' ? '__UNGROUPED__' : draft.groupId || ''" @focus="loadOptions('group')" @change="choose('group', ($event.target as HTMLSelectElement).value)"><option value="">全部组（含历史未归组）</option><option value="__UNGROUPED__">历史未归组</option><option v-for="item in selected('group')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>员工 Key<select :value="draft.keyScope === 'NO_KEY' ? '__NO_KEY__' : draft.apiKeyId || ''" @focus="loadOptions('apiKey')" @change="choose('apiKey', ($event.target as HTMLSelectElement).value)"><option value="">全部 Key / 设备</option><option value="__NO_KEY__">设备凭据</option><option v-for="item in selected('apiKey')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>价格快照<select :value="draft.priceKey || ''" @focus="loadOptions('costRule')" @change="choose('costRule', ($event.target as HTMLSelectElement).value)"><option value="">全部价格快照</option><option v-for="item in selected('costRule')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>凭据<select :value="draft.credentialType || ''" @change="patch('credentialType', ($event.target as HTMLSelectElement).value)"><option value="">全部凭据</option><option value="API_KEY">员工 API Key</option><option value="DEVICE">UCLI 设备</option></select></label>
      <label>请求状态<select :value="draft.requestState || ''" @change="patch('requestState', ($event.target as HTMLSelectElement).value)"><option value="">全部状态</option><option value="SUCCESS">成功</option><option value="FAILED">失败</option><option value="CANCELLED">取消</option><option value="INTERRUPTED">中断</option></select></label>
      <label>计费状态<select :value="draft.billingState || ''" @change="patch('billingState', ($event.target as HTMLSelectElement).value)"><option value="">全部计费状态</option><option value="CONFIRMED">已确认</option><option value="ESTIMATED">估算</option><option value="UNKNOWN">待核对</option><option value="NO_CHARGE">无费用</option></select></label>
      <label v-if="mode === 'logs'">请求 ID<input :value="draft.requestId || ''" @input="patch('requestId', ($event.target as HTMLInputElement).value)"></label>
      <button class="primary" :disabled="loading" @click="apply">应用筛选</button><button type="button" @click="clear">清空筛选</button>
    </div>
    <p v-if="error" class="state error">{{ error }}</p>
  </section>
</template>
