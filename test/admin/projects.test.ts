// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import Projects from '../../apps/admin/src/views/Projects.vue'
import ProjectDetail from '../../apps/admin/src/views/ProjectDetail.vue'

const state = vi.hoisted(() => ({ api: vi.fn(), url: '' }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'project-1' }, query: {} }),
  useRouter: () => ({ push: vi.fn() })
}))
const page = { items: [], total: 0, offset: 0, limit: 20 }
const wrappers: ReturnType<typeof mount>[] = []
const render = (component: any, props = {}) => {
  const wrapper = mount(component, { props, global: { stubs: { teleport: true } } })
  wrappers.push(wrapper)
  return wrapper
}

beforeEach(() => { state.api.mockReset(); window.history.replaceState({}, '', '/') })
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

it('lists projects and filters by name', async () => {
  state.api.mockImplementation(async (url: string) => {
    state.url = url
    return { ...page, items: [{ id: 'project-1', code: 'GD-YX', name: '越秀', status: 'ACTIVE',
      region: { id: 'region-1', name: '广东-市局区域' }, members: [] }] }
  })
  const wrapper = render(Projects)
  await flushPromises()
  wrapper.get('[aria-label="搜索项目"]').setValue('越秀')
  await wrapper.find('form').trigger('submit'); await flushPromises()
  expect(wrapper.text()).toContain('越秀')
  expect(state.url).toContain('q=%E8%B6%8A%E7%A7%80')
})

it('shows project keys masked by default and reveals the secret after password verification', async () => {
  window.history.replaceState({}, '', '/projects/project-1')
  state.api.mockImplementation(async (url: string) => {
    if (url.endsWith('/budget')) return { projectId: 'project-1', periodId: 'period', periodKey: 'TOTAL',
      budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai', unlimited: false, limitCny: '100',
      spentCny: '20', reservedCny: '5', uncertainCny: '0', availableCny: '75' }
    if (url.includes('api-keys/key-1/reveal')) return { id: 'key-1', secret: 'ucli_sk_revealed_secret' }
    if (url.includes('api-keys')) return { ...page, items: [
      { id: 'key-1', name: '项目 Key', secretHint: '…abcd', secretRecoverable: true,
      account: { displayName: '员工', email: 'employee@example.invalid' }, expiresAt: null, disabledAt: null,
      revokedAt: null, lastUsedAt: '2026-09-19T01:02:03Z', createdAt: '2026-09-18T01:02:03Z' },
      { id: 'key-2', name: '第二把 Key', secretHint: '…efgh', secretRecoverable: true,
        account: { displayName: '员工', email: 'employee@example.invalid' }, expiresAt: null, disabledAt: null,
        revokedAt: null, lastUsedAt: null, createdAt: '2026-09-18T01:02:03Z' }
    ] }
    return { id: 'project-1', organizationId: 'org', regionId: 'region', code: 'GD-YX', name: '越秀',
      description: '', status: 'ACTIVE', budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai',
      region: { id: 'region', name: '广东-市局区域' }, members: [] }
  })
  const wrapper = render(ProjectDetail)
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '预算')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('额度：¥100')
  await wrapper.findAll('button').find(button => button.text() === '项目 Key')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('项目 Key')
  expect(wrapper.text()).toContain('…abcd')
  expect(wrapper.text()).not.toContain('ucli_sk_')
  await wrapper.findAll('button').find(button => button.text() === '查看')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('项目 Key 详情')
  expect(wrapper.text()).toContain('employee@example.invalid')
  expect(wrapper.text()).toContain('不设到期时间')
  expect(wrapper.text()).not.toContain('ucli_sk_')
  await wrapper.get('[aria-label="输入管理员密码"]').setValue('admin-password')
  await wrapper.get('[data-action="reveal-key"]').trigger('click')
  await flushPromises()
  const revealCall = state.api.mock.calls.find(([url, init]) => url.includes('api-keys/key-1/reveal'))
  expect(revealCall?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ password: 'admin-password' }) })
  expect(wrapper.get('[data-secret]').text()).toBe('ucli_sk_revealed_secret')
  expect(wrapper.text()).toContain('复制 Key')
  await wrapper.findAll('button').filter(button => button.text() === '查看').at(1)!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).not.toContain('ucli_sk_revealed_secret')
  expect(wrapper.text()).toContain('…efgh')
})

it('supports member management and platform administrator submit-and-approve', async () => {
  window.history.replaceState({}, '', '/projects/project-1?tab=members')
  state.api.mockImplementation(async (url: string, init?: any) => {
    if (url.includes('/budget-applications') && init?.method === 'POST') return { id: 'entry-1' }
    if (url.includes('/members') && init?.method === 'POST') return {}
    if (url.includes('/members')) return { items: [
      { accountId: 'employee-2', role: 'MEMBER', membership: { status: 'ACTIVE',
        account: { id: 'employee-2', displayName: '区域成员', email: 'member@example.invalid' } } }
    ], total: 1, offset: 0, limit: 100 }
    if (url.includes('/budget-applications')) return { items: [], total: 0, offset: 0, limit: 20 }
    if (url.includes('/budget')) return { projectId: 'project-1', periodId: 'period', periodKey: 'TOTAL',
      budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai', unlimited: false, limitCny: '100',
      spentCny: '20', reservedCny: '5', uncertainCny: '0', availableCny: '75' }
    if (url.includes('api-keys')) return { ...page, items: [] }
    return { id: 'project-1', organizationId: 'org', regionId: 'region-1', category: 'BUSINESS',
      code: 'GD-YX', name: '越秀', description: '', status: 'ACTIVE', budgetMode: 'TOTAL',
      budgetTimezone: 'Asia/Shanghai', region: { id: 'region-1', name: '广东-市局' },
      members: [{ accountId: 'employee-1', role: 'OWNER', membership: { account: { displayName: '负责人', email: 'owner@example.invalid' } } }] }
  })
  const wrapper = render(ProjectDetail)
  await flushPromises()
  expect(wrapper.text()).toContain('所属部门')
  await wrapper.get('[data-tab="members"]').trigger('click')
  await flushPromises()
  await wrapper.get('[aria-label="选择项目成员"]').setValue('employee-2')
  await wrapper.get('[data-action="add-project-member"]').trigger('click')
  await flushPromises()
  expect(state.api.mock.calls.find(([url, init]) => url.endsWith('/members') && init?.method === 'POST')?.[1].body)
    .toBe(JSON.stringify({ accountId: 'employee-2', role: 'CONTRIBUTOR' }))

  await wrapper.get('[data-tab="budget"]').trigger('click')
  await wrapper.get('[aria-label="申请后项目总额"]').setValue('150')
  await wrapper.get('[aria-label="预算申请原因"]').setValue('平台管理员批复项目预算')
  await wrapper.get('[data-action="submit-and-approve"]').trigger('click')
  await flushPromises()
  const body = JSON.parse(state.api.mock.calls.find(([url, init]) => url.includes('/budget-applications/submit-and-approve'))?.[1].body)
  expect(body).toMatchObject({ requestedTotalCny: '150', unlimited: false, reason: '平台管理员批复项目预算' })
  expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/)
})
