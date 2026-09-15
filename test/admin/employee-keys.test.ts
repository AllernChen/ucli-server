// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import EmployeeKeysPanel from '../../apps/admin/src/components/EmployeeKeysPanel.vue'
const state = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
const page = { items: [], total: 0, offset: 0, limit: 20 }
const wrappers: ReturnType<typeof mount>[] = []
const render = (props = {}) => { const w = mount(EmployeeKeysPanel, { props, global: { stubs: { teleport: true } } }); wrappers.push(w); return w }
beforeEach(() => { state.api.mockReset(); localStorage.clear() })
afterEach(() => wrappers.splice(0).forEach(w => w.unmount()))

it('requires an employee group, shows secret once, and retries failed creation without storing the secret', async () => {
  let fail = true
  state.api.mockImplementation(async (url, init) => {
    if (url.endsWith('/usage-groups')) return [{ id: 'group-a', name: '研发组' }]
    if (init?.method === 'POST') { if (fail) throw new Error('暂时失败'); return { id: 'key', secret: 'ucli_sk_only_once' } }
    return page
  })
  const w = render({ accountId: 'employee-a' }); await flushPromises()
  await w.get('[data-action="create-key"]').trigger('click')
  await w.get('[aria-label="Key 名称"]').setValue('CLI')
  expect(w.get('[data-action="save-key"]').attributes('disabled')).toBeDefined()
  await w.get('[aria-label="Key 所属组"]').setValue('group-a')
  await w.get('form').trigger('submit'); await flushPromises()
  expect(w.text()).toContain('暂时失败')
  fail = false
  await w.get('form').trigger('submit'); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/admin/users/employee-a/api-keys', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'CLI', groupId: 'group-a', expiresAt: null }) }))
  expect(w.get<HTMLTextAreaElement>('[aria-label="完整 API Key"]').element.value).toBe('ucli_sk_only_once')
  expect(localStorage.length).toBe(0)
  await w.get('[data-action="close-secret"]').trigger('click')
  expect(w.find('[aria-label="完整 API Key"]').exists()).toBe(false)
})

it('own mode only requests own endpoints and offers no create/edit/enable actions', async () => {
  state.api.mockImplementation(async url => url.endsWith('usage-groups') ? [] : { ...page, items: [{ id: 'own', name: '个人 CLI', groupId: 'g', secretHint: '…abcd', revokedAt: null, disabledAt: null, expiresAt: null }] })
  const w = render(); await flushPromises()
  expect(state.api.mock.calls.every(([url]) => url.startsWith('/api/v1/me/'))).toBe(true)
  expect(w.find('[data-action="create-key"]').exists()).toBe(false)
  expect(w.text()).not.toContain('编辑')
  await w.get('[data-action="revoke-key"]').trigger('click')
  await w.get('.danger-button').trigger('click'); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/me/api-keys/own/revoke', expect.objectContaining({ method: 'POST' }))
})

it('does not display a late secret after changing employee or unmounting', async () => {
  let resolve!: (v: unknown) => void
  state.api.mockImplementation(async (url, init) => {
    if (init?.method === 'POST') return new Promise(r => { resolve = r })
    return url.endsWith('usage-groups') ? [{ id: 'g', name: '组' }] : page
  })
  const w = render({ accountId: 'first' }); await flushPromises()
  await w.get('[data-action="create-key"]').trigger('click')
  await w.get('[aria-label="Key 名称"]').setValue('CLI')
  await w.get('[aria-label="Key 所属组"]').setValue('g')
  await w.get('form').trigger('submit')
  await w.setProps({ accountId: 'second' }); await flushPromises()
  resolve({ secret: 'ucli_sk_old_employee' }); await flushPromises()
  expect(w.find('[aria-label="完整 API Key"]').exists()).toBe(false)
  expect(w.html()).not.toContain('ucli_sk_old_employee')
  w.unmount()
  expect(localStorage.length).toBe(0)
})
