// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import Profile from '../../apps/admin/src/views/Profile.vue'

const state = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
const principal = { id: 'me', displayName: '员工', email: 'me@example.invalid', organizationId: 'org', organizationName: '测试组织', role: 'MEMBER', status: 'ACTIVE' }
const wrappers: ReturnType<typeof mount>[] = []
beforeEach(() => { state.api.mockReset(); state.api.mockResolvedValue([]) })
afterEach(() => wrappers.splice(0).forEach(w => w.unmount()))
async function render(tab = 'basic', role = 'MEMBER') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/profile', component: Profile }, { path: '/usage', component: { template: '<div />' } }, { path: '/analytics', component: { template: '<div />' } }] })
  await router.push({ path: '/profile', query: { tab } }); await router.isReady()
  const w = mount(Profile, { props: { principal: { ...principal, role } }, global: { plugins: [router], stubs: { EmployeeKeysPanel: { props: ['managed', 'accountId'], template: '<div data-key-panel>{{ managed ? "组织模式" : "本人模式" }}</div>' }, KeyConnectionHelp: true, teleport: true } } })
  wrappers.push(w); await flushPromises(); return { w, router }
}
it('shows six tabs and only updates the display name, notifying the parent', async () => {
  const { w } = await render()
  expect(w.findAll('[aria-label="个人中心导航"] a')).toHaveLength(6)
  await w.get('[aria-label="显示名称"]').setValue('新名字')
  await w.get('[data-profile-form]').trigger('submit'); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ displayName: '新名字' }) })
  expect(w.emitted('profile-updated')).toHaveLength(1)
  expect(w.text()).toContain('me@example.invalid')
})
it('opens API Keys directly, defaults admins to own keys, and unmounts the panel on tab exit', async () => {
  const { w, router } = await render('api-keys', 'ORG_ADMIN')
  expect(w.find('[data-key-panel]').text()).toBe('本人模式')
  await w.get('[data-scope="organization"]').trigger('click')
  expect(w.find('[data-key-panel]').text()).toBe('组织模式')
  await router.push('/profile?tab=security'); await flushPromises()
  expect(w.find('[data-key-panel]').exists()).toBe(false)
  await router.push('/profile?tab=api-keys'); await flushPromises()
  expect(w.find('[data-key-panel]').text()).toBe('本人模式')
})
it('does not offer organization key management to members and falls back for unknown tabs', async () => {
  const { w, router } = await render('api-keys')
  expect(w.find('[data-scope="organization"]').exists()).toBe(false)
  await router.push('/profile?tab=unknown'); await flushPromises()
  expect(w.find('[data-profile-form]').exists()).toBe(true)
})
it('validates passwords, keeps API errors visible, and only emits success after completion', async () => {
  const { w } = await render('security')
  await w.get('[aria-label="当前密码"]').setValue('old-password')
  await w.get('[aria-label="新密码"]').setValue('new-password')
  await w.get('[aria-label="确认新密码"]').setValue('different')
  await w.get('[data-password-form]').trigger('submit')
  expect(state.api).not.toHaveBeenCalled()
  expect(w.text()).toContain('两次新密码不一致')
  await w.get('[aria-label="确认新密码"]').setValue('new-password')
  state.api.mockRejectedValueOnce(new Error('原密码错误'))
  await w.get('[data-password-form]').trigger('submit'); await flushPromises()
  expect(w.text()).toContain('原密码错误')
  expect(w.emitted('password-changed')).toBeUndefined()
  state.api.mockResolvedValueOnce({})
  await w.get('[data-password-form]').trigger('submit'); await flushPromises()
  expect(w.emitted('password-changed')).toHaveLength(1)
})
it('shows led groups with budget cards, drills into usage, and submits applications', async () => {
  const budget = { groupId: 'g1', periodId: 'p', periodKey: 'TOTAL', budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai',
    unlimited: false, defaultUnlimited: false, defaultLimitCny: '5000', limitCny: '5000', spentCny: '1200', reservedCny: '0', uncertainCny: '0', availableCny: '3800' }
  const metric = { requests: 10, successes: 9, inputTokens: 100, outputTokens: 20, costCny: '1.50000000', avgDurationMs: 100, p95DurationMs: 200 }
  state.api.mockImplementation(async (url: string, init?: any) => {
    if (init?.method === 'POST') return {}
    if (url === '/api/v1/me/led-groups') return [{ id: 'g1', name: '省厅项目', type: 'PROJECT', description: '', enabled: true, archivedAt: null, joinedAt: '2026-09-01T00:00:00Z', budget }]
    if (url.includes('/usage?')) return { range: { start: '', end: '' }, overview: metric, byAccount: [{ id: 'a', name: '张三', ...metric }], byModel: [], items: [], total: 0, limit: 20, offset: 0 }
    if (url.includes('/budget-applications')) return { items: [{ id: 'app', createdAt: '2026-09-17T00:00:00Z', requestedCny: '2000', status: 'REGISTERED', approvedCny: null, reason: '首期' }], total: 1, offset: 0, limit: 20 }
    return []
  })
  const { w } = await render('led-groups')
  expect(w.text()).toContain('省厅项目')
  await w.get('[data-open-led]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('张三')
  expect(w.text()).toContain('待批复')
  expect(state.api.mock.calls.some(([url]) => String(url).includes('/api/v1/me/led-groups/g1/usage'))).toBe(true)
  const inputs = w.findAll('[data-led-application] input')
  await inputs[0].setValue('3000'); await inputs[1].setValue('追加预算')
  await w.get('[data-led-application]').trigger('submit'); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/me/led-groups/g1/budget-applications', { method: 'POST', body: JSON.stringify({ requestedCny: '3000', reason: '追加预算' }) })
})

it('tells members without leadership that the led-groups tab is empty', async () => {
  const { w } = await render('led-groups')
  expect(state.api).toHaveBeenCalledWith('/api/v1/me/led-groups')
  expect(w.text()).toContain('您还不是任何组织的负责人')
})

it('keeps group errors distinct from an empty list and previews models only on demand', async () => {
  state.api.mockRejectedValueOnce(new Error('无法连接'))
  const { w } = await render('groups')
  expect(w.text()).toContain('无法连接'); expect(w.text()).not.toContain('暂无组织')
  state.api.mockResolvedValueOnce([{ id: 'g', name: '研发', type: 'PROJECT', enabled: true, archivedAt: null, joinedAt: '2026-09-01T00:00:00Z' }])
  await w.get('[data-retry]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('研发')
  state.api.mockResolvedValueOnce([{ id: 'model', displayName: '模型', protocols: ['openai_chat'] }])
  await w.get('[data-models]').trigger('click'); await flushPromises()
  expect(state.api).toHaveBeenLastCalledWith('/api/v1/me/profile/usage-groups/g/models')
  expect(w.text()).toContain('模型')
})
it('reads own usage and preserves date and identity scope in log links', async () => {
  state.api.mockResolvedValue({
    overview: { requests: 2, inputTokens: '12', outputTokens: '8', costCny: '0.1', estimatedCostCny: '0.02', unsettledRequests: 1 },
    groups: { items: [{ id: null, name: '历史未分组', requests: 2, totalTokens: '20', costCny: '0.1' }], total: 1, limit: 20, offset: 0 },
    projects: [{ id: 'p1', code: 'P1', name: '省厅项目', category: 'BUSINESS', budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai', region: { id: 'g1', name: '省厅区域' },
      budget: { limitCny: '100', spentCny: '20', reservedCny: '5', uncertainCny: '0', availableCny: '75', unlimited: false, usagePercent: 25 },
      usage: { requests: 2, totalTokens: '20', costCny: '0.1' }, shares: { budgetPercent: 0.1, projectUsagePercent: 0.4 } }],
    keys: [{ id: 'k1', name: 'CLI Key', secretHint: '…abcd', status: 'active', expiresAt: null, lastUsedAt: '2026-09-20T00:00:00Z', group: { id: 'g1', name: '省厅区域' }, project: { id: 'p1', code: 'P1', name: '省厅项目' }, usage: { requests: 2, totalTokens: '20', costCny: '0.1' }, shares: { ownUsagePercent: 100, projectBudgetPercent: 0.1 } }],
    summary: { projectCount: 1, keyCount: 1, activeKeyCount: 1, unlimitedProjectCount: 0, totalLimitCny: '100', totalSpentCny: '20', totalReservedCny: '5', totalOccupiedCny: '25', totalAvailableCny: '75', totalUsagePercent: 25, ownUsagePercentOfTotalBudget: 0.1, ownUsage: { requests: 2, totalTokens: '20', costCny: '0.1' } }
  })
  const { w, router } = await render('usage', 'PLATFORM_ADMIN')
  expect(state.api.mock.calls[0][0]).toMatch(/^\/api\/v1\/me\/profile\/usage\?/)
  expect(w.text()).toContain('历史未分组'); expect(w.text()).toContain('待核对')
  expect(w.text()).toContain('项目总额度'); expect(w.text()).toContain('所在项目用量汇总'); expect(w.text()).toContain('我的 API Key 使用情况')
  expect(w.get('[data-usage-projects]').text()).toContain('省厅项目'); expect(w.get('[data-usage-keys]').text()).toContain('CLI Key')
  await w.get('[data-usage-logs]').trigger('click'); await flushPromises()
  expect(router.currentRoute.value.path).toBe('/usage')
  expect(router.currentRoute.value.query).toMatchObject({ accountId: 'me', organizationId: 'org', timezone: 'Asia/Shanghai' })
  expect(router.currentRoute.value.query.start).toBeTruthy()
})

it('does not display stale group results after changing tabs and identity', async () => {
  let resolve!: (value: unknown) => void
  state.api.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const { w, router } = await render('groups')
  await router.push('/profile?tab=basic'); await w.setProps({ principal: { ...principal, id: 'other', displayName: '另一人' } })
  resolve([{ id: 'old', name: '旧身份私有组', type: 'PROJECT', enabled: true }]); await flushPromises()
  expect(w.text()).not.toContain('旧身份私有组')
  expect(w.get<HTMLInputElement>('[aria-label="显示名称"]').element.value).toBe('另一人')
  state.api.mockResolvedValueOnce([])
  await router.push('/profile?tab=groups'); await flushPromises()
  expect(w.text()).toContain('暂无组织')
})
