// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DeviceGroupMigration from '../../apps/admin/src/components/DeviceGroupMigration.vue'

const state = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: (...args: unknown[]) => state.api(...args) }))
afterEach(() => { state.api.mockReset(); document.body.innerHTML = '' })

it('blocks enforcing groups until the last grant is assigned and sends fixed employee ownership', async () => {
  let assigned = false
  state.api.mockImplementation(async (path: string, options?: { method: string; body: string }) => {
    if (path.includes('/ungrouped?')) return { total: assigned ? 0 : 1, requireDeviceGroup: false,
      items: assigned ? [] : [{ id: 'grant', accountId: 'employee', account: { displayName: '员工' }, deviceId: null }] }
    if (path.endsWith('/usage-groups')) return [{ id: 'group', name: '研发组' }]
    if (path.endsWith('/grant/group')) { expect(JSON.parse(options!.body)).toEqual({ accountId: 'employee', groupId: 'group' }); assigned = true; return {} }
    if (path.endsWith('/group-requirement')) return {}
    throw new Error(path)
  })
  const wrapper = mount(DeviceGroupMigration, { attachTo: document.body })
  await flushPromises()
  expect(wrapper.get('[data-action="group-requirement"]').attributes('disabled')).toBeDefined()
  await wrapper.get('tbody button').trigger('click'); await flushPromises()
  const select = document.querySelector('[aria-label="迁移目标组"]') as HTMLSelectElement
  select.value = 'group'; select.dispatchEvent(new Event('change', { bubbles: true })); await flushPromises()
  document.querySelector('#assign-device-group')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flushPromises()
  expect(wrapper.emitted('changed')).toHaveLength(1)
  expect(wrapper.get('[data-action="group-requirement"]').attributes('disabled')).toBeUndefined()
  await wrapper.get('[data-action="group-requirement"]').trigger('click'); await flushPromises()
  ;(document.querySelector('[role="dialog"] button.primary') as HTMLButtonElement).click(); await flushPromises()
  expect(state.api).toHaveBeenCalledWith('/api/v1/admin/device-grants/group-requirement', { method: 'PATCH', body: '{"required":true}' })
  wrapper.unmount()
})

it('keeps server failures visible and discards pending group choices after changing organizations', async () => {
  let resolve!: (value: unknown) => void
  state.api.mockImplementation((path: string) => path.endsWith('/usage-groups') ? new Promise(r => { resolve = r })
    : Promise.resolve({ total: 0, requireDeviceGroup: false, items: [] }))
  const wrapper = mount(DeviceGroupMigration, { attachTo: document.body })
  await flushPromises()
  const choice = wrapper.vm.choose({ id: 'old', accountId: 'old' })
  await wrapper.setProps({ organizationId: 'another' })
  resolve([{ id: 'old-group', name: '不可泄漏' }]); await choice; await flushPromises()
  expect(document.body.textContent).not.toContain('不可泄漏')
  state.api.mockRejectedValue(new Error('迁移状态读取失败'))
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('迁移状态读取失败')
  wrapper.unmount()
})
