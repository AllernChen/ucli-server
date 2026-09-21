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
    if (url.includes('/projects')) return [{ id: 'project-a', name: '项目A', code: 'PA' }]
    if (init?.method === 'POST') { if (fail) throw new Error('暂时失败'); return { id: 'key', secret: 'ucli_sk_only_once' } }
    return page
  })
  const w = render({ accountId: 'employee-a' }); await flushPromises()
  await w.get('[data-action="create-key"]').trigger('click')
  await w.get('[aria-label="Key 名称"]').setValue('CLI')
  expect(w.get('[data-action="save-key"]').attributes('disabled')).toBeDefined()
  await w.get('[aria-label="Key 所属组织"]').setValue('group-a')
  await w.get('[aria-label="项目"]').setValue('project-a')
  await w.get('#employee-key-form').trigger('submit'); await flushPromises()
  expect(w.text()).toContain('暂时失败')
  fail = false
  await w.get('#employee-key-form').trigger('submit'); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/admin/users/employee-a/api-keys', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'CLI', projectId: 'project-a', expiresAt: null }) }))
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

it('lets an ordinary employee reveal an own key with the current login password', async () => {
  const clipboard = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
  state.api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/reveal')) return { id: 'own', secret: 'ucli_sk_own_reveal' }
    return url.endsWith('usage-groups')
      ? []
      : { ...page, items: [{ id: 'own', name: '个人 CLI', groupId: 'g', secretHint: '…abcd', revokedAt: null, disabledAt: null, expiresAt: null, lastUsedAt: null, secretRecoverable: true }] }
  })
  const w = render(); await flushPromises()
  await w.get('[data-action="key-details"]').trigger('click')
  await w.get('[aria-label="当前登录密码"]').setValue('own-password')
  await w.get('[data-action="reveal-own-key"]').trigger('click'); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/me/api-keys/own/reveal', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ password: 'own-password' })
  }))
  expect(w.get('[data-own-secret]').text()).toBe('ucli_sk_own_reveal')
  await w.findAll('button').find(button => button.text() === '复制 Key')!.trigger('click'); await flushPromises()
  expect(clipboard).toHaveBeenCalledWith('ucli_sk_own_reveal')
  expect(w.text()).toContain('已复制')
})

it('filters own keys on the server and offers historical groups beyond the loaded page', async () => {
  state.api.mockImplementation(async (url: string) => url.endsWith('/usage-groups') ? [{ id: 'active', name: '当前组' }] : { ...page, items: [{ id: 'current', name: '当前 Key', groupId: 'active', secretHint: '…now', revokedAt: null, disabledAt: null, expiresAt: null, lastUsedAt: null, group: { id: 'active', name: '当前组' } }], filterGroups: [{ id: 'archived', name: '历史组' }] })
  const w = render(); await flushPromises()
  expect(w.get('[aria-label="筛选组织"]').text()).toContain('历史组')
  await w.get('[aria-label="搜索 Key"]').setValue('旧')
  await w.get('[aria-label="Key 状态"]').setValue('active'); await flushPromises()
  expect(state.api.mock.calls.some(([url]) => url === '/api/v1/me/api-keys?limit=20&offset=0&q=%E6%97%A7&status=active')).toBe(true)
})

it('does not display a late secret after changing employee or unmounting', async () => {
  let resolve!: (v: unknown) => void
  state.api.mockImplementation(async (url, init) => {
    if (init?.method === 'POST') return new Promise(r => { resolve = r })
    if (url.includes('/projects')) return [{ id: 'project-late', name: '项目', code: 'P' }]
    return url.endsWith('usage-groups') ? [{ id: 'g', name: '组' }] : page
  })
  const w = render({ accountId: 'first' }); await flushPromises()
  await w.get('[data-action="create-key"]').trigger('click')
  await w.get('[aria-label="Key 名称"]').setValue('CLI')
  await w.get('[aria-label="Key 所属组织"]').setValue('g')
  await w.get('[aria-label="项目"]').setValue('project-late')
  await w.get('#employee-key-form').trigger('submit')
  await w.setProps({ accountId: 'second' }); await flushPromises()
  resolve({ secret: 'ucli_sk_old_employee' }); await flushPromises()
  expect(w.find('[aria-label="完整 API Key"]').exists()).toBe(false)
  expect(w.html()).not.toContain('ucli_sk_old_employee')
  w.unmount()
  expect(localStorage.length).toBe(0)
})

it('queries organization keys with server-side search and status filters', async () => {
  state.api.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/admin/users?')) return { ...page, items: [{ id: 'employee-a', displayName: '张三', email: 'zhang@example.invalid' }] }
    if (url.startsWith('/api/v1/admin/usage-groups?')) return { ...page, items: [{ id: 'group-a', name: '研发组' }] }
    return { ...page, total: 40, items: [{ id: 'key-a', name: 'CLI', groupId: 'group-a', accountId: 'employee-a', organizationId: 'org-a', secretHint: '…abcd', revokedAt: null, disabledAt: null, expiresAt: null, lastUsedAt: null, createdAt: '2026-09-17T00:00:00Z', account: { id: 'employee-a', displayName: '张三', email: 'zhang@example.invalid' }, group: { id: 'group-a', name: '研发组' }, createdBy: { id: 'admin', displayName: '管理员' } }] }
  })
  const w = render({ managed: true }); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/admin/employee-api-keys?limit=20&offset=0')
  expect(w.text()).toContain('张三')
  await w.get('[aria-label="搜索 Key"]').setValue('CLI')
  await w.get('[aria-label="Key 状态"]').setValue('disabled')
  await flushPromises()
  expect(state.api.mock.calls.some(([url]) => url === '/api/v1/admin/employee-api-keys?limit=20&offset=0&q=CLI&status=disabled')).toBe(true)
  await w.findAll('.pagination button')[1].trigger('click'); await flushPromises()
  expect(state.api.mock.calls.some(([url]) => url === '/api/v1/admin/employee-api-keys?limit=20&offset=20&q=CLI&status=disabled')).toBe(true)
})

it('loads the selected employee groups before creating an organization key', async () => {
  state.api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/v1/admin/users?')) return { ...page, items: [{ id: 'employee-b', displayName: '李四', email: 'li@example.invalid' }] }
    if (url.startsWith('/api/v1/admin/usage-groups?')) return { ...page, items: [] }
    if (url === '/api/v1/admin/users/employee-b/usage-groups') return [{ id: 'group-b', name: '产品组' }]
    if (url.includes('/projects')) return [{ id: 'project-b', name: '项目B', code: 'PB' }]
    if (init?.method === 'POST') return { id: 'key-b', secret: 'ucli_sk_only_once' }
    return page
  })
  const w = render({ managed: true }); await flushPromises()
  await w.get('[data-action="create-key"]').trigger('click')
  await w.get('[aria-label="Key 员工"]').setValue('employee-b'); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/admin/users/employee-b/usage-groups')
  await w.get('[aria-label="Key 名称"]').setValue('CLI')
  await w.get('[aria-label="Key 所属组织"]').setValue('group-b')
  await w.get('[aria-label="项目"]').setValue('project-b')
  await w.get('#employee-key-form').trigger('submit'); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/admin/users/employee-b/api-keys', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'CLI', projectId: 'project-b', expiresAt: null }) }))
})

it('searches employee pages inside the create drawer and keeps the selected employee', async () => {
  state.api.mockImplementation(async (url: string) => {
    if (url.includes('/api/v1/admin/users?') && url.includes('q=next')) return { ...page, items: [{ id: 'employee-next', displayName: '下一页员工', email: 'next@example.invalid' }] }
    if (url.startsWith('/api/v1/admin/users?')) return { ...page, total: 40, items: [{ id: 'employee-first', displayName: '首页员工', email: 'first@example.invalid' }] }
    if (url === '/api/v1/admin/users/employee-next/usage-groups') return [{ id: 'group-next', name: '下一页组' }]
    if (url.startsWith('/api/v1/admin/usage-groups?')) return page
    return page
  })
  const w = render({ managed: true }); await flushPromises()
  await w.get('[data-action="create-key"]').trigger('click')
  await w.get('[aria-label="创建 Key 搜索员工"]').setValue('next'); await flushPromises()
  await w.get('[aria-label="Key 员工"]').setValue('employee-next'); await flushPromises()
  await w.get('[aria-label="创建 Key 搜索员工"]').setValue(''); await flushPromises()
  expect(w.get('[aria-label="Key 员工"]').text()).toContain('下一页员工')
})

it('does not replace current organization results with a late request', async () => {
  let resolveFirst!: (value: typeof page) => void
  state.api.mockImplementation((url: string) => {
    if (url.startsWith('/api/v1/admin/users?') || url.startsWith('/api/v1/admin/usage-groups?')) return Promise.resolve(page)
    if (url.includes('q=first')) return new Promise(resolve => { resolveFirst = resolve })
    return Promise.resolve({ ...page, items: [{ id: 'new', name: '新结果', groupId: 'g', accountId: 'a', organizationId: 'o', secretHint: '…new', revokedAt: null, disabledAt: null, expiresAt: null, lastUsedAt: null }] })
  })
  const w = render({ managed: true }); await flushPromises()
  await w.get('[aria-label="搜索 Key"]').setValue('first'); await flushPromises()
  await w.get('[aria-label="搜索 Key"]').setValue('second'); await flushPromises()
  resolveFirst(page); await flushPromises()
  expect(w.text()).toContain('新结果')
  expect(w.text()).not.toContain('暂无 API Key')
})

it('shows relationship details and a scoped usage-log link without the secret', async () => {
  state.api.mockImplementation(async (url: string) => url.startsWith('/api/v1/admin/users?') || url.startsWith('/api/v1/admin/usage-groups?') ? page : ({ ...page, items: [{ id: 'key-detail', name: 'CLI', groupId: 'group-a', accountId: 'employee-a', organizationId: 'org-a', secretHint: '…abcd', revokedAt: null, disabledAt: null, expiresAt: null, lastUsedAt: null, createdAt: '2026-09-17T00:00:00Z', account: { id: 'employee-a', displayName: '张三', email: 'zhang@example.invalid' }, group: { id: 'group-a', name: '研发组' }, createdBy: { id: 'admin', displayName: '管理员' } }] }) )
  const w = render({ managed: true }); await flushPromises()
  await w.get('[data-action="key-details"]').trigger('click')
  expect(w.text()).toContain('管理员')
  expect(w.text()).toContain('到期时间')
  expect(w.text()).toContain('最后使用')
  const logs = w.get('[data-action="key-logs"]')
  expect(logs.attributes('href')).toContain('accountId=employee-a')
  expect(logs.attributes('href')).toContain('organizationId=org-a')
  expect(logs.attributes('href')).toContain('apiKeyId=key-detail')
  expect(logs.attributes('href')).not.toContain('abcd')
})
