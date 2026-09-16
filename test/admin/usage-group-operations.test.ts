// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import UsageGroups from '../../apps/admin/src/views/UsageGroups.vue'
import UsageGroupDetail from '../../apps/admin/src/views/UsageGroupDetail.vue'

const state = vi.hoisted(() => ({ api: vi.fn(), route: null as any, replace: vi.fn(), push: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({ useRoute: () => state.route, useRouter: () => ({ replace: state.replace, push: state.push }) }))
const budget = { groupId: 'g', periodId: 'p', periodKey: '2026-09', budgetMode: 'MONTHLY', budgetTimezone: 'Asia/Shanghai', unlimited: false, defaultUnlimited: false, defaultLimitCny: '0', limitCny: '7', spentCny: '5.6', reservedCny: '0', uncertainCny: '0', availableCny: '1.4' }
const group = { id: 'g', name: '测试组', description: '', type: 'PROJECT', enabled: true, archivedAt: null, budgetMode: 'MONTHLY', budgetTimezone: 'Asia/Shanghai', unlimited: false, defaultLimitCny: '0', budget, _count: { members: 2, models: 3 }, activeMembers: 2, activeKeys: 0 }
const page = (items: any[] = []) => ({ items, total: items.length, offset: 0, limit: 20 })
const entry = { id: 'entry', requestId: 'old-request', operationId: 'request:old-request', startedAt: '2025-02-01T17:00:00.000Z', periodId: 'old-period', kind: 'REQUEST', status: 'RECONCILIATION_REQUIRED', reservedCny: '2', settledCny: '0', reason: null }
const wrappers: ReturnType<typeof mount>[] = []
function render(component: any) {
  const wrapper = mount(component, { global: { stubs: { teleport: true, RouterLink: true, TrendChart: { props: ['data', 'metric', 'timezone'], template: '<div data-chart>{{ data }}</div>' } } } })
  wrappers.push(wrapper); return wrapper
}
beforeEach(() => {
  state.route = reactive({ params: { id: 'g' }, query: {} })
  state.api.mockImplementation(async (url: string, init?: any) => {
    if (init?.method) return {}
    if (url.startsWith('/api/v1/admin/usage-groups?')) return page([group])
    if (url.endsWith('/budget')) return budget
    if (url.includes('/budget-entries?')) return page([entry])
    if (url.includes('/members?') || url.includes('/users?')) return page()
    if (url.includes('/analytics/timeseries?')) return [{ bucket: '2026-09-15T16:00:00Z', costCny: '5.6', requestSuccessRate: 1 }]
    if (url.includes('/analytics/breakdown?')) return page([{ id: 'a', name: '员工甲', requests: 2, totalTokens: '10', costCny: '5.6' }])
    if (url.includes('/usage/logs-page?')) return page([{ id: 'log', requestId: 'old-request', groupId: 'g' }])
    if (url.includes('/usage/logs/log?')) return { id: 'log', requestId: 'old-request', groupId: 'g', groupName: '测试组', routes: [] }
    return group
  })
})
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.clearAllMocks() })

it('renders inline budgets without N+1 reads and counts unknown holds only within reserved', async () => {
  state.api.mockResolvedValue(page([{ ...group, budget: { ...budget, reservedCny: '1', uncertainCny: '1', availableCny: '0.4' } }]))
  const w = render(UsageGroups); await flushPromises()
  expect(state.api.mock.calls.some(([url]) => /\/usage-groups\/[^/]+\/budget\b/.test(url))).toBe(false)
  expect(w.text()).toContain('当前周期')
  expect(w.text().match(/待核算（包含在预占内）/g)).toHaveLength(1)
  expect(w.text()).toContain('可用 ¥0.4')
  expect(w.text()).toContain('有效成员 2')
  expect(w.text()).toContain('员工 Key 0')
  expect(w.text()).not.toContain('不可用')
})

it('marks the group table for horizontal scrolling and the drawer submit as primary', async () => {
  const w = render(UsageGroups); await flushPromises()
  expect(w.find('table.usage-groups-table').exists()).toBe(true)
  await w.get('header.page-header button').trigger('click')
  expect(w.get('button[form="create-group-form"]').classes()).toContain('primary')
})

it('restores and applies all list filters including budget risk on route changes', async () => {
  state.route.query = { q: '研发', type: 'DEPARTMENT', status: 'all', budgetRisk: 'NEAR_LIMIT' }
  const w = render(UsageGroups); await flushPromises()
  expect(Object.fromEntries(new URL(state.api.mock.calls[0][0], 'http://test').searchParams)).toMatchObject(state.route.query)
  expect(w.get<HTMLSelectElement>('[aria-label="预算风险"]').element.value).toBe('NEAR_LIMIT')
  await w.get('[aria-label="预算风险"]').setValue('UNSETTLED'); await w.get('form').trigger('submit'); await flushPromises()
  expect(state.replace).toHaveBeenLastCalledWith({ query: expect.objectContaining({ q: '研发', type: 'DEPARTMENT', status: 'all', budgetRisk: 'UNSETTLED' }) })
  state.route.query = { budgetRisk: 'EXHAUSTED' }; await flushPromises()
  expect(new URL(state.api.mock.calls.at(-1)![0], 'http://test').searchParams.get('budgetRisk')).toBe('EXHAUSTED')
})

it('warns at exactly 80%, distinguishes zero and unlimited, and preserves negative availability', async () => {
  state.api.mockResolvedValue(page([
    group,
    { ...group, id: 'zero', name: '零额组', budget: { ...budget, limitCny: '0', spentCny: '0', availableCny: '0' } },
    { ...group, id: 'over', name: '超额组', enabled: false, activeMembers: 0, _count: { members: 0, models: 0 }, budget: { ...budget, spentCny: '8', availableCny: '-1' } },
    { ...group, id: 'unlimited', name: '不限组', budget: { ...budget, unlimited: true, availableCny: null } }
  ]))
  const w = render(UsageGroups); await flushPromises()
  const rows = w.findAll('tbody tr')
  expect(rows[0].text()).toContain('接近额度上限')
  expect(rows[1].text()).toContain('零额度'); expect(rows[1].text()).toContain('额度已耗尽')
  expect(rows[2].text()).toContain('¥-1'); expect(rows[2].text()).toContain('组已停用'); expect(rows[2].text()).toContain('未配置模型'); expect(rows[2].text()).toContain('无有效成员')
  expect(rows[3].text()).toContain('不限额'); expect(rows[3].text()).not.toContain('额度已耗尽')
})

it('loads analysis lazily for the fixed group, only fetches the selected rank, and keeps budget period independent', async () => {
  state.route.query = { groupId: 'foreign', groupScope: 'UNGROUPED' }
  const w = render(UsageGroupDetail); await flushPromises()
  expect(state.api.mock.calls.some(([url]) => url.includes('/analytics/'))).toBe(false)
  await w.get('[data-tab="analysis"]').trigger('click'); await flushPromises()
  const calls = state.api.mock.calls.filter(([url]) => url.includes('/analytics/'))
  expect(calls).toHaveLength(2)
  for (const [url] of calls) {
    const query = new URL(url, 'http://test').searchParams
    expect(query.get('groupId')).toBe('g'); expect(query.has('groupScope')).toBe(false)
    expect(query.get('timezone')).toBe('Asia/Shanghai')
    expect(new Date(query.get('end')!).getTime() - new Date(query.get('start')!).getTime()).toBe(7 * 86_400_000)
  }
  expect(new URL(calls[1][0], 'http://test').searchParams.get('dimension')).toBe('account')
  expect(w.text()).toContain('员工甲')
  const count = state.api.mock.calls.length
  await w.get('[aria-label="排行维度"]').setValue('model'); await flushPromises()
  expect(state.api.mock.calls.slice(count)).toHaveLength(1)
  expect(new URL(state.api.mock.calls.at(-1)![0], 'http://test').searchParams.get('dimension')).toBe('model')
  await w.get('[aria-label="分析开始日期"]').setValue('2025-01-01'); await w.get('[aria-label="分析结束日期"]').setValue('2025-01-02')
  await w.get('#group-analysis-form').trigger('submit'); await flushPromises()
  expect(w.text()).toContain('当前周期 · 2026-09')
  await w.get('[data-tab="budget"]').trigger('click'); await w.get('[aria-label="调整原因"]').setValue('验证幂等')
  await w.get('#budget-adjust-form').trigger('submit'); await flushPromises()
  const analyticsCount = state.api.mock.calls.filter(([url]) => url.includes('/analytics/')).length
  await w.get('[data-tab="analysis"]').trigger('click'); await flushPromises()
  expect(state.api.mock.calls.filter(([url]) => url.includes('/analytics/'))).toHaveLength(analyticsCount)
})

it('keeps successful ranks visible when trend loading fails and rejects analysis ranges over 90 days', async () => {
  const original = state.api.getMockImplementation()!
  state.api.mockImplementation((url: string) => url.includes('/timeseries?') ? Promise.reject(new Error('趋势暂不可用')) : original(url))
  const w = render(UsageGroupDetail); await flushPromises()
  await w.get('[data-tab="analysis"]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('趋势暂不可用'); expect(w.text()).toContain('员工甲')
  const count = state.api.mock.calls.length
  await w.get('[aria-label="分析开始日期"]').setValue('2025-01-01'); await w.get('[aria-label="分析结束日期"]').setValue('2025-04-01')
  await w.get('#group-analysis-form').trigger('submit'); await flushPromises()
  expect(w.text()).toContain('统计范围不能超过 90 天'); expect(state.api.mock.calls).toHaveLength(count)
})

it('opens full analytics with the pinned group, applied dates and selected dimension only', async () => {
  state.route.query = { groupId: 'foreign', groupScope: 'UNGROUPED', start: '2020-01-01', channelId: 'foreign-channel' }
  const w = render(UsageGroupDetail); await flushPromises()
  await w.get('[data-tab="analysis"]').trigger('click'); await flushPromises()
  await w.get('[aria-label="分析开始日期"]').setValue('2025-01-01'); await w.get('[aria-label="分析结束日期"]').setValue('2025-01-02')
  await w.get('#group-analysis-form').trigger('submit'); await flushPromises()
  await w.get('[aria-label="排行维度"]').setValue('apiKey'); await flushPromises()
  await w.get('[aria-label="分析开始日期"]').setValue('2025-02-01')
  await w.get('[aria-label="查看完整分析"]').trigger('click')
  const target = state.push.mock.calls.at(-1)![0]
  expect(target.path).toBe('/analytics')
  expect(target.query).toEqual({ groupId: 'g', start: '2024-12-31T16:00:00.000Z', end: '2025-01-02T16:00:00.000Z', timezone: 'Asia/Shanghai', dimension: 'apiKey' })
})

it('labels retained settled and released reservations as historical and open reservations as current', async () => {
  const original = state.api.getMockImplementation()!
  state.api.mockImplementation((url: string) => url.includes('/budget-entries?') ? Promise.resolve(page(
    ['SETTLED', 'RELEASED', 'RESERVED', 'RECONCILIATION_REQUIRED'].map(status => ({ ...entry, id: status, status }))
  )) : original(url))
  const w = render(UsageGroupDetail); await flushPromises(); await w.get('[data-tab="budget"]').trigger('click')
  const rows = w.findAll('tbody tr')
  for (const row of rows.slice(0, 2)) expect(row.text()).toContain('历史预留 ¥2')
  for (const row of rows.slice(2)) expect(row.text()).toContain('当前保留 ¥2')
})

it('opens historical ledger request detail with fixed group and exact entry-day bounds', async () => {
  state.route.query = { groupId: 'foreign', requestId: 'other' }
  const w = render(UsageGroupDetail); await flushPromises(); await w.get('[data-tab="budget"]').trigger('click')
  expect(w.text()).toContain('待核算'); expect(w.text()).not.toContain('RECONCILIATION_REQUIRED')
  await w.get('[aria-label="查看请求 old-request 详情"]').trigger('click'); await flushPromises()
  for (const [url] of state.api.mock.calls.filter(([url]) => url.includes('/usage/logs'))) {
    expect(Object.fromEntries(new URL(url, 'http://test').searchParams)).toMatchObject({ groupId: 'g', requestId: 'old-request', start: '2025-02-01T16:00:00.000Z', end: '2025-02-02T16:00:00.000Z', timezone: 'Asia/Shanghai' })
  }
  expect(state.api.mock.calls.some(([url]) => url.includes('/usage/logs/log?'))).toBe(true)
})

it('shows not found without opening another group or request and clears old group data on navigation', async () => {
  const original = state.api.getMockImplementation()!
  state.api.mockImplementation((url: string) => url.includes('/usage/logs-page?') ? Promise.resolve(page([{ id: 'foreign', requestId: 'old-request', groupId: 'foreign' }])) : original(url))
  const w = render(UsageGroupDetail); await flushPromises(); await w.get('[data-tab="budget"]').trigger('click')
  await w.get('[aria-label="查看请求 old-request 详情"]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('未找到该组的请求记录')
  expect(state.api.mock.calls.some(([url]) => url.includes('/usage/logs/foreign'))).toBe(false)
  state.api.mockRejectedValue(new Error('新组加载失败')); state.route.params.id = 'new'; await flushPromises()
  expect(w.text()).not.toContain('测试组'); expect(w.text()).not.toContain('old-request'); expect(w.text()).toContain('新组加载失败')
})

it('retries unchanged budget adjustments with the same operationId and starts a new ID after edits', async () => {
  const original = state.api.getMockImplementation()!
  state.api.mockImplementation((url: string, init?: any) => url.endsWith('/budget-adjustments') ? Promise.reject(new Error('重试')) : original(url, init))
  const w = render(UsageGroupDetail); await flushPromises(); await w.get('[data-tab="budget"]').trigger('click')
  await w.get('[aria-label="调整原因"]').setValue('预算审批')
  await w.get('#budget-adjust-form').trigger('submit'); await flushPromises()
  await w.get('#budget-adjust-form').trigger('submit'); await flushPromises()
  await w.get('[aria-label="调整额度"]').setValue('9')
  await w.get('#budget-adjust-form').trigger('submit'); await flushPromises()
  const bodies = state.api.mock.calls.filter(([url]) => url.endsWith('/budget-adjustments')).map(([, init]) => JSON.parse(init.body))
  expect(bodies[0]).toMatchObject({ scope: 'CURRENT', periodId: 'p', reason: '预算审批', limitCny: '7' })
  expect(bodies[0].operationId).toBe(bodies[1].operationId); expect(bodies[2].operationId).not.toBe(bodies[1].operationId)
})

it('clears previous list results when changed filters fail to load', async () => {
  const w = render(UsageGroups); await flushPromises(); expect(w.text()).toContain('测试组')
  state.api.mockRejectedValue(new Error('筛选失败')); state.route.query = { budgetRisk: 'EXHAUSTED' }; await flushPromises()
  expect(w.text()).toContain('筛选失败'); expect(w.text()).not.toContain('测试组')
})

it('keeps trend data when ranking fails and ignores late responses after changing groups', async () => {
  const original = state.api.getMockImplementation()!
  let resolveOld: (value: any) => void = () => {}
  state.api.mockImplementation((url: string) => url.includes('/breakdown?') ? Promise.reject(new Error('排行暂不可用')) : original(url))
  const w = render(UsageGroupDetail); await flushPromises(); await w.get('[data-tab="analysis"]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('排行暂不可用'); expect(w.get('[data-chart]').text()).toContain('5.6')
  state.api.mockImplementation((url: string) => {
    if (url.includes('/timeseries?') && new URL(url, 'http://test').searchParams.get('groupId') === 'g') return new Promise(resolve => { resolveOld = resolve })
    return url.endsWith('/new') ? Promise.resolve({ ...group, id: 'new', name: '新组' }) : original(url)
  })
  await w.get('#group-analysis-form').trigger('submit'); await flushPromises()
  state.route.params.id = 'new'; await flushPromises(); await w.get('[data-tab="analysis"]').trigger('click'); await flushPromises()
  resolveOld([{ bucket: '2025-01-01T00:00:00Z', costCny: '99999' }]); await flushPromises()
  expect(w.text()).toContain('新组'); expect(w.get('[data-chart]').text()).not.toContain('99999')
})

it('does not open a stale request lookup after changing groups', async () => {
  const original = state.api.getMockImplementation()!
  let resolveOld: (value: any) => void = () => {}
  state.api.mockImplementation((url: string) => url.includes('/logs-page?') ? new Promise(resolve => { resolveOld = resolve }) : original(url))
  const w = render(UsageGroupDetail); await flushPromises(); await w.get('[data-tab="budget"]').trigger('click')
  await w.get('[aria-label="查看请求 old-request 详情"]').trigger('click'); await flushPromises()
  state.route.params.id = 'new'; await flushPromises()
  resolveOld(page([{ id: 'log', requestId: 'old-request', groupId: 'g' }])); await flushPromises()
  expect(state.api.mock.calls.some(([url]) => url.includes('/usage/logs/log?'))).toBe(false)
})
