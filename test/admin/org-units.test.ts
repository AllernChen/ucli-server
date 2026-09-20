// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import OrgUnitDetail from '../../apps/admin/src/views/OrgUnitDetail.vue'
import OrgUnits from '../../apps/admin/src/views/OrgUnits.vue'

const state = vi.hoisted(() => ({ api: vi.fn(), route: { params: { id: 'org-1' } as Record<string, string> }, routerPush: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({ useRoute: () => state.route, useRouter: () => ({ push: state.routerPush }) }))

const wrappers: ReturnType<typeof mount>[] = []
const render = (component: any) => {
  const wrapper = mount(component, { global: { stubs: { teleport: true, RouterLink: true } } })
  wrappers.push(wrapper)
  return wrapper
}

beforeEach(() => state.api.mockReset())
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

it('lists organization kinds and department projects', async () => {
  state.api.mockImplementation(async () => ({
    items: [
      { id: 'org-1', name: '研发部', orgType: 'FUNCTIONAL', enabled: true, archivedAt: null,
        memberCount: 4, activeKeyCount: 3, activeProjectCount: 0,
        departmentProject: { id: 'project-1', name: '研发部-部门预算', category: 'DEPARTMENT' } },
      { id: 'org-2', name: '广东-市局', orgType: 'REGION', enabled: true, archivedAt: null,
        memberCount: 12, activeKeyCount: 8, activeProjectCount: 2, departmentProject: null }
    ], total: 2, offset: 0, limit: 20
  }))
  const wrapper = render(OrgUnits)
  await flushPromises()
  expect(wrapper.text()).toContain('组织管理')
  expect(wrapper.text()).toContain('职能部门')
  expect(wrapper.text()).toContain('区域部门')
  expect(wrapper.text()).toContain('研发部-部门预算')
  expect(wrapper.text()).not.toContain('用量组')
})

it('shows organization members, projects, and department budget entry', async () => {
  state.api.mockImplementation(async (url: string) => {
    if (!url) return {}
    if (url.includes('/members')) return { items: [{ accountId: 'user-1', role: 'LEADER',
      membership: { status: 'ACTIVE', account: { displayName: '负责人', email: 'head@example.invalid' } } }], total: 1 }
    if (url.endsWith('/projects')) return [{ id: 'project-1', name: '研发部-部门预算', category: 'DEPARTMENT', status: 'ACTIVE' }]
    if (url.endsWith('/model-access')) return [{ publicModel: { id: 'deepseek', displayName: 'DeepSeek' } }]
    return { id: 'org-1', name: '研发部', orgType: 'FUNCTIONAL', description: '', enabled: true, archivedAt: null,
      memberCount: 1, modelCount: 1, activeKeyCount: 2, activeProjectCount: 1,
      departmentProject: { id: 'project-1', name: '研发部-部门预算', category: 'DEPARTMENT' } }
  })
  const wrapper = render(OrgUnitDetail)
  await flushPromises()
  expect(wrapper.text()).toContain('研发部')
  expect(wrapper.text()).toContain('部门预算项目')
  await wrapper.get('[data-tab="members"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('负责人')
  await wrapper.get('[data-tab="models"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('DeepSeek')
  await wrapper.get('[data-tab="projects"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('研发部-部门预算')
})
