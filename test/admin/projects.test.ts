// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import Projects from '../../apps/admin/src/views/Projects.vue'
import ProjectDetail from '../../apps/admin/src/views/ProjectDetail.vue'

const state = vi.hoisted(() => ({ api: vi.fn(), url: '' }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'project-1' } }),
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

it('shows project budget and keys without exposing a secret', async () => {
  window.history.replaceState({}, '', '/projects/project-1')
  state.api.mockImplementation(async (url: string) => {
    if (url.endsWith('/budget')) return { projectId: 'project-1', periodId: 'period', periodKey: 'TOTAL',
      budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai', unlimited: false, limitCny: '100',
      spentCny: '20', reservedCny: '5', uncertainCny: '0', availableCny: '75' }
    if (url.includes('api-keys')) return { ...page, items: [{ id: 'key-1', name: '项目 Key', secretHint: '…abcd',
      account: { displayName: '员工' } }] }
    return { id: 'project-1', organizationId: 'org', regionId: 'region', code: 'GD-YX', name: '越秀',
      description: '', status: 'ACTIVE', budgetMode: 'TOTAL', budgetTimezone: 'Asia/Shanghai',
      region: { id: 'region', name: '广东-市局区域' }, members: [] }
  })
  const wrapper = render(ProjectDetail)
  await flushPromises()
  console.log('api-calls', JSON.stringify(state.api.mock.calls.map(call => call[0])))
  await wrapper.findAll('button').find(button => button.text() === '预算')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('额度：¥100')
  await wrapper.findAll('button').find(button => button.text() === '项目 Key')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('项目 Key')
  expect(wrapper.text()).toContain('…abcd')
  expect(wrapper.text()).not.toContain('ucli_sk_')
})
