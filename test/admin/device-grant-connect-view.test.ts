// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const state = vi.hoisted(() => ({ publicApi: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ publicApi: state.publicApi }))

import Connect from '../../apps/admin/src/views/Connect.vue'

const preview = (linkStatus: string, authorizationStatus: string) => ({
  account: { displayName: '成员姓名' }, organization: { name: '组织名称' },
  link: { status: linkStatus, expiresAt: '2026-09-02T04:00:00.000Z' },
  authorization: { status: authorizationStatus, expiresAt: '2026-12-31T04:00:00.000Z', serverTime: '2026-08-27T04:00:00.000Z' }
})

async function settle() { await nextTick(); await flushPromises(); await nextTick() }

describe('device grant connection view', () => {
  beforeEach(() => {
    state.publicApi.mockReset()
    window.history.replaceState({}, '', '/connect#link=grant-secret')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

  it('uses a nested available preview to permit UCLI handoff and copying', async () => {
    state.publicApi.mockResolvedValue(preview('AVAILABLE', 'AVAILABLE'))
    const wrapper = mount(Connect, { attachTo: document.body })
    await settle()

    expect(window.location.hash).toBe('')
    expect(wrapper.text()).toContain('URL 有效期')
    expect(wrapper.text()).toContain('授权有效期')
    expect(wrapper.findAll('button').map(button => button.text())).toEqual(['连接 UCLI', '复制连接链接'])

    await wrapper.get('details button').trigger('click')
    await settle()
    expect(state.publicApi).toHaveBeenLastCalledWith('/api/v1/auth/device-grants/preview', {
      method: 'POST', body: JSON.stringify({ link: 'grant-secret' })
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('#link=grant-secret'))

    await wrapper.get('button.primary').trigger('click')
    await settle()
    expect(window.location.href).toBe('ucli://connect?server=http%3A%2F%2Flocalhost%3A3000#link=grant-secret')
    wrapper.unmount()
  })

  it.each([
    ['EXPIRED', 'AVAILABLE', '可连接', '授权链接已过期，请联系管理员创建新的授权链接。'],
    ['AVAILABLE', 'DISABLED', '已禁用', '授权已被管理员禁用，请联系管理员重新启用。']
  ])('blocks actions and shows specific link or authorization guidance', async (linkStatus, authorizationStatus, authorizationLabel, message) => {
    state.publicApi.mockResolvedValue(preview(linkStatus, authorizationStatus))
    const wrapper = mount(Connect, { attachTo: document.body })
    await settle()

    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(state.publicApi).toHaveBeenCalledTimes(1)
    const rows = Object.fromEntries(wrapper.findAll('dt').map((term, index) => [term.text(), wrapper.findAll('dd')[index].text()]))
    expect(rows['URL 状态']).toBe(linkStatus)
    expect(rows['授权状态']).toBe(authorizationLabel)
    expect(wrapper.text()).toContain(message)
    wrapper.unmount()
  })

  it('clears a stale available preview after terminal link revalidation fails', async () => {
    state.publicApi.mockResolvedValueOnce(preview('AVAILABLE', 'AVAILABLE')).mockRejectedValueOnce(new Error('link_expired'))
    const wrapper = mount(Connect, { attachTo: document.body })
    await settle()

    await wrapper.get('details button').trigger('click')
    await settle()

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(wrapper.find('dl').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.text()).toContain('授权链接已过期，请联系管理员创建新的授权链接。')
    expect(state.publicApi).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})
