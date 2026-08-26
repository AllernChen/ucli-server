// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import Drawer from '../../apps/admin/src/components/Drawer.vue'
import ConfirmDialog from '../../apps/admin/src/components/ConfirmDialog.vue'

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

const user = (id: string, displayName = id) => ({
  id, organizationId: 'org', email: `${id}@example.com`, displayName, status: 'ACTIVE', role: 'MEMBER', createdAt: '2026-01-01T00:00:00.000Z',
  deviceCount: 0, deviceGrantCount: 0, devices: [], deviceGrants: []
})

async function settle() { await nextTick(); await flushPromises(); await nextTick() }

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
})

describe('UserDetail mounted async behavior', () => {
  beforeEach(() => {
    state.route = reactive({ params: reactive({ id: 'user-1' }) })
    state.api.mockReset()
    state.push.mockReset()
    state.toast.mockReset()
  })
  afterEach(() => { document.body.innerHTML = '' })

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
    post.resolve({ token: 'secret', connectionUrl: 'https://example/connect#token=secret' })
    await settle()
    expect(document.body.textContent).toContain('关闭后无法再次查看完整令牌')
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
    post.resolve({ token: 'stale', connectionUrl: 'https://example/#token=stale' })
    userTwo.resolve(user('user-2', '用户二'))
    await settle()
    expect(document.body.textContent).not.toContain('关闭后无法再次查看完整令牌')
    expect(document.body.textContent).toContain('用户二')
    wrapper.unmount()
  })

  it('does not apply late GET or create responses after unmount', async () => {
    const lateGet = deferred<any>()
    state.api.mockReturnValueOnce(lateGet.promise)
    const loading = mount(UserDetail, { attachTo: document.body })
    loading.unmount()
    lateGet.resolve(user('user-1', '不应显示'))
    await settle()
    expect(document.body.textContent).not.toContain('不应显示')

    const initial = deferred<any>()
    const post = deferred<any>()
    state.api.mockReset()
    state.api.mockReturnValueOnce(initial.promise).mockReturnValueOnce(post.promise)
    const creating = mount(UserDetail, { attachTo: document.body })
    initial.resolve(user('user-1', '用户一'))
    await settle()
    await creating.get('header .actions button.primary').trigger('click')
    await settle()
    await (document.querySelector('#grant-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    creating.unmount()
    post.resolve({ token: 'late-secret', connectionUrl: 'https://example/#token=late-secret' })
    await settle()
    expect(document.body.textContent).not.toContain('late-secret')
  })
})
