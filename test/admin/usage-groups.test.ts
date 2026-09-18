// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { budgetLabel } from '../../apps/admin/src/usage-groups.js'
import UsageGroupDetail from '../../apps/admin/src/views/UsageGroupDetail.vue'
const state = vi.hoisted(() => ({ api: vi.fn(), route: { params: { id: 'g' } } }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({ useRoute: () => state.route, useRouter: () => ({ push: vi.fn() }) }))
afterEach(() => vi.clearAllMocks())
it('keeps a zero allocation distinct from explicit unlimited', () => {
  expect(budgetLabel({ unlimited: false, limitCny: '0' })).toBe('¥0')
  expect(budgetLabel({ unlimited: true, limitCny: '0' })).toBe('不限额')
})
it('shows empty membership and sends explicit current CNY allocation with a reason', async () => {
  state.api.mockImplementation(async (url, init) => {
    if (init?.method) return {}
    if (url.endsWith('/budget')) return { groupId: 'g', periodId: null, periodKey: 'TOTAL', budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai', unlimited: false, limitCny: '0', defaultLimitCny: '0', spentCny: '0', reservedCny: '0', uncertainCny: '0', availableCny: '0' }
    if (url.endsWith('/model-options')) return []
    if (url.includes('/members') || url.includes('/users') || url.includes('/budget-entries') || url.includes('/budget-applications')) return { items: [], total: 0, offset: 0, limit: 20 }
    return { id: 'g', name: '测试组', enabled: true, type: 'PROJECT', archivedAt: null }
  })
  const w = mount(UsageGroupDetail, { global: { stubs: { teleport: true, RouterLink: true } } }); await flushPromises()
  await w.get('[data-tab="members"]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('暂无成员')
  await w.get('[data-tab="budget"]').trigger('click'); await flushPromises()
  await w.get('[aria-label="调整额度"]').setValue('10.00000001')
  await w.get('[aria-label="调整原因"]').setValue('研发测试')
  await w.get('#budget-adjust-form').trigger('submit'); await flushPromises()
  const body = JSON.parse(state.api.mock.calls.find(([url, init]) => url.endsWith('/budget-adjustments') && init?.method)?.[1].body)
  expect(body).toMatchObject({ scope: 'CURRENT', limitCny: '10.00000001', unlimited: false, reason: '研发测试' })
  expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/)
  w.unmount()
})
