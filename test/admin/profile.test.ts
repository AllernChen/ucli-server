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
it('shows five tabs and only updates the display name, notifying the parent', async () => {
  const { w } = await render()
  expect(w.findAll('[aria-label="个人中心导航"] a')).toHaveLength(5)
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
it('keeps group errors distinct from an empty list and previews models only on demand', async () => {
  state.api.mockRejectedValueOnce(new Error('无法连接'))
  const { w } = await render('groups')
  expect(w.text()).toContain('无法连接'); expect(w.text()).not.toContain('暂无用量组')
  state.api.mockResolvedValueOnce([{ id: 'g', name: '研发', type: 'PROJECT', enabled: true, archivedAt: null, joinedAt: '2026-09-01T00:00:00Z' }])
  await w.get('[data-retry]').trigger('click'); await flushPromises()
  expect(w.text()).toContain('研发')
  state.api.mockResolvedValueOnce([{ id: 'model', displayName: '模型', protocols: ['openai_chat'] }])
  await w.get('[data-models]').trigger('click'); await flushPromises()
  expect(state.api).toHaveBeenLastCalledWith('/api/v1/me/profile/usage-groups/g/models')
  expect(w.text()).toContain('模型')
})
it('reads own usage and preserves date and identity scope in log links', async () => {
  state.api.mockResolvedValue({ overview: { requests: 2, inputTokens: '12', outputTokens: '8', costCny: '0.1', estimatedCostCny: '0.02', unsettledRequests: 1 }, groups: { items: [{ id: null, name: '历史未分组', requests: 2, totalTokens: '20', costCny: '0.1' }], total: 1, limit: 20, offset: 0 } })
  const { w, router } = await render('usage', 'PLATFORM_ADMIN')
  expect(state.api.mock.calls[0][0]).toMatch(/^\/api\/v1\/me\/profile\/usage\?/)
  expect(w.text()).toContain('历史未分组'); expect(w.text()).toContain('待核对')
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
  expect(w.text()).toContain('暂无用量组')
})
