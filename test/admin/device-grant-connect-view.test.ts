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

  it('uses a nested available preview to permit UCLI connection and copying', async () => {
    state.publicApi.mockResolvedValue(preview('AVAILABLE', 'AVAILABLE'))
    const wrapper = mount(Connect, { attachTo: document.body })
    await settle()

    expect(wrapper.text()).toContain('URL 有效期')
    expect(wrapper.text()).toContain('授权有效期')
    expect(wrapper.findAll('button').map(button => button.text())).toEqual(['连接 UCLI', '复制连接链接'])

    await wrapper.get('details button').trigger('click')
    await settle()
    expect(state.publicApi).toHaveBeenLastCalledWith('/api/v1/auth/device-grants/preview', {
      method: 'POST', body: JSON.stringify({ link: 'grant-secret' })
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('#link=grant-secret'))
    wrapper.unmount()
  })

  it.each([
    ['EXPIRED', 'AVAILABLE'], ['AVAILABLE', 'DISABLED']
  ])('blocks actions when the link or authorization is not available', async (linkStatus, authorizationStatus) => {
    state.publicApi.mockResolvedValue(preview(linkStatus, authorizationStatus))
    const wrapper = mount(Connect, { attachTo: document.body })
    await settle()

    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(state.publicApi).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
