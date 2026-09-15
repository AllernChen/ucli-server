// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import Usage from '../../apps/admin/src/views/Usage.vue'

const state = vi.hoisted(() => ({ api: vi.fn(), downloadCsv: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => state)
let wrapper: VueWrapper | undefined
const range = { start: '2026-09-09T16:00:00.000Z', end: '2026-09-16T16:00:00.000Z', timezone: 'Asia/Shanghai' }
beforeEach(() => {
  vi.clearAllMocks()
  state.api.mockImplementation(async (path: string) => {
    if (path.includes('/auth/me')) return { role: 'PLATFORM_ADMIN' }
    if (path.includes('/filter-options')) return { page: null }
    const query = new URL(path, 'http://local').searchParams
    const limit = Number(query.get('limit')), offset = Number(query.get('offset'))
    return { total: 822, limit, offset, items: Array.from({ length: limit }, (_, i) => ({ id: String(offset + i), requestId: String(offset + i), startedAt: range.start, matchedCostCny: '1' })) }
  })
})
afterEach(() => wrapper?.unmount())
it('restores 200-row URLs on entry, browser back and remount, and keeps page navigation at that size', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/usage', component: Usage }] })
  await router.push({ path: '/usage', query: { ...range, limit: '200', offset: '200' } })
  const start = () => mount(Usage, { global: { plugins: [router] } })
  wrapper = start(); await flushPromises()
  expect(wrapper.findAll('tbody tr')).toHaveLength(200)
  expect(wrapper.text()).toContain('第 2 页')
  await wrapper.findAll('button').find(button => button.text() === '下一页')!.trigger('click'); await flushPromises()
  expect(router.currentRoute.value.query).toMatchObject({ limit: '200', offset: '400' })
  await router.push({ path: '/usage', query: { ...range, limit: '1', offset: '0' } }); await flushPromises()
  expect(wrapper.findAll('tbody tr')).toHaveLength(1)
  router.back(); await flushPromises()
  expect(wrapper.findAll('tbody tr')).toHaveLength(200)
  expect(wrapper.text()).toContain('第 3 页')
  wrapper.unmount(); wrapper = start(); await flushPromises()
  expect(wrapper.findAll('tbody tr')).toHaveLength(200)
  await router.push({ path: '/usage', query: range }); await flushPromises()
  expect(wrapper.findAll('tbody tr')).toHaveLength(50)
})
