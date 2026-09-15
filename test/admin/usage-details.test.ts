// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import UsageDetail from '../../apps/admin/src/components/UsageDetail.vue'

const state = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))

it('labels an unknown budget and each part of a multi-channel cost without inventing zeroes', async () => {
  state.api.mockResolvedValue({ id: 'log-1', requestId: 'request-1', employeeName: '员工', groupName: '组', publicModelId: 'm',
    costCny: '10.00000000', matchedCostCny: '2.00000000', unallocatedCostCny: '8.00000000', requestState: 'SUCCESS', budget: null, budgetAvailability: 'NOT_FOUND',
    routes: [{ attempt: 1, channelName: '渠道', costCny: '2.00000000', price: { inputPerMillion: '1', cachedPerMillion: '2', outputPerMillion: '3', reasoningPerMillion: '4' }, formulaCosts: { inputCost: '0.1', cachedCost: '0.2', outputCost: '0.3', reasoningCost: '0.4', totalCost: '1', currency: 'CNY', differenceCny: '1' }, inputTokens: null, outputTokens: '9007199254740993' }] })
  const wrapper = mount(UsageDetail, { props: { id: 'log-1', query: 'groupId=group-1' }, global: { stubs: { teleport: true, RouterLink: true } } })
  await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/usage/logs/log-1?groupId=group-1')
  expect(wrapper.text()).toContain('完整请求成本')
  expect(wrapper.text()).toContain('匹配部分成本')
  expect(wrapper.text()).toContain('未提供')
  expect(wrapper.text()).toContain('9,007,199,254,740,993')
  expect(wrapper.text()).toContain('输入公式成本')
  expect(wrapper.text()).toContain('未分配路由成本差额')
  expect(wrapper.text()).toContain('¥8.00000000')
  wrapper.unmount()
})
