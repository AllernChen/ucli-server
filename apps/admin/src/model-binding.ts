export type ModelBindingMode = 'EXISTING' | 'CREATE'

export interface PublicModelIdentity {
  id: string
  deletedAt?: string | null
}

export interface ModelBindingForm {
  publicModelId: string
  publicModelDisplayName: string
  manufacturer: string
  contextSize: number | null | ''
  upstreamModel: string
  protocol: 'OPENAI_RESPONSES' | 'OPENAI_CHAT' | 'ANTHROPIC_MESSAGES' | 'GEMINI'
  supportsStream: boolean
  supportsTools: boolean
  probeEnabled: boolean
  probeIntervalMinutes: number
}

export interface ModelBindingPayload {
  publicModelId: string
  createPublicModel: boolean
  publicModelDisplayName?: string
  manufacturer?: string
  contextSize?: number | null
  upstreamModel: string
  protocol: ModelBindingForm['protocol']
  supportsStream: boolean
  supportsTools: boolean
  probeEnabled: boolean
  probeIntervalMinutes: number
}

export function exactPublicModelMatch<T extends PublicModelIdentity>(id: string, models: T[]): T | null {
  const key = id.trim()
  return models.find(model => model.id === key && !model.deletedAt) ?? null
}

export function exactArchivedPublicModelMatch<T extends PublicModelIdentity>(id: string, models: T[]): T | null {
  const key = id.trim()
  return models.find(model => model.id === key && Boolean(model.deletedAt)) ?? null
}

export function bindingModeForId(id: string, models: PublicModelIdentity[]): ModelBindingMode {
  return exactPublicModelMatch(id, models) ? 'EXISTING' : 'CREATE'
}

export function suggestManufacturer(modelId: string, provider: string): string {
  const normalizedId = modelId.trim().toLocaleLowerCase('en-US')
  if (normalizedId.startsWith('deepseek')) return 'DeepSeek'
  if (normalizedId.startsWith('claude')) return 'Anthropic'
  if (normalizedId.startsWith('gemini')) return 'Google'
  if (normalizedId.startsWith('gpt') || /^o[1-9](?:$|[-_.])/.test(normalizedId)) return 'OpenAI'
  return provider.trim() || '未分类'
}

export function nextPublicModelIdForUpstreamInput(
  upstreamModelId: string,
  currentPublicModelId: string,
  editing: boolean
): string {
  return editing ? currentPublicModelId : upstreamModelId.trim()
}

export type ModelFormErrorEvent =
  | { type: 'OPEN' | 'SUCCESS' }
  | { type: 'FAILURE'; message: string }

export function nextModelFormError(_current: string, event: ModelFormErrorEvent): string {
  return event.type === 'FAILURE' ? event.message : ''
}

export function costArchiveNotice(count: number): string {
  return count > 0 ? `已归档 ${count} 条旧采购成本规则，请重新确认成本` : ''
}

export function buildModelBindingPayload(form: ModelBindingForm, mode: ModelBindingMode): ModelBindingPayload {
  const common = {
    publicModelId: form.publicModelId.trim(),
    createPublicModel: mode === 'CREATE',
    upstreamModel: form.upstreamModel.trim(),
    protocol: form.protocol,
    supportsStream: form.supportsStream,
    supportsTools: form.supportsTools,
    probeEnabled: form.probeEnabled,
    probeIntervalMinutes: form.probeIntervalMinutes
  }

  if (mode === 'EXISTING') return common
  return {
    publicModelId: common.publicModelId,
    createPublicModel: true,
    publicModelDisplayName: form.publicModelDisplayName.trim(),
    manufacturer: form.manufacturer.trim(),
    contextSize: form.contextSize === '' || form.contextSize === null ? null : form.contextSize,
    upstreamModel: common.upstreamModel,
    protocol: common.protocol,
    supportsStream: common.supportsStream,
    supportsTools: common.supportsTools,
    probeEnabled: common.probeEnabled,
    probeIntervalMinutes: common.probeIntervalMinutes
  }
}
