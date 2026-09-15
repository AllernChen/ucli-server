// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { companyDateRange, defaultCompanyDateRange, usageQuery } from '../../apps/admin/src/usage-filters.js'
import UsageFilters from '../../apps/admin/src/components/UsageFilters.vue'

const state = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))

it('serializes one Shanghai calendar day as a UTC half-open range', () => {
  expect(companyDateRange('2026-09-15', '2026-09-15')).toEqual({
    start: '2026-09-14T16:00:00.000Z', end: '2026-09-15T16:00:00.000Z', timezone: 'Asia/Shanghai'
  })
})

it('defaults logs to the last seven Shanghai calendar days', () => {
  expect(defaultCompanyDateRange(new Date('2026-09-15T01:00:00.000Z'))).toEqual({
    start: '2026-09-08T16:00:00.000Z', end: '2026-09-15T16:00:00.000Z', timezone: 'Asia/Shanghai'
  })
})

it('rejects calendar dates and ranges that do not exist', () => {
  expect(() => companyDateRange('2026-02-29', '2026-03-01')).toThrow('有效')
  expect(() => companyDateRange('2026-09-16', '2026-09-15')).toThrow('结束')
})

it('keeps Task 1 filters, removes blanks, and pins the group last', () => {
  const query = new URLSearchParams(usageQuery({ groupId: 'other', requestId: 'request-1', nope: 'drop', model: '' }, 'pinned'))
  expect(query.get('groupId')).toBe('pinned')
  expect(query.get('requestId')).toBe('request-1')
  expect(query.has('nope')).toBe(false)
})

it('preserves route ISO precision until a date input changes and uses analytics options by default', async () => {
  state.api.mockResolvedValue({ organizations: [], channels: [], models: [], channelModels: [], accounts: [], costRules: [], groups: [], apiKeys: [], page: null })
  const wrapper = mount(UsageFilters, { props: { modelValue: { start: '2026-09-14T16:30:00.000Z', end: '2026-09-15T17:45:00.000Z' }, role: '' } })
  await wrapper.get('select').trigger('focus'); await flushPromises()
  expect(state.api.mock.calls[0][0]).toContain('/api/v1/analytics/filter-options?')
  expect(state.api.mock.calls[0][0]).toContain('optionDimension=channel')
  expect(state.api.mock.calls[0][0]).toContain('q=')
  await wrapper.get('button').trigger('click')
  expect(wrapper.emitted('apply')![0][0]).toMatchObject({ start: '2026-09-14T16:30:00.000Z', end: '2026-09-15T17:45:00.000Z' })
  wrapper.unmount()
})

it('clears conflicting sentinel filters while pinning a group', () => {
  const query = new URLSearchParams(usageQuery({ groupId: 'other', groupScope: 'UNGROUPED', apiKeyId: 'key', keyScope: 'NO_KEY', channelModelId: 'model', channelModelScope: 'UNASSOCIATED', model: 'legacy', publicModelId: 'current', priceKey: 'a'.repeat(32), costRuleId: 'rule' }, 'pinned'))
  expect(query.get('groupId')).toBe('pinned'); expect(query.has('groupScope')).toBe(false)
  expect(query.get('apiKeyId')).toBe('key'); expect(query.has('keyScope')).toBe(false)
  expect(query.get('channelModelId')).toBe('model'); expect(query.has('channelModelScope')).toBe(false)
  expect(query.get('publicModelId')).toBe('current'); expect(query.has('model')).toBe(false)
  expect(query.get('priceKey')).toBe('a'.repeat(32)); expect(query.has('costRuleId')).toBe(false)
})

it('applies the unassociated channel-model sentinel without retaining an ID', async () => {
  const wrapper = mount(UsageFilters, { props: { modelValue: { channelModelId: 'old-model' }, role: '' } })
  await wrapper.findAll('select')[2].setValue('__UNASSOCIATED__')
  expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toMatchObject({ channelModelScope: 'UNASSOCIATED', channelModelId: '' })
  wrapper.unmount()
})
