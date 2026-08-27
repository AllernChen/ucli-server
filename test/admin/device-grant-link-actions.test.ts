// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DeviceGrantLinkActions from '../../apps/admin/src/components/DeviceGrantLinkActions.vue'
import type { DeviceGrantSummary } from '../../apps/admin/src/device-grants.js'

const state = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

const baseGrant: DeviceGrantSummary = {
  id: 'grant-1', accountId: 'account-1', currentLink: { id: 'link-1', secretHint: 'link…abcd', status: 'AVAILABLE', expiresAt: null, createdAt: '2026-08-27T00:00:00.000Z' },
  expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null, createdById: 'admin-1', createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z', status: 'AVAILABLE'
}

async function settle() { await nextTick(); await flushPromises(); await nextTick() }

function mountActions(grant: DeviceGrantSummary = baseGrant) {
  return mount(DeviceGrantLinkActions, { attachTo: document.body, props: { grant } })
}

describe('DeviceGrantLinkActions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
    state.api.mockReset()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); vi.restoreAllMocks() })

  it('views the current URL and removes it from the DOM when closed', async () => {
    const secret = 'https://ucli.example.test/connect#link=view-secret'
    const get = deferred<{ connectionUrl: string }>()
    state.api.mockReturnValue(get.promise)
    const wrapper = mountActions()

    await wrapper.get('button').trigger('click')
    expect(state.api).toHaveBeenLastCalledWith('/api/v1/admin/device-grants/grant-1/link')
    get.resolve({ connectionUrl: secret })
    await settle()
    expect((document.querySelector('textarea[aria-label="完整 URL"]') as HTMLTextAreaElement).value).toBe(secret)

    ;(document.querySelector('button[aria-label="关闭"]') as HTMLButtonElement).click()
    await settle()
    expect(document.body.textContent).not.toContain(secret)
    wrapper.unmount()
  })

  it('warns before regenerating a selected-expiry URL and emits one change', async () => {
    const wrapper = mountActions()
    state.api.mockResolvedValue({ connectionUrl: 'https://ucli.example.test/connect#link=replacement-secret' })

    await wrapper.get('button:nth-child(2)').trigger('click')
    expect(document.body.textContent).toContain('重新生成后，当前 URL 将立即失效')
    const select = document.querySelector('.link-expiry-fields select') as HTMLSelectElement
    select.value = '30d'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    await (document.querySelector('[role="dialog"] button.primary') as HTMLButtonElement).click()
    await settle()

    expect(state.api).toHaveBeenLastCalledWith('/api/v1/admin/device-grants/grant-1/links', {
      method: 'POST', body: JSON.stringify({ expiresAt: '2026-09-26T00:00:00.000Z' })
    })
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect((document.querySelector('textarea[aria-label="完整 URL"]') as HTMLTextAreaElement).value).toContain('replacement-secret')
    wrapper.unmount()
  })

  it('shows copy success and clipboard failures next to the recovered URL', async () => {
    const wrapper = mountActions()
    state.api.mockResolvedValue({ connectionUrl: 'https://ucli.example.test/connect#link=copy-secret' })
    await wrapper.get('button').trigger('click')
    await settle()

    await (document.querySelector('button[data-copy-url]') as HTMLButtonElement).click()
    await settle()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://ucli.example.test/connect#link=copy-secret')
    expect(document.body.textContent).toContain('URL 已复制')

    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('剪贴板不可用'))
    await (document.querySelector('button[data-copy-url]') as HTMLButtonElement).click()
    await settle()
    expect(document.body.textContent).toContain('剪贴板不可用')
    wrapper.unmount()
  })

  it('shows view and regeneration API failures beside their actions', async () => {
    const wrapper = mountActions()
    state.api.mockRejectedValueOnce(new Error('无法获取 URL'))
    await wrapper.get('button').trigger('click')
    await settle()
    expect(wrapper.text()).toContain('无法获取 URL')

    state.api.mockRejectedValueOnce(new Error('无法重新生成 URL'))
    await wrapper.get('button:nth-child(2)').trigger('click')
    await (document.querySelector('[role="dialog"] button.primary') as HTMLButtonElement).click()
    await settle()
    expect(document.body.textContent).toContain('无法重新生成 URL')
    wrapper.unmount()
  })

  it('excludes duplicate view and regeneration requests while each request is pending', async () => {
    const view = deferred<{ connectionUrl: string }>()
    state.api.mockReturnValue(view.promise)
    const viewing = mountActions()
    await viewing.get('button').trigger('click')
    await viewing.get('button').trigger('click')
    expect(state.api).toHaveBeenCalledTimes(1)
    view.resolve({ connectionUrl: 'https://ucli.example.test/connect#link=view-once-secret' })
    await settle()
    viewing.unmount()

    const post = deferred<{ connectionUrl: string }>()
    state.api.mockReset()
    state.api.mockReturnValue(post.promise)
    const wrapper = mountActions()
    await wrapper.get('button:nth-child(2)').trigger('click')
    const submit = document.querySelector('[role="dialog"] button.primary') as HTMLButtonElement
    submit.click()
    submit.click()
    await settle()
    expect(state.api).toHaveBeenCalledTimes(1)

    post.resolve({ connectionUrl: 'https://ucli.example.test/connect#link=one-secret' })
    await settle()
    wrapper.unmount()
  })

  it('suppresses late view and regeneration secrets after unmount', async () => {
    const view = deferred<{ connectionUrl: string }>()
    state.api.mockReturnValue(view.promise)
    const viewing = mountActions()
    await viewing.get('button').trigger('click')
    viewing.unmount()
    view.resolve({ connectionUrl: 'https://ucli.example.test/connect#link=late-view-secret' })
    await settle()
    expect(document.body.textContent).not.toContain('late-view-secret')

    const regeneration = deferred<{ connectionUrl: string }>()
    state.api.mockReset()
    state.api.mockReturnValue(regeneration.promise)
    const regenerating = mountActions()
    await regenerating.get('button:nth-child(2)').trigger('click')
    ;(document.querySelector('[role="dialog"] button.primary') as HTMLButtonElement).click()
    await settle()
    regenerating.unmount()
    regeneration.resolve({ connectionUrl: 'https://ucli.example.test/connect#link=late-regeneration-secret' })
    await settle()
    expect(document.body.textContent).not.toContain('late-regeneration-secret')
  })

  it('only offers actions for an unbound available grant, while an expired current URL remains recoverable', () => {
    const hidden = [
      { ...baseGrant, status: 'BOUND' as const, deviceId: 'device-1' },
      { ...baseGrant, status: 'DISABLED' as const },
      { ...baseGrant, status: 'DELETED' as const },
      { ...baseGrant, status: 'EXPIRED' as const },
      { ...baseGrant, deviceId: 'device-1' }
    ]
    for (const grant of hidden) {
      const wrapper = mountActions(grant)
      expect(wrapper.findAll('button')).toHaveLength(0)
      wrapper.unmount()
    }

    const expiredLink = mountActions({ ...baseGrant, currentLink: { ...baseGrant.currentLink!, status: 'EXPIRED' } })
    expect(expiredLink.text()).toContain('查看 URL')
    expect(expiredLink.text()).toContain('重新生成 URL')
    expiredLink.unmount()

    const revokedLink = mountActions({ ...baseGrant, currentLink: { ...baseGrant.currentLink!, status: 'REVOKED' } })
    expect(revokedLink.text()).not.toContain('查看 URL')
    expect(revokedLink.text()).toContain('重新生成 URL')
    revokedLink.unmount()
  })
})
