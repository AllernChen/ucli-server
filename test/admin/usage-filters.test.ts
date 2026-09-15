// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { companyDateRange, defaultCompanyDateRange, usageQuery } from '../../apps/admin/src/usage-filters.js'
import UsageFilters from '../../apps/admin/src/components/UsageFilters.vue'
import { UsageQueryDto } from '../../apps/api/src/analytics.dto.js'

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
  expect(new URL('http://local' + state.api.mock.calls[0][0]).searchParams.has('q')).toBe(false)
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

it('keeps an edited date when choosing another draft filter before apply', async () => {
  state.api.mockResolvedValue({ organizations: [], channels: [], models: [], channelModels: [], accounts: [], costRules: [], groups: [], apiKeys: [], page: { dimension: 'channel', items: [{ id: 'channel-1', name: '渠道一', drillQuery: { channelId: 'channel-1' } }], total: 1, limit: 50, offset: 0 } })
  const wrapper = mount(UsageFilters, { props: { modelValue: { start: '2026-09-14T16:00:00.000Z', end: '2026-09-15T16:00:00.000Z' }, role: '' } })
  await wrapper.get('[aria-label="开始日期"]').setValue('2026-09-14')
  await wrapper.get('[aria-label="渠道筛选"]').trigger('focus'); await flushPromises()
  await wrapper.get('[aria-label="渠道筛选"]').setValue('channel-1')
  await wrapper.setProps({ modelValue: wrapper.emitted('update:modelValue')!.at(-1)![0] })
  await wrapper.get('button.primary').trigger('click')
  expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ start: '2026-09-13T16:00:00.000Z', end: '2026-09-15T16:00:00.000Z', channelId: 'channel-1' })
  wrapper.unmount()
})

it('searches and pages the active option dimension through visible controls', async () => {
  state.api.mockResolvedValue({ organizations: [], channels: [], models: [], channelModels: [], accounts: [], costRules: [], groups: [], apiKeys: [], page: { dimension: 'channel', items: [{ id: 'channel-1', name: '渠道一' }], total: 101, limit: 50, offset: 0 } })
  const wrapper = mount(UsageFilters, { props: { modelValue: {}, role: '' } })
  await wrapper.get('[aria-label="渠道筛选"]').trigger('focus'); await flushPromises()
  const emitted = () => Object.fromEntries(new URL('http://local' + state.api.mock.calls.at(-1)![0]).searchParams) as Record<string, string>
  expect(emitted()).toEqual({ optionDimension: 'channel', limit: '50', offset: '0' })
  expect(Object.hasOwn(emitted(), 'q')).toBe(false)
  expect(await validate(plainToInstance(UsageQueryDto, emitted()))).toHaveLength(0)
  await wrapper.get('[aria-label="渠道选项下一页"]').trigger('click'); await flushPromises()
  expect(emitted()).toEqual({ optionDimension: 'channel', limit: '50', offset: '50' })
  expect(Object.hasOwn(emitted(), 'q')).toBe(false)
  expect(await validate(plainToInstance(UsageQueryDto, emitted()))).toHaveLength(0)
  await wrapper.get('[aria-label="搜索渠道选项"]').setValue('alpha'); await flushPromises()
  expect(state.api.mock.calls.at(-1)![0]).toContain('optionDimension=channel')
  expect(state.api.mock.calls.at(-1)![0]).toContain('q=alpha')
  expect(emitted()).toEqual({ optionDimension: 'channel', q: 'alpha', limit: '50', offset: '0' })
  expect(await validate(plainToInstance(UsageQueryDto, emitted()))).toHaveLength(0)
  await wrapper.get('[aria-label="搜索渠道选项"]').setValue(''); await flushPromises()
  expect(Object.hasOwn(emitted(), 'q')).toBe(false)
  expect(emitted()).toEqual({ optionDimension: 'channel', limit: '50', offset: '0' })
  expect(await validate(plainToInstance(UsageQueryDto, emitted()))).toHaveLength(0)
  wrapper.unmount()
})

it('keeps a selected historical option visible after a later search page excludes it', async () => {
  state.api.mockImplementation((path: string) => {
    const query = new URL('http://local' + path).searchParams
    const items = query.get('q') ? [{ id: 'channel-2', name: '另一个渠道' }] : [{ id: 'channel-1', name: '历史渠道' }]
    return Promise.resolve({ organizations: [], channels: [], models: [], channelModels: [], accounts: [], costRules: [], groups: [], apiKeys: [], page: { dimension: 'channel', items, total: 2, limit: 50, offset: 0 } })
  })
  const wrapper = mount(UsageFilters, { props: { modelValue: {}, role: '' } })
  const control = wrapper.get('[aria-label="渠道筛选"]')
  await control.trigger('focus'); await flushPromises(); await control.setValue('channel-1')
  await wrapper.get('[aria-label="搜索渠道选项"]').setValue('other'); await flushPromises()
  expect((control.element as HTMLSelectElement).value).toBe('channel-1')
  expect(wrapper.text()).toContain('历史值 channel-1')
  wrapper.unmount()
})

it('uses distinct All and null drill choices before serializing each affected dimension', async () => {
  const pages: Record<string, any[]> = {
    group: [{ id: null, name: '历史未归组', drillQuery: { groupScope: 'UNGROUPED' } }, { id: 'group-real', name: '组' }],
    apiKey: [{ id: null, name: '设备', drillQuery: { keyScope: 'NO_KEY' } }, { id: 'key-real', name: 'Key' }],
    channelModel: [{ id: null, name: '未关联', drillQuery: { channelModelScope: 'UNASSOCIATED' } }, { id: 'model-real', name: '模型' }],
    channel: [{ id: null, name: '差额', drillQuery: { allocation: 'UNALLOCATED' } }, { id: 'channel-real', name: '渠道' }],
    costRule: [{ id: null, name: '无快照', drillQuery: { allocation: 'UNALLOCATED' } }, { id: 'price-real', name: '价格', drillQuery: { priceKey: 'price-real' } }]
  }
  state.api.mockImplementation((path: string) => {
    const dimension = new URL('http://local' + path).searchParams.get('optionDimension')!
    return Promise.resolve({ organizations: [], channels: [], models: [], channelModels: [], accounts: [], costRules: [], groups: [], apiKeys: [], page: { dimension, items: pages[dimension] || [], total: 2, limit: 50, offset: 0 } })
  })
  const wrapper = mount(UsageFilters, { props: { modelValue: {}, role: '' } })
  for (const [label, sentinel, real] of [['用量组筛选', '__UNGROUPED__', 'group-real'], ['员工 Key 筛选', '__NO_KEY__', 'key-real'], ['渠道模型筛选', '__UNASSOCIATED__', 'model-real'], ['渠道筛选', '__option_channel_0', 'channel-real'], ['价格快照筛选', '__option_costRule_0', 'price-real']] as const) {
    const control = wrapper.get(`[aria-label="${label}"]`)
    await control.trigger('focus'); await flushPromises()
    await control.setValue(sentinel); expect((control.element as HTMLSelectElement).value).toBe(sentinel)
    await control.setValue(real); expect((control.element as HTMLSelectElement).value).toBe(real)
    await control.setValue('')
    expect((control.element as HTMLSelectElement).value).toBe('')
  }
  await wrapper.get('button.primary').trigger('click')
  const applied = wrapper.emitted('apply')!.at(-1)![0] as Record<string, string>
  const query = new URLSearchParams(usageQuery(applied))
  for (const key of ['groupId', 'groupScope', 'apiKeyId', 'keyScope', 'channelModelId', 'channelModelScope', 'channelId', 'allocation', 'priceKey', 'costRuleId']) expect(query.has(key)).toBe(false)
  wrapper.unmount()
})
