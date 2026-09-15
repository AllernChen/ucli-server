// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Usage from '../../apps/admin/src/views/Usage.vue'
import UsageFilters from '../../apps/admin/src/components/UsageFilters.vue'
const state = vi.hoisted(() => ({ api: vi.fn(), replace: vi.fn(), push: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: { groupId: 'untrusted-other-group' } }), useRouter: () => ({ replace: state.replace, push: state.push }) }))
it('pins embedded logs to the detail group and labels unknown cost without claiming free success', async () => {
  state.api.mockImplementation((path: string) => path.includes('filter-options')
    ? Promise.resolve({ organizations: [], channels: [], models: [], channelModels: [], accounts: [], costRules: [], groups: [], apiKeys: [], page: null })
    : Promise.resolve({ items: [{ id: 'log-1', requestId: 'r', startedAt: '2026-09-15T00:00:00Z', employeeName: '历史员工', groupName: '历史组', credentialType: 'API_KEY', keyName: '旧 Key', keyHint: '…abcd', inputTokens: '10', cachedTokens: '3', reasoningTokens: '2', outputTokens: '4', matchedCostCny: '0', costCny: '4.00000000', billingState: 'UNKNOWN', requestState: 'SUCCESS', statusCode: 200 }], total: 1, limit: 50, offset: 0 }))
  const w = mount(Usage, { props: { groupId: 'actual-group', embedded: true }, global: { stubs: { RouterLink: true } } }); await flushPromises()
  const pageCall = state.api.mock.calls.find(([path]) => path.includes('logs-page'))
  const query = new URL('http://local' + pageCall![0]).searchParams
  expect(query.get('groupId')).toBe('actual-group')
  expect(w.text()).toContain('历史员工'); expect(w.text()).toContain('旧 Key'); expect(w.text()).toContain('待核对费用，非最终成本')
  expect(w.text()).toContain('匹配记录成本')
  expect(w.text()).toContain('7 / 3 / 2 / 4')
  expect(w.get('[aria-label="用量组筛选"]').attributes('disabled')).toBeDefined()
  w.unmount()
})

it('shows applied-filter result context and billing state independently', async () => {
  state.api.mockResolvedValue({ items: [{ id: 'log-1', requestId: 'r', startedAt: '2026-09-15T00:00:00Z', inputTokens: '1', cachedTokens: '0', outputTokens: '1', matchedCostCny: '0', billingState: 'NO_CHARGE', requestState: 'SUCCESS', statusCode: 200 }], total: 1, limit: 50, offset: 0 })
  const w = mount(Usage, { global: { stubs: { RouterLink: true } } }); await flushPromises()
  expect(w.text()).toContain('当前结果')
  expect(w.text()).toContain('成功')
  expect(w.text()).toContain('无费用')
  w.unmount()
})

it('keeps draft fields out of the page request, then applies them to URL and ignores an older response', async () => {
  const pending: Array<(value: any) => void> = []
  state.api.mockImplementation((path: string) => {
    if (path.includes('logs-page')) return new Promise(resolve => pending.push(resolve))
    if (path.includes('filter-options')) return Promise.resolve({ organizations: [], channels: [], models: [], channelModels: [], accounts: [], costRules: [], groups: [], apiKeys: [], page: null })
    return Promise.resolve({ role: 'ORG_ADMIN' })
  })
  const w = mount(Usage, { global: { stubs: { RouterLink: true } } }); await flushPromises()
  expect(pending).toHaveLength(1)
  const filters = w.findComponent(UsageFilters)
  await filters.vm.$emit('update:modelValue', { limit: '50', requestId: 'draft-only' }); await flushPromises()
  expect(pending).toHaveLength(1)
  await filters.vm.$emit('apply', { limit: '50', requestId: 'applied' }); await flushPromises()
  expect(state.replace).toHaveBeenCalledWith({ query: expect.objectContaining({ requestId: 'applied' }) })
  expect(pending).toHaveLength(2)
  pending[1]({ items: [{ id: 'new', requestId: 'new', employeeName: '最新员工', startedAt: '2026-09-15T00:00:00Z', matchedCostCny: '1' }], total: 1, limit: 50, offset: 0 })
  await flushPromises()
  pending[0]({ items: [{ id: 'old', requestId: 'old', employeeName: '旧员工', startedAt: '2026-09-15T00:00:00Z', matchedCostCny: '1' }], total: 1, limit: 50, offset: 0 })
  await flushPromises()
  expect(w.text()).toContain('最新员工'); expect(w.text()).not.toContain('旧员工')
  w.unmount()
})
