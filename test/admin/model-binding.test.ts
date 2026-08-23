import { describe, expect, it } from 'vitest'
import {
  bindingModeForId,
  buildModelBindingPayload,
  costArchiveNotice,
  exactArchivedPublicModelMatch,
  exactPublicModelMatch,
  nextModelFormError,
  nextPublicModelIdForUpstreamInput,
  suggestManufacturer
} from '../../apps/admin/src/model-binding.js'

interface TestModel {
  id: string
  deletedAt: string | null
}

function model(id: string, deletedAt: string | null = null): TestModel {
  return { id, deletedAt }
}

const baseForm = {
  publicModelId: ' deepseek-v3 ',
  publicModelDisplayName: ' DeepSeek V3 ',
  manufacturer: ' DeepSeek ',
  contextSize: 64_000,
  upstreamModel: ' deepseek-chat ',
  protocol: 'OPENAI_CHAT' as const,
  supportsStream: true,
  supportsTools: false,
  probeEnabled: true,
  probeIntervalMinutes: 15
}
const emptyContextSizes: Array<'' | null> = ['', null]

describe('admin channel model binding', () => {
  it('matches an active public model by its exact trimmed id', () => {
    expect(exactPublicModelMatch(' deepseek-v3 ', [model('deepseek-v3'), model('deepseek-r1')])?.id)
      .toBe('deepseek-v3')
  })

  it('keeps model id matching case-sensitive and ignores archived models', () => {
    expect(exactPublicModelMatch('DeepSeek-V3', [model('deepseek-v3')])).toBeNull()
    expect(exactPublicModelMatch('deepseek-v3', [model('deepseek-v3', '2026-08-21T00:00:00Z')])).toBeNull()
  })

  it('detects an exact archived model id so the UI can require restoration', () => {
    expect(exactArchivedPublicModelMatch(' deepseek-v3 ', [
      model('deepseek-v3', '2026-08-21T00:00:00Z'), model('deepseek-r1')
    ])?.id).toBe('deepseek-v3')
  })

  it('switches to create mode when no exact active id exists', () => {
    expect(bindingModeForId('deepseek-r2', [model('deepseek-v3')])).toBe('CREATE')
  })

  it.each([
    ['deepseek-chat', 'openrouter', 'DeepSeek'],
    ['claude-4-sonnet', 'aws-bedrock', 'Anthropic'],
    ['gemini-2.5-pro', 'vertex', 'Google'],
    ['gpt-5', 'azure', 'OpenAI'],
    ['o3-mini', 'azure', 'OpenAI'],
    ['custom-model', 'acme-ai', 'acme-ai']
  ])('suggests manufacturer for %s without changing the model id', (id, provider, expected) => {
    expect(suggestManufacturer(id, provider)).toBe(expected)
  })

  it('builds the existing-model payload without create-only metadata', () => {
    expect(buildModelBindingPayload(baseForm, 'EXISTING')).toEqual({
      publicModelId: 'deepseek-v3',
      createPublicModel: false,
      upstreamModel: 'deepseek-chat',
      protocol: 'OPENAI_CHAT',
      supportsStream: true,
      supportsTools: false,
      probeEnabled: true,
      probeIntervalMinutes: 15
    })
  })

  it('builds the create payload with trimmed public model metadata', () => {
    expect(buildModelBindingPayload(baseForm, 'CREATE')).toEqual({
      publicModelId: 'deepseek-v3',
      createPublicModel: true,
      publicModelDisplayName: 'DeepSeek V3',
      manufacturer: 'DeepSeek',
      contextSize: 64_000,
      upstreamModel: 'deepseek-chat',
      protocol: 'OPENAI_CHAT',
      supportsStream: true,
      supportsTools: false,
      probeEnabled: true,
      probeIntervalMinutes: 15
    })
  })

  it.each(emptyContextSizes)('normalizes an empty create context size (%s) to null', contextSize => {
    expect(buildModelBindingPayload({ ...baseForm, contextSize }, 'CREATE').contextSize).toBeNull()
  })

  it('keeps the bound public model id when upstream id changes during editing', () => {
    expect(nextPublicModelIdForUpstreamInput('new-upstream-id', 'deepseek-v3', true)).toBe('deepseek-v3')
  })

  it('prefills the public model id from upstream id during creation', () => {
    expect(nextPublicModelIdForUpstreamInput(' new-upstream-id ', '', false)).toBe('new-upstream-id')
  })

  it('shows a failed save message inside the model form', () => {
    expect(nextModelFormError('old error', { type: 'FAILURE', message: '绑定失败' })).toBe('绑定失败')
  })

  it.each(['OPEN', 'SUCCESS'] as const)('clears a stale model form error on %s', type => {
    expect(nextModelFormError('stale error', { type })).toBe('')
  })

  it('warns when rebind archives procurement rules tied to the old upstream', () => {
    expect(costArchiveNotice(2)).toBe('已归档 2 条旧采购成本规则，请重新确认成本')
    expect(costArchiveNotice(0)).toBe('')
  })
})
