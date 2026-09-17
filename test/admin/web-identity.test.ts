// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../../apps/admin/src/App.vue'
const state = vi.hoisted(() => ({ api: vi.fn(), route: { meta: {}, name: 'users' }, push: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({ useRoute: () => state.route, useRouter: () => ({ push: state.push }) }))
it('waits for server identity and never mounts admin content for a member with a forged admin token', async () => {
  localStorage.setItem('ucli.accessToken', 'unverified.admin.claim')
  let resolve!: (v: unknown) => void
  state.api.mockImplementation(() => new Promise(r => { resolve = r }))
  const w = mount(App, { global: { stubs: { RouterView: { template: '<div data-admin-page>管理内容</div>' } } } })
  expect(w.find('[data-admin-page]').exists()).toBe(false)
  resolve({ id: 'me', displayName: '员工', organizationId: 'org', role: 'MEMBER' }); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/auth/me')
  expect(w.find('[data-admin-page]').exists()).toBe(false)
  expect(w.find('nav').text()).not.toContain('我的接入')
  expect(w.find('aside').text()).toContain('个人中心')
  expect(w.find('nav').text()).not.toContain('API Keys')
  expect(w.find('nav').text()).not.toContain('用户管理')
  w.unmount(); localStorage.clear()
})

it.each(['profile', 'my-access'])('allows the hidden own route %s without redirecting', async name => {
  state.route.name = name; state.push.mockClear()
  localStorage.setItem('ucli.accessToken', 'web-session')
  state.api.mockResolvedValue({ id: 'me', displayName: '员工', organizationId: 'org', role: 'MEMBER' })
  const w = mount(App, { global: { stubs: { RouterView: { template: '<div data-own-page>本人页面</div>' } } } })
  await flushPromises()
  expect(w.find('[data-own-page]').exists()).toBe(true)
  expect(state.push).not.toHaveBeenCalled()
  expect(w.find('nav').text()).not.toContain('我的接入')
  w.unmount(); localStorage.clear()
})

it('lands members on their profile and uses it for denied-page recovery', async () => {
  state.route.name = 'overview'; state.push.mockClear()
  localStorage.setItem('ucli.accessToken', 'web-session')
  state.api.mockResolvedValue({ id: 'me', displayName: '员工', organizationId: 'org', role: 'MEMBER' })
  const w = mount(App, { global: { stubs: { RouterView: true } } })
  await flushPromises()
  expect(state.push).toHaveBeenCalledWith('/profile')
  await w.get('.content button').trigger('click')
  expect(state.push).toHaveBeenLastCalledWith('/profile')
  w.unmount(); localStorage.clear()
})
