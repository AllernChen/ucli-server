const QUERY_FIELDS = new Set([
  'start', 'end', 'timezone', 'organizationId', 'accountId', 'groupId', 'apiKeyId', 'credentialType', 'channelId',
  'publicModelId', 'model', 'channelModelId', 'channelModelScope', 'requestState', 'billingState', 'groupScope',
  'keyScope', 'costRuleId', 'priceKey', 'allocation', 'requestId', 'sessionId', 'projectId', 'limit', 'offset',
  'optionDimension', 'q', 'dimension', 'interval', 'sort', 'order'
])

function calendarDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error('请选择有效日期')
  const [, year, month, day] = match
  const date = new Date(`${value}T00:00:00+08:00`)
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  if (Number.isNaN(date.getTime()) || local.getUTCFullYear() !== Number(year) || local.getUTCMonth() + 1 !== Number(month) || local.getUTCDate() !== Number(day)) throw new Error('请选择有效日期')
  return date
}

export function companyDateRange(startDay: string, endDay: string) {
  const begin = calendarDay(startDay)
  const finish = calendarDay(endDay)
  if (finish.getTime() < begin.getTime()) throw new Error('结束日期不能早于开始日期')
  return { start: begin.toISOString(), end: new Date(finish.getTime() + 86_400_000).toISOString(), timezone: 'Asia/Shanghai' as const }
}
export function defaultCompanyDateRange(now = new Date()) {
  const china = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const endDay = `${china.getUTCFullYear()}-${String(china.getUTCMonth() + 1).padStart(2, '0')}-${String(china.getUTCDate()).padStart(2, '0')}`
  const start = new Date(Date.UTC(china.getUTCFullYear(), china.getUTCMonth(), china.getUTCDate()) - 6 * 86_400_000)
  const startDay = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(start.getUTCDate()).padStart(2, '0')}`
  return companyDateRange(startDay, endDay)
}

export function usageQuery(filters: Record<string, string | undefined>, pinnedGroupId?: string): string {
  const normalized = { ...filters }
  if (normalized.publicModelId) delete normalized.model
  if (normalized.channelModelId) delete normalized.channelModelScope
  else if (normalized.channelModelScope) delete normalized.channelModelId
  if (normalized.apiKeyId) delete normalized.keyScope
  else if (normalized.keyScope) delete normalized.apiKeyId
  if (normalized.priceKey) delete normalized.costRuleId
  else if (normalized.costRuleId) delete normalized.priceKey
  if (pinnedGroupId) { normalized.groupId = pinnedGroupId; delete normalized.groupScope }
  else if (normalized.groupId) delete normalized.groupScope
  else if (normalized.groupScope) delete normalized.groupId
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(normalized)) if (QUERY_FIELDS.has(key) && value?.trim()) query.set(key, value.trim())
  return query.toString()
}
