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
const loading = ref(false), error = ref(''), draft = ref<Record<string, string>>({}), startDay = ref(''), endDay = ref(''), dateTouched = ref(false)
const activeDimension = ref<Dimension | null>(null), optionQuery = ref('')
const options = ref<Record<string, Option[]>>({ organizations: [], channels: [], models: [], channelModels: [], accounts: [], costRules: [], groups: [], apiKeys: [] })
const pages = ref<Record<string, { total: number; limit: number; offset: number }>>({})
const endpoint = computed(() => props.mode === 'logs' ? '/api/v1/usage/filter-options' : '/api/v1/analytics/filter-options')
const keyByDimension: Record<Dimension, string> = { organization: 'organizations', channel: 'channels', model: 'models', channelModel: 'channelModels', account: 'accounts', group: 'groups', apiKey: 'apiKeys', costRule: 'costRules' }
const filterByDimension: Record<Dimension, string> = { organization: 'organizationId', channel: 'channelId', model: 'publicModelId', channelModel: 'channelModelId', account: 'accountId', group: 'groupId', apiKey: 'apiKeyId', costRule: 'priceKey' }
const labelByDimension: Record<Dimension, string> = { organization: '组织', channel: '渠道', model: '模型', channelModel: '渠道模型', account: '员工', group: '用量组', apiKey: '员工 Key', costRule: '价格快照' }
let externalStart = '', externalEnd = ''

function asDay(value: string, end = false) {
  if (!value) return ''
  const date = new Date(value); if (Number.isNaN(date.getTime())) return ''
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1000 - (end ? 1 : 0))
  return `${china.getUTCFullYear()}-${String(china.getUTCMonth() + 1).padStart(2, '0')}-${String(china.getUTCDate()).padStart(2, '0')}`
}
function selected(dimension: Dimension) {
  const key = filterByDimension[dimension], value = draft.value[key], list = options.value[keyByDimension[dimension]] || []
  return value && !list.some(item => item.id === value) ? [{ id: value, name: `历史值 ${value}`, drillQuery: { [key]: value } }, ...list] : list
}
function optionValue(dimension: Dimension, item: Option, index: number) { return item.id === null ? `__option_${dimension}_${index}` : item.id }
function matches(item: Option, value: Record<string, string>) { return Object.entries(item.drillQuery || {}).every(([key, current]) => value[key] === current) }
function selection(dimension: Dimension) {
  if (dimension === 'channelModel' && draft.value.channelModelScope === 'UNASSOCIATED') return '__UNASSOCIATED__'
  if (dimension === 'group' && draft.value.groupScope === 'UNGROUPED') return '__UNGROUPED__'
  if (dimension === 'apiKey' && draft.value.keyScope === 'NO_KEY') return '__NO_KEY__'
  const list = selected(dimension), matched = list.find(item => item.id === null && matches(item, draft.value))
  return matched ? optionValue(dimension, matched, list.indexOf(matched)) : draft.value[filterByDimension[dimension]] || ''
}
function clearDimension(dimension: Dimension) {
  const next = draft.value
  if (dimension === 'channel') { next.channelId = ''; next.allocation = '' }
  if (dimension === 'channelModel') { next.channelModelId = ''; next.channelModelScope = '' }
  if (dimension === 'group') { next.groupId = ''; next.groupScope = '' }
  if (dimension === 'apiKey') { next.apiKeyId = ''; next.keyScope = '' }
  if (dimension === 'costRule') { next.priceKey = ''; next.costRuleId = ''; next.allocation = '' }
  if (dimension === 'model') { next.publicModelId = ''; next.model = '' }
  if (dimension === 'organization') next.organizationId = ''
  if (dimension === 'account') next.accountId = ''
}
function update(next: Record<string, string>) { draft.value = next; emit('update:modelValue', { ...next }) }
function patch(key: string, value: string) {
  const next = { ...draft.value, [key]: value }
  if (key === 'channelModelId') next.channelModelScope = ''
  if (key === 'channelModelScope') next.channelModelId = ''
  if (key === 'groupId') next.groupScope = ''
  if (key === 'groupScope') next.groupId = ''
  if (key === 'apiKeyId') next.keyScope = ''
  if (key === 'keyScope') next.apiKeyId = ''
  if (key === 'publicModelId') next.model = ''
  if (key === 'priceKey') next.costRuleId = ''
  update(next)
}
function choose(dimension: Dimension, value: string) {
  const next = { ...draft.value }; draft.value = next; clearDimension(dimension)
  if (value === '__UNASSOCIATED__') next.channelModelScope = 'UNASSOCIATED'
  else if (value === '__UNGROUPED__') next.groupScope = 'UNGROUPED'
  else if (value === '__NO_KEY__') next.keyScope = 'NO_KEY'
  else if (value) {
    const list = selected(dimension), option = list.find((item, index) => optionValue(dimension, item, index) === value)
    Object.assign(next, option?.drillQuery || { [filterByDimension[dimension]]: option?.id || value })
  }
  update(next)
}
async function loadOptions(dimension: Dimension, q = optionQuery.value, offset = 0) {
  const search = q.trim()
  if (search.length > 100) { error.value = '搜索条件最多 100 个字符'; return }
  const current = lifecycle.next(); loading.value = true; error.value = ''
  const query = { ...draft.value, optionDimension: dimension, q: search, limit: '50', offset: String(offset) }
  try {
    const result: any = await api(`${endpoint.value}?${usageQuery(query, props.pinnedGroupId)}`)
    if (!lifecycle.isCurrent(current)) return
    if (result.page) {
      options.value = { ...options.value, [keyByDimension[dimension]]: result.page.items }
      pages.value = { ...pages.value, [dimension]: result.page }
    }
  } catch (value: any) { if (lifecycle.isCurrent(current)) error.value = value.message } finally { if (lifecycle.isCurrent(current)) loading.value = false }
}
function activate(dimension: Dimension) { activeDimension.value = dimension; optionQuery.value = ''; void loadOptions(dimension, '', 0) }
function searchOptions() { if (activeDimension.value) void loadOptions(activeDimension.value, optionQuery.value, 0) }
function changeOptions(offset: number) { if (activeDimension.value) void loadOptions(activeDimension.value, optionQuery.value, offset) }
function apply() {
  error.value = ''
  const next = { ...draft.value }
  if (dateTouched.value) {
    if (!startDay.value || !endDay.value) { error.value = '请选择完整日期范围'; return }
    try { Object.assign(next, companyDateRange(startDay.value, endDay.value)) }
    catch (value: any) { error.value = value.message; return }
  }
  if (props.pinnedGroupId) { next.groupId = props.pinnedGroupId; next.groupScope = '' }
  update(next); emit('apply', next)
}
function clear() {
  const range = defaultCompanyDateRange(), next = { ...range, ...(props.pinnedGroupId ? { groupId: props.pinnedGroupId } : {}) }
  startDay.value = asDay(range.start); endDay.value = asDay(range.end, true); dateTouched.value = false; update(next); emit('apply', next)
}
watch(() => props.modelValue, value => {
  const changedDates = value.start !== externalStart || value.end !== externalEnd
  externalStart = value.start || ''; externalEnd = value.end || ''
  draft.value = { ...value, ...(props.pinnedGroupId ? { groupId: props.pinnedGroupId, groupScope: '' } : {}) }
  if (changedDates || !dateTouched.value) { startDay.value = asDay(value.start || ''); endDay.value = asDay(value.end || '', true); dateTouched.value = false }
}, { immediate: true, deep: true })
watch(() => [props.mode, props.pinnedGroupId], () => { if (activeDimension.value) void loadOptions(activeDimension.value) })
onUnmounted(() => lifecycle.dispose())
</script>

<template>
  <section class="panel form-panel usage-filters"><div class="form-row">
    <label>开始日期<input v-model="startDay" aria-label="开始日期" type="date" @input="dateTouched = true"></label><label>结束日期（含）<input v-model="endDay" aria-label="结束日期" type="date" @input="dateTouched = true"></label>
    <label v-if="role === 'PLATFORM_ADMIN'">组织<select aria-label="组织筛选" :value="selection('organization')" @focus="activate('organization')" @change="choose('organization', ($event.target as HTMLSelectElement).value)"><option value="">全部组织</option><option v-for="(item, index) in selected('organization')" :key="optionValue('organization', item, index)" :value="optionValue('organization', item, index)">{{ item.name }}</option></select></label>
    <label>渠道<select aria-label="渠道筛选" :value="selection('channel')" @focus="activate('channel')" @change="choose('channel', ($event.target as HTMLSelectElement).value)"><option value="">全部渠道</option><option v-for="(item, index) in selected('channel')" :key="optionValue('channel', item, index)" :value="optionValue('channel', item, index)">{{ item.name }}</option></select></label>
    <label>模型<select aria-label="模型筛选" :value="selection('model')" @focus="activate('model')" @change="choose('model', ($event.target as HTMLSelectElement).value)"><option value="">全部模型</option><option v-for="(item, index) in selected('model')" :key="optionValue('model', item, index)" :value="optionValue('model', item, index)">{{ item.name }}</option></select></label>
    <label>渠道模型<select aria-label="渠道模型筛选" :value="selection('channelModel')" @focus="activate('channelModel')" @change="choose('channelModel', ($event.target as HTMLSelectElement).value)"><option value="">全部渠道模型</option><option value="__UNASSOCIATED__">未关联渠道模型</option><option v-for="(item, index) in selected('channelModel')" :key="optionValue('channelModel', item, index)" :value="optionValue('channelModel', item, index)">{{ item.name }}</option></select></label>
    <label>员工<select aria-label="员工筛选" :value="selection('account')" @focus="activate('account')" @change="choose('account', ($event.target as HTMLSelectElement).value)"><option value="">{{ role === 'MEMBER' ? '仅本人' : '全部员工' }}</option><option v-for="(item, index) in selected('account')" :key="optionValue('account', item, index)" :value="optionValue('account', item, index)">{{ item.name }}</option></select></label>
    <label>用量组<select aria-label="用量组筛选" :disabled="Boolean(pinnedGroupId)" :value="selection('group')" @focus="activate('group')" @change="choose('group', ($event.target as HTMLSelectElement).value)"><option value="">全部组（含历史未归组）</option><option value="__UNGROUPED__">历史未归组</option><option v-for="(item, index) in selected('group')" :key="optionValue('group', item, index)" :value="optionValue('group', item, index)">{{ item.name }}</option></select></label>
    <label>员工 Key<select aria-label="员工 Key 筛选" :value="selection('apiKey')" @focus="activate('apiKey')" @change="choose('apiKey', ($event.target as HTMLSelectElement).value)"><option value="">全部 Key / 设备</option><option value="__NO_KEY__">设备凭据</option><option v-for="(item, index) in selected('apiKey')" :key="optionValue('apiKey', item, index)" :value="optionValue('apiKey', item, index)">{{ item.name }}</option></select></label>
    <label>价格快照<select aria-label="价格快照筛选" :value="selection('costRule')" @focus="activate('costRule')" @change="choose('costRule', ($event.target as HTMLSelectElement).value)"><option value="">全部价格快照</option><option v-for="(item, index) in selected('costRule')" :key="optionValue('costRule', item, index)" :value="optionValue('costRule', item, index)">{{ item.name }}</option></select></label>
    <label>凭据<select aria-label="凭据筛选" :value="draft.credentialType || ''" @change="patch('credentialType', ($event.target as HTMLSelectElement).value)"><option value="">全部凭据</option><option value="API_KEY">员工 API Key</option><option value="DEVICE">UCLI 设备</option></select></label><label>请求状态<select aria-label="请求状态筛选" :value="draft.requestState || ''" @change="patch('requestState', ($event.target as HTMLSelectElement).value)"><option value="">全部状态</option><option value="SUCCESS">成功</option><option value="FAILED">失败</option><option value="CANCELLED">取消</option><option value="INTERRUPTED">中断</option></select></label><label>计费状态<select aria-label="计费状态筛选" :value="draft.billingState || ''" @change="patch('billingState', ($event.target as HTMLSelectElement).value)"><option value="">全部计费状态</option><option value="CONFIRMED">已确认</option><option value="ESTIMATED">估算</option><option value="UNKNOWN">待核对</option><option value="NO_CHARGE">无费用</option></select></label><label v-if="mode === 'logs'">请求 ID<input :value="draft.requestId || ''" @input="patch('requestId', ($event.target as HTMLInputElement).value)"></label>
    <div class="usage-filter-actions"><button class="primary" :disabled="loading" @click="apply">应用筛选</button><button type="button" @click="clear">清空筛选</button></div>
  </div><div v-if="activeDimension" class="form-row"><label :for="`option-search-${activeDimension}`">搜索{{ labelByDimension[activeDimension] }}选项</label><input :id="`option-search-${activeDimension}`" :aria-label="`搜索${labelByDimension[activeDimension]}选项`" maxlength="100" v-model="optionQuery" @input="searchOptions"><span v-if="pages[activeDimension]">{{ pages[activeDimension].offset + 1 }}–{{ Math.min(pages[activeDimension].offset + pages[activeDimension].limit, pages[activeDimension].total) }} / {{ pages[activeDimension].total }}</span><button :aria-label="`${labelByDimension[activeDimension]}选项上一页`" :disabled="!pages[activeDimension] || pages[activeDimension].offset === 0" @click="changeOptions(Math.max(0, pages[activeDimension]?.offset - pages[activeDimension]?.limit))">上一页</button><button :aria-label="`${labelByDimension[activeDimension]}选项下一页`" :disabled="!pages[activeDimension] || pages[activeDimension].offset + pages[activeDimension].limit >= pages[activeDimension].total" @click="changeOptions(pages[activeDimension].offset + pages[activeDimension].limit)">下一页</button></div><p v-if="error" class="state error">{{ error }}</p></section>
</template>
