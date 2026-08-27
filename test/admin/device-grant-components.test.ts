// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import Drawer from '../../apps/admin/src/components/Drawer.vue'
import ConfirmDialog from '../../apps/admin/src/components/ConfirmDialog.vue'
import LinkExpiryFields from '../../apps/admin/src/components/LinkExpiryFields.vue'

const state = vi.hoisted(() => ({ route: null as any, api: vi.fn(), push: vi.fn(), toast: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({ useRoute: () => state.route, useRouter: () => ({ push: state.push }) }))
vi.mock('../../apps/admin/src/toast.js', () => ({ toast: state.toast }))

import UserDetail from '../../apps/admin/src/views/UserDetail.vue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

const user = (id: string, displayName = id, role: 'MEMBER' | 'ORG_ADMIN' | 'PLATFORM_ADMIN' = 'MEMBER', status: 'ACTIVE' | 'DISABLED' = 'ACTIVE') => ({
  id, organizationId: 'org', email: `${id}@example.com`, displayName, status, role, createdAt: '2026-01-01T00:00:00.000Z',
  deviceCount: 0, deviceGrantCount: 0, devices: [], deviceGrants: []
})

async function settle() { await nextTick(); await flushPromises(); await nextTick() }

function setupValue(setupState: Record<string, unknown>, key: string) {
  const value = setupState[key] as { value?: unknown } | unknown
  return value && typeof value === 'object' && 'value' in value ? (value as { value: unknown }).value : value
}

describe('admin dialog components', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

  it('keeps focus when initially closed, traps/guards open dialogs, and restores exactly once', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const focus = vi.spyOn(trigger, 'focus')
    const drawer = mount(Drawer, { attachTo: document.body, props: { open: false, title: 'Drawer' }, slots: { default: '<button>内容</button>' } })
    expect(document.activeElement).toBe(trigger)
    expect(focus).not.toHaveBeenCalled()

    await drawer.setProps({ open: true })
    await settle()
    const drawerDialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(drawerDialog).toBeTruthy()
    expect(document.activeElement).toBe(drawerDialog.querySelector('[aria-label="关闭"]'))
    await drawer.setProps({ open: false })
    await settle()
    expect(focus).toHaveBeenCalledOnce()
    drawer.unmount()
    expect(focus).toHaveBeenCalledOnce()

    const confirm = mount(ConfirmDialog, { attachTo: document.body, props: { open: true, title: 'Confirm', message: '提示' } })
    await settle()
    const confirmDialog = document.querySelector('[role="dialog"]') as HTMLElement
    const cancel = confirmDialog.querySelector('[data-dialog-initial-focus]') as HTMLButtonElement
    const confirmButton = confirmDialog.querySelector('.primary') as HTMLButtonElement
    expect(document.activeElement).toBe(cancel)
    cancel.focus()
    confirmDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(confirmButton)
    await confirm.setProps({ closeDisabled: true })
    confirmDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(confirm.emitted('cancel')).toBeUndefined()
    await confirm.setProps({ closeDisabled: false })
    confirmDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(confirm.emitted('cancel')).toHaveLength(1)
    confirm.unmount()

    const unmountTrigger = document.createElement('button')
    document.body.append(unmountTrigger)
    unmountTrigger.focus()
    const unmountFocus = vi.spyOn(unmountTrigger, 'focus')
    const openDrawer = mount(Drawer, { attachTo: document.body, props: { open: true, title: 'Open drawer' } })
    await settle()
    openDrawer.unmount()
    expect(unmountFocus).toHaveBeenCalledOnce()
  })

  it('renders every link expiry option and enables custom datetime only for custom mode', async () => {
    const wrapper = mount(LinkExpiryFields, { props: { modelValue: { mode: '7d', customExpiresAt: '' } } })
    const select = wrapper.get('select')
    const custom = wrapper.get('input[type="datetime-local"]')
    expect(wrapper.text()).toContain('URL 有效期')
    expect(select.findAll('option').map(option => option.text())).toEqual(['1 天', '7 天（默认）', '30 天', '永久', '自定义'])
    expect(custom.attributes('required')).toBeUndefined()
    expect(custom.attributes('disabled')).toBeDefined()

    for (const mode of ['1d', '7d', '30d', 'permanent', 'custom'] as const) {
      await select.setValue(mode)
      const emittedValue = wrapper.emitted('update:modelValue')?.at(-1)?.[0]
      expect(emittedValue).toEqual({ mode, customExpiresAt: '' })
      await wrapper.setProps({ modelValue: emittedValue as { mode: typeof mode; customExpiresAt: string } })
      expect(custom.attributes('required')).toBe(mode === 'custom' ? '' : undefined)
      expect(custom.attributes('disabled')).toBe(mode === 'custom' ? undefined : '')
    }
    await wrapper.setProps({ modelValue: { mode: 'custom', customExpiresAt: '2026-08-28T00:00' } })
    expect((wrapper.get('input[type="datetime-local"]').element as HTMLInputElement).value).toBe('2026-08-28T00:00')
  })
})

describe('UserDetail mounted async behavior', () => {
  beforeEach(() => {
    state.route = reactive({ params: reactive({ id: 'user-1' }) })
    state.api.mockReset()
    state.push.mockReset()
    state.toast.mockReset()
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('creates grants for every active membership role with permanent authorization and the default URL expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
    try {
      for (const role of ['MEMBER', 'ORG_ADMIN', 'PLATFORM_ADMIN'] as const) {
        state.api.mockReset()
        state.api
          .mockResolvedValueOnce(user('user-1', '用户一', role))
          .mockResolvedValueOnce({ connectionUrl: `https://example/connect#${role}-secret` })
          .mockResolvedValueOnce(user('user-1', '用户一', role))
        const wrapper = mount(UserDetail, { attachTo: document.body })
        await settle()

        const openButton = wrapper.get('header .actions button.primary')
        expect((openButton.element as HTMLButtonElement).disabled).toBe(false)
        await openButton.trigger('click')
        await settle()
        const expirySelect = document.querySelector('#grant-form .link-expiry-fields select') as HTMLSelectElement
        expirySelect.value = '30d'
        expirySelect.dispatchEvent(new Event('change', { bubbles: true }))
        await settle()
        await (Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent === '取消') as HTMLButtonElement).click()
        await settle()
        await openButton.trigger('click')
        await settle()
        expect((document.querySelector('#grant-form .link-expiry-fields select') as HTMLSelectElement).value).toBe('7d')
        await (document.querySelector('button[form="grant-form"]') as HTMLButtonElement).click()
        await settle()

        const createCall = state.api.mock.calls.find(([path, options]) =>
          path === '/api/v1/admin/users/user-1/device-grants' && (options as { method?: string } | undefined)?.method === 'POST'
        )
        expect(createCall).toEqual([
          '/api/v1/admin/users/user-1/device-grants',
          { method: 'POST', body: JSON.stringify({ expiresAt: null, linkExpiresAt: '2026-09-03T00:00:00.000Z' }) }
        ])
        expect(document.body.textContent).toContain('以后仍可在授权列表中查看当前 URL')
        expect((document.querySelector('textarea[aria-label="完整连接链接"]') as HTMLTextAreaElement).value).toContain(`${role}-secret`)
        await (document.querySelector('[role="dialog"] button.primary') as HTMLButtonElement).click()
        await settle()
        expect(document.querySelector('textarea[aria-label="完整连接链接"]')).toBeNull()
        wrapper.unmount()
        document.body.innerHTML = ''
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('explains why a disabled membership cannot create a grant', async () => {
    state.api.mockResolvedValue(user('user-1', '已禁用用户', 'ORG_ADMIN', 'DISABLED'))
    const wrapper = mount(UserDetail, { attachTo: document.body })
    await settle()

    expect((wrapper.get('header .actions button.primary').element as HTMLButtonElement).disabled).toBe(true)
    expect(document.body.textContent).toContain('仅可为已启用的用户创建授权')
    wrapper.unmount()
  })

  it('resets the URL expiry selection when the detail route changes', async () => {
    state.api.mockResolvedValue(user('user-1', '用户一'))
    const wrapper = mount(UserDetail, { attachTo: document.body })
    await settle()

    await wrapper.get('header .actions button.primary').trigger('click')
    const expirySelect = document.querySelector('#grant-form .link-expiry-fields select') as HTMLSelectElement
    expirySelect.value = '30d'
    expirySelect.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(expirySelect.value).toBe('30d')

    state.route.params.id = 'user-2'
    await settle()
    await wrapper.get('header .actions button.primary').trigger('click')
    expect((document.querySelector('#grant-form .link-expiry-fields select') as HTMLSelectElement).value).toBe('7d')
    wrapper.unmount()
  })

  it('renders current URL summaries and the shared recovery actions for each grant', async () => {
    const detail = {
      ...user('user-1', '用户一'),
      deviceGrantCount: 1,
      deviceGrants: [{
        id: 'grant-1', currentLink: { id: 'link-1', secretHint: 'link…abcd', status: 'AVAILABLE', expiresAt: '2026-09-03T00:00:00.000Z', createdAt: '2026-08-27T00:00:00.000Z' },
        expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null,
        createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z', status: 'AVAILABLE'
      }]
    }
    state.api.mockResolvedValue(detail)
    const wrapper = mount(UserDetail, { attachTo: document.body })
    await settle()

    expect(document.body.textContent).toContain('link…abcd')
    expect(document.body.textContent).toContain('可用')
    expect(document.body.textContent).toContain('查看 URL')
    wrapper.unmount()
  })

  it('marks a grant without a current URL as unavailable instead of permanent', async () => {
    state.api.mockResolvedValue({
      ...user('user-1', '用户一'),
      deviceGrantCount: 1,
      deviceGrants: [{
        id: 'grant-1', currentLink: null, expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null,
        createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z', status: 'AVAILABLE'
      }]
    })
    const wrapper = mount(UserDetail, { attachTo: document.body })
    await settle()

    expect(wrapper.find('.table-panel tbody tr').findAll('td')[2].text()).toBe('—')
    wrapper.unmount()
  })

  it('reloads its detail when a grant link action changes a grant', async () => {
    const grant = {
      id: 'grant-1', currentLink: { id: 'link-1', secretHint: 'link…abcd', status: 'AVAILABLE', expiresAt: null, createdAt: '2026-08-27T00:00:00.000Z' },
      expiresAt: null, disabledAt: null, deletedAt: null, boundAt: null, deviceId: null,
      createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z', status: 'AVAILABLE'
    }
    state.api
      .mockResolvedValueOnce({ ...user('user-1', '创建前'), deviceGrantCount: 1, deviceGrants: [grant] })
      .mockResolvedValueOnce({ connectionUrl: 'https://example/connect#replacement' })
      .mockResolvedValueOnce({ ...user('user-1', '创建后'), deviceGrantCount: 1, deviceGrants: [grant] })
    const wrapper = mount(UserDetail, { attachTo: document.body })
    await settle()

    await wrapper.get('.device-grant-link-actions button:nth-child(2)').trigger('click')
    await settle()
    await (document.querySelector('button[form="regenerate-grant-link-form"]') as HTMLButtonElement).click()
    await settle()

    expect(document.body.textContent).toContain('创建后')
    expect(state.api.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/admin/users/user-1',
      '/api/v1/admin/device-grants/grant-1/links',
      '/api/v1/admin/users/user-1'
    ])
    wrapper.unmount()
  })

  it('keeps a same-route created secret when refresh GETs race or later fail', async () => {
    const initial = deferred<any>()
    const post = deferred<any>()
    const refresh = deferred<any>()
    const afterCreate = deferred<any>()
    state.api.mockReturnValueOnce(initial.promise).mockReturnValueOnce(post.promise).mockReturnValueOnce(refresh.promise).mockReturnValueOnce(afterCreate.promise)
    const wrapper = mount(UserDetail, { attachTo: document.body })
    initial.resolve(user('user-1', '用户一'))
    await settle()
    await wrapper.get('header .actions button.primary').trigger('click')
    await settle()
    await (document.querySelector('#grant-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await wrapper.get('header .actions button:not(.primary)').trigger('click')
    post.resolve({ connectionUrl: 'https://example/connect#token=secret' })
    await settle()
    expect(document.body.textContent).toContain('以后仍可在授权列表中查看当前 URL')
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toContain('secret')
    refresh.resolve(user('user-1', '旧刷新'))
    afterCreate.reject(new Error('刷新失败'))
    await settle()
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toContain('secret')
    wrapper.unmount()
  })

  it('drops a pending create response after the route changes and ignores out-of-order GETs', async () => {
    const first = deferred<any>()
    const newer = deferred<any>()
    const post = deferred<any>()
    const userTwo = deferred<any>()
    state.api.mockReturnValueOnce(first.promise).mockReturnValueOnce(newer.promise).mockReturnValueOnce(post.promise).mockReturnValueOnce(userTwo.promise)
    const wrapper = mount(UserDetail, { attachTo: document.body })
    await wrapper.get('header .actions button:not(.primary)').trigger('click')
    newer.resolve(user('user-1', '最新用户'))
    await settle()
    first.resolve(user('user-1', '旧用户'))
    await settle()
    expect(document.body.textContent).toContain('最新用户')
    await wrapper.get('header .actions button.primary').trigger('click')
    await settle()
    await (document.querySelector('#grant-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    state.route.params.id = 'user-2'
    await settle()
    post.resolve({ connectionUrl: 'https://example/#token=stale' })
    userTwo.resolve(user('user-2', '用户二'))
    await settle()
    expect(document.body.textContent).not.toContain('以后仍可在授权列表中查看当前 URL')
    expect(document.body.textContent).toContain('用户二')
    wrapper.unmount()
  })

  it('does not apply late GET or create responses after unmount', async () => {
    const lateGet = deferred<any>()
    state.api.mockReturnValueOnce(lateGet.promise)
    const loading = mount(UserDetail, { attachTo: document.body })
    const loadingState = (loading.vm as any).$.setupState as Record<string, unknown>
    loading.unmount()
    lateGet.resolve(user('user-1', '不应显示'))
    await settle()
    expect(setupValue(loadingState, 'user')).toBeNull()
    expect(state.api).toHaveBeenCalledTimes(1)
    expect(state.api).toHaveBeenLastCalledWith('/api/v1/admin/users/user-1')
    expect(document.body.textContent).not.toContain('不应显示')

    const initial = deferred<any>()
    const post = deferred<any>()
    state.api.mockReset()
    state.api.mockReturnValueOnce(initial.promise).mockReturnValueOnce(post.promise)
    const creating = mount(UserDetail, { attachTo: document.body })
    const creatingState = (creating.vm as any).$.setupState as Record<string, unknown>
    initial.resolve(user('user-1', '用户一'))
    await settle()
    await creating.get('header .actions button.primary').trigger('click')
    await settle()
    await (document.querySelector('#grant-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    creating.unmount()
    post.resolve({ connectionUrl: 'https://example/#token=late-secret' })
    await settle()
    expect(setupValue(creatingState, 'createdSecret')).toBeNull()
    expect(state.api).toHaveBeenCalledTimes(2)
    expect(state.api.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/admin/users/user-1',
      '/api/v1/admin/users/user-1/device-grants'
    ])
    expect(document.body.textContent).not.toContain('late-secret')
  })
})
