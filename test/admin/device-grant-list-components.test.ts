// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DeviceGrants from '../../apps/admin/src/views/DeviceGrants.vue'
import type { DeviceGrantSummary, DeviceGrantUserGroup, Page } from '../../apps/admin/src/device-grants.js'

const state = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn(), toast: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('../../apps/admin/src/toast.js', () => ({ toast: state.toast }))

function grant(id: string, overrides: Partial<DeviceGrantSummary> = {}): DeviceGrantSummary {
  return {
    id,
    accountId: 'account-1',
    currentLink: { id: `link-${id}`, secretHint: `link…${id}`, status: 'AVAILABLE', expiresAt: null, createdAt: '2026-08-27T00:00:00.000Z' },
    expiresAt: null,
    disabledAt: null,
    deletedAt: null,
    boundAt: null,
    deviceId: null,
    createdById: 'admin-1',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    status: 'AVAILABLE',
    ...overrides
  }
}

const page = (available: DeviceGrantSummary): Page<DeviceGrantUserGroup> => ({
  items: [{ id: 'account-1', email: 'user@example.com', displayName: '用户一', deviceGrants: [
    available,
    grant('expired', { currentLink: { id: 'link-expired', secretHint: 'link…expired', status: 'EXPIRED', expiresAt: '2026-08-26T00:00:00.000Z', createdAt: '2026-08-25T00:00:00.000Z' } }),
    grant('bound', { currentLink: null, status: 'BOUND', deviceId: 'device-1', boundAt: '2026-08-27T01:00:00.000Z', device: { id: 'device-1', name: '工作站', installationId: null, platform: 'linux', clientVersion: '1.0.0', revokedAt: null, lastSeenAt: null, createdAt: '2026-08-27T01:00:00.000Z', grant: null } })
  ] }],
  total: 1,
  limit: 20,
  offset: 0
})

async function settle() {
  await nextTick()
  await flushPromises()
  await nextTick()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

describe('DeviceGrants mounted grouped list', () => {
  beforeEach(() => {
    state.api.mockReset()
    state.push.mockReset()
    state.toast.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders link summaries and isolates shared actions while reloading after regeneration', async () => {
    const available = grant('available')
    const listResponses = [page(available), page({ ...available, currentLink: { ...available.currentLink!, id: 'link-regenerated', secretHint: 'link…new', status: 'AVAILABLE' } })]
    state.api.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/v1/admin/device-grants?')) return listResponses.shift() || page(available)
      if (path === '/api/v1/admin/device-grants/available/links') return { connectionUrl: 'https://example.test/connect#replacement' }
      throw new Error(`Unexpected API call: ${path}`)
    })

    const wrapper = mount(DeviceGrants, { attachTo: document.body })
    await settle()

    expect(wrapper.findAll('thead th').map(th => th.text())).toContain('URL 提示')
    expect(wrapper.findAll('thead th').map(th => th.text())).toContain('URL 状态')
    expect(wrapper.findAll('thead th').map(th => th.text())).toContain('URL 有效期')
    expect(document.body.textContent).toContain('link…available')
    expect(document.body.textContent).toContain('可用')
    expect(document.body.textContent).toContain('已过期')
    expect(document.body.textContent).toContain('link…expired')
    expect(document.body.textContent).toContain('已绑定')
    expect(document.body.textContent).toContain('未生成')

    const rows = wrapper.findAll('tbody tr')
    expect(rows).toHaveLength(3)
    expect(rows[1].text()).toContain('已过期')
    expect(rows[2].text()).toContain('已绑定')

    const regenerate = rows[0].findAll('.device-grant-link-actions button').find(button => button.text() === '重新生成 URL')
    expect(regenerate).toBeTruthy()
    await regenerate!.trigger('click')
    await settle()
    await (document.querySelector('[role="dialog"] button.primary') as HTMLButtonElement).click()
    await settle()

    expect(state.push).not.toHaveBeenCalled()
    expect(state.api.mock.calls.filter(([path]) => String(path).startsWith('/api/v1/admin/device-grants?'))).toHaveLength(2)
    expect(document.body.textContent).toContain('link…new')
    wrapper.unmount()
  })

  it('keeps a regenerated URL open and copyable while applying the refreshed summary', async () => {
    const initial = deferred<Page<DeviceGrantUserGroup>>()
    const post = deferred<{ connectionUrl: string }>()
    const refresh = deferred<Page<DeviceGrantUserGroup>>()
    const initialGrant = grant('available')
    const refreshedGrant = { ...initialGrant, currentLink: { ...initialGrant.currentLink!, id: 'link-refreshed', secretHint: 'link…refreshed', status: 'EXPIRED' as const } }
    let listRequest = 0
    state.api.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/device-grants?')) return listRequest++ === 0 ? initial.promise : refresh.promise
      if (path === '/api/v1/admin/device-grants/available/links') return post.promise
      throw new Error(`Unexpected API call: ${path}`)
    })
    const clipboard = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })

    const wrapper = mount(DeviceGrants, { attachTo: document.body })
    initial.resolve(page(initialGrant))
    await settle()
    await wrapper.findAll('tbody tr')[0].findAll('.device-grant-link-actions button')[1].trigger('click')
    await settle()
    await (document.querySelector('[role="dialog"] button.primary') as HTMLButtonElement).click()
    post.resolve({ connectionUrl: 'https://example.test/connect#replacement-secret' })
    await settle()
    refresh.resolve(page(refreshedGrant))
    await settle()

    expect(document.body.textContent).toContain('link…refreshed')
    expect(document.body.textContent).toContain('已过期')
    expect((document.querySelector('textarea[aria-label="完整 URL"]') as HTMLTextAreaElement).value).toBe('https://example.test/connect#replacement-secret')
    await (document.querySelector('button[data-copy-url]') as HTMLButtonElement).click()
    await settle()
    expect(clipboard).toHaveBeenCalledWith('https://example.test/connect#replacement-secret')
    wrapper.unmount()
  })

  it('shows background refresh failures without losing the regenerated URL and clears them on retry', async () => {
    const initial = deferred<Page<DeviceGrantUserGroup>>()
    const post = deferred<{ connectionUrl: string }>()
    const failedRefresh = deferred<Page<DeviceGrantUserGroup>>()
    const successfulRefresh = deferred<Page<DeviceGrantUserGroup>>()
    const initialGrant = grant('available')
    const retryGrant = { ...initialGrant, currentLink: { ...initialGrant.currentLink!, id: 'link-retry', secretHint: 'link…retry', status: 'AVAILABLE' as const } }
    let listRequest = 0
    state.api.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/device-grants?')) {
        return [initial.promise, failedRefresh.promise, successfulRefresh.promise][listRequest++]
      }
      if (path === '/api/v1/admin/device-grants/available/links') return post.promise
      throw new Error(`Unexpected API call: ${path}`)
    })
    const clipboard = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })

    const wrapper = mount(DeviceGrants, { attachTo: document.body })
    initial.resolve(page(initialGrant))
    await settle()
    await wrapper.findAll('tbody tr')[0].findAll('.device-grant-link-actions button')[1].trigger('click')
    await settle()
    await (document.querySelector('[role="dialog"] button.primary') as HTMLButtonElement).click()
    post.resolve({ connectionUrl: 'https://example.test/connect#failure-secret' })
    await settle()
    failedRefresh.reject(new Error('刷新失败'))
    await settle()

    expect(document.body.textContent).toContain('刷新失败')
    expect((document.querySelector('textarea[aria-label="完整 URL"]') as HTMLTextAreaElement).value).toBe('https://example.test/connect#failure-secret')
    await (document.querySelector('button[data-copy-url]') as HTMLButtonElement).click()
    await settle()
    expect(clipboard).toHaveBeenCalledWith('https://example.test/connect#failure-secret')

    await wrapper.get('header button').trigger('click')
    successfulRefresh.resolve(page(retryGrant))
    await settle()
    expect(document.body.textContent).not.toContain('刷新失败')
    expect(document.body.textContent).toContain('link…retry')
    expect((document.querySelector('textarea[aria-label="完整 URL"]') as HTMLTextAreaElement).value).toBe('https://example.test/connect#failure-secret')
    wrapper.unmount()
  })
})
