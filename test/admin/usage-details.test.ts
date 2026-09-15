// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import UsageDetail from '../../apps/admin/src/components/UsageDetail.vue'

const state = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))

it('reports absent or rejected clipboard support honestly, copies successfully, and resets for another request', async () => {
  state.api.mockImplementation(async (url: string) => ({ id: url, requestId: url.includes('/second') ? 'request-2' : 'request-1', routes: [] }))
  const wrapper = mount(UsageDetail, { props: { id: 'first', query: '' }, global: { stubs: { teleport: true, RouterLink: true }, config: { errorHandler: () => {} } } })
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  try {
    await flushPromises()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await wrapper.get('[aria-label="复制请求 ID"]').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('无法复制，请手动选择并复制上方请求 ID')
    expect(wrapper.get('[aria-label="复制请求 ID"]').text()).toBe('复制请求 ID')
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await wrapper.get('[aria-label="复制请求 ID"]').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('无法复制，请手动选择并复制上方请求 ID')
    expect(wrapper.get('[aria-label="复制请求 ID"]').text()).toBe('复制请求 ID')
    writeText.mockResolvedValue(undefined)
    await wrapper.get('[aria-label="复制请求 ID"]').trigger('click'); await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith('request-1')
    expect(wrapper.get('[aria-label="复制请求 ID"]').text()).toBe('已复制')
    expect(wrapper.text()).not.toContain('无法复制')
    await wrapper.setProps({ id: 'second' }); await flushPromises()
    expect(wrapper.get('[aria-label="复制请求 ID"]').text()).toBe('复制请求 ID')
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
    wrapper.unmount()
  }
})

it('shows request-level historical prices with no invented route price and labels missing history', async () => {
  const detail = { id: 'old', requestId: 'old-request', routes: [], requestPrice: { ruleName: '旧请求价', inputPerMillion: '1', cachedPerMillion: '2', outputPerMillion: '3', reasoningPerMillion: '4' } }
  state.api.mockResolvedValue(detail)
  const wrapper = mount(UsageDetail, { props: { id: 'old', query: '' }, global: { stubs: { teleport: true, RouterLink: true } } })
  await flushPromises()
  expect(wrapper.text()).toContain('请求级历史价格')
  expect(wrapper.text()).toContain('旧请求价')
  expect(wrapper.text()).toContain('输入 ¥1 / 缓存 ¥2 / 输出 ¥3 / 推理 ¥4 / 1M')
  state.api.mockResolvedValue({ ...detail, requestPrice: null })
  await wrapper.setProps({ id: 'missing' }); await flushPromises()
  expect(wrapper.text()).toContain('请求级历史价格：未提供')
  expect(wrapper.text()).not.toContain('旧请求价')
  wrapper.unmount()
})

it('ignores late detail responses and clipboard completion after switching requests', async () => {
  let finishOld: (value: unknown) => void = () => {}
  state.api.mockImplementation((url: string) => url.includes('/old') ? new Promise(resolve => { finishOld = resolve }) : Promise.resolve({ requestId: url.includes('/second') ? 'second' : 'first', routes: [] }))
  const wrapper = mount(UsageDetail, { props: { id: 'old', query: '' }, global: { stubs: { teleport: true, RouterLink: true } } })
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  try {
    await wrapper.setProps({ id: 'first' }); await flushPromises()
    finishOld({ requestId: 'stale-request', routes: [] }); await flushPromises()
    expect(wrapper.text()).not.toContain('stale-request')
    let finishCopy: () => void = () => {}
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>(resolve => { finishCopy = resolve }) } })
    await wrapper.get('[aria-label="复制请求 ID"]').trigger('click')
    await wrapper.setProps({ id: 'second' }); await flushPromises()
    finishCopy(); await flushPromises()
    expect(wrapper.get('[aria-label="复制请求 ID"]').text()).toBe('复制请求 ID')
    expect(wrapper.text()).toContain('second')
    await wrapper.setProps({ id: 'old' }); await wrapper.setProps({ id: null })
    finishOld({ requestId: 'stale-closed', routes: [] }); await flushPromises()
    expect(wrapper.text()).not.toContain('stale-closed')
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
    wrapper.unmount()
  }
})

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
