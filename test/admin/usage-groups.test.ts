// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { budgetLabel } from '../../apps/admin/src/usage-groups.js'
import UsageGroupDetail from '../../apps/admin/src/views/UsageGroupDetail.vue'
import UsageGroups from '../../apps/admin/src/views/UsageGroups.vue'
const state = vi.hoisted(() => ({ api: vi.fn(), route: { params: { id: 'g' }, query: {} } as { params: Record<string, string>; query: Record<string, string> }, routerPush: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({ useRoute: () => state.route, useRouter: () => ({ push: state.routerPush }) }))
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

it('shows the region project count and expands project budget, people and key details', async () => {
  state.route = { query: {}, params: {} }
  state.api.mockImplementation(async () => ({
    items: [{
      id: 'region-1', name: '广东-市局区域', type: 'REGION', enabled: true, archivedAt: null,
      description: '', budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai', unlimited: false,
      defaultLimitCny: '0', _count: { members: 12, models: 3 }, activeMembers: 12, activeKeys: 8,
      budget: { groupId: 'region-1', periodId: null, periodKey: 'TOTAL', budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai',
        unlimited: false, defaultUnlimited: false, defaultLimitCny: '0', limitCny: '0',
        spentCny: '0', reservedCny: '0', uncertainCny: '0', availableCny: '0' },
      projects: [
        { id: 'project-1', regionId: 'region-1', code: 'GD-YX', name: '越秀', status: 'ACTIVE',
          memberCount: 6, activeKeyCount: 4, owners: [{ accountId: 'employee-1', displayName: '负责人' }],
          budget: { projectId: 'project-1', periodId: 'period-1', periodKey: 'TOTAL', budgetMode: 'TOTAL',
            budgetTimezone: 'Asia/Shanghai', unlimited: false, limitCny: '1800', spentCny: '200',
            reservedCny: '100', uncertainCny: '0', availableCny: '1500' } }
      ]
    }], total: 1, offset: 0, limit: 20
  }))
  const wrapper = mount(UsageGroups, { global: { stubs: { teleport: true, RouterLink: true } } })
  await flushPromises()
  expect(wrapper.text()).toContain('关联项目')
  expect(wrapper.text()).toContain('1 个项目')
  await wrapper.get('[data-action="toggle-region-projects"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('越秀')
  expect(wrapper.text()).toContain('项目额度¥1800')
  expect(wrapper.text()).toContain('已用 / 预占¥200 / ¥100')
  expect(wrapper.text()).toContain('负责人：负责人')
  expect(wrapper.text()).toContain('有效 Key 4')
  await wrapper.get('[data-action="view-project-keys"]').trigger('click')
  expect(state.routerPush).toHaveBeenCalledWith({ path: '/projects/project-1', query: { tab: 'keys' } })
  wrapper.unmount()
})

it('shows region projects and member project usage in the usage group detail page', async () => {
  state.route = { query: {}, params: { id: 'region-1' } }
  state.api.mockImplementation(async (url: string) => {
    if (url.endsWith('/budget')) return { groupId: 'region-1', periodId: null, periodKey: 'TOTAL', budgetMode: 'TOTAL',
      budgetTimezone: 'Asia/Shanghai', unlimited: false, defaultUnlimited: false, defaultLimitCny: '0', limitCny: '0',
      spentCny: '0', reservedCny: '0', uncertainCny: '0', availableCny: '0' }
    if (url.endsWith('/projects')) return { items: [
      { id: 'project-1', regionId: 'region-1', code: 'GZ-YX', name: '云岩', status: 'ACTIVE', memberCount: 2,
        activeKeyCount: 3, owners: [{ accountId: 'employee-1', displayName: '负责人' }],
        budget: { projectId: 'project-1', periodId: 'period-1', periodKey: 'TOTAL', budgetMode: 'TOTAL',
          budgetTimezone: 'Asia/Shanghai', unlimited: false, limitCny: '2000', spentCny: '100', reservedCny: '20',
          uncertainCny: '0', availableCny: '1880' } }
    ], total: 1, offset: 0, limit: 20 }
    if (url.includes('/members')) return { items: [
      { accountId: 'employee-1', role: 'MEMBER', membership: { status: 'ACTIVE', account: { id: 'employee-1',
        displayName: '员工', email: 'employee@example.invalid', status: 'ACTIVE' } },
        projects: [{ id: 'project-1', code: 'GZ-YX', name: '云岩', sources: ['KEY'] }],
        usage: { requests: 8, totalTokens: '12345', costCny: '12.50000000', lastUsedAt: '2026-09-19T01:02:03Z' } }
    ], total: 1, offset: 0, limit: 20 }
    if (url.includes('/budget-entries') || url.includes('/budget-applications') || url.includes('/users')) return { items: [], total: 0, offset: 0, limit: 20 }
    return { id: 'region-1', name: '贵州区域', type: 'REGION', enabled: true, archivedAt: null,
      description: '', budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai', unlimited: false, defaultLimitCny: '0' }
  })
  const wrapper = mount(UsageGroupDetail, { global: { stubs: { teleport: true, RouterLink: true } } })
  await flushPromises()
  await wrapper.get('[data-tab="projects"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('关联项目')
  expect(wrapper.text()).toContain('云岩')
  expect(wrapper.text()).toContain('项目额度')
  expect(wrapper.text()).toContain('¥2000')
  expect(wrapper.text()).toContain('职责成员 2')
  expect(wrapper.text()).toContain('有效 Key')
  expect(wrapper.findAll('tbody tr')[0].text()).toContain('3')
  await wrapper.get('[data-action="view-project-keys"]').trigger('click')
  expect(state.routerPush).toHaveBeenCalledWith({ path: '/projects/project-1', query: { tab: 'keys' } })
  await wrapper.get('[data-tab="members"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('所属项目')
  expect(wrapper.text()).toContain('云岩（Key）')
  expect(wrapper.text()).toContain('8 次')
  expect(wrapper.text()).toContain('12,345')
  expect(wrapper.text()).toContain('¥12.50')
  wrapper.unmount()
})
