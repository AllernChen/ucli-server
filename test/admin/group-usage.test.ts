// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Usage from '../../apps/admin/src/views/Usage.vue'
const state = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: { groupId: 'untrusted-other-group' } }) }))
it('pins embedded logs to the detail group and labels unknown cost without claiming free success', async () => {
  state.api.mockResolvedValue([{ requestId: 'r', startedAt: '2026-09-15T00:00:00Z', employeeName: '历史员工', groupName: '历史组', credentialType: 'API_KEY', keyName: '旧 Key', keyHint: '…abcd', costCny: '0', billingState: 'UNKNOWN', statusCode: 200 }])
  const w = mount(Usage, { props: { groupId: 'actual-group', embedded: true } }); await flushPromises()
  const query = new URL('http://local' + state.api.mock.calls[0][0]).searchParams
  expect(query.get('groupId')).toBe('actual-group')
  expect(w.text()).toContain('历史员工'); expect(w.text()).toContain('旧 Key'); expect(w.text()).toContain('待核对费用，非最终成本')
  expect(w.get('[aria-label="用量组筛选"]').attributes('disabled')).toBeDefined()
  w.unmount()
})
