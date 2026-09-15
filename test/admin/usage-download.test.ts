// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { downloadCsv } from '../../apps/admin/src/api.js'

const originalFetch = globalThis.fetch
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
afterEach(() => { globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; vi.restoreAllMocks() })

it('does not create a file for an authenticated download error', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: vi.fn().mockResolvedValue({ message: '登录已过期' }) }) as any
  URL.createObjectURL = vi.fn()
  await expect(downloadCsv('/api/v1/usage/export', 'usage.csv')).rejects.toThrow('登录已过期')
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it('releases the Blob URL after clicking the CSV download link', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, blob: vi.fn().mockResolvedValue(new Blob(['id'])) }) as any
  URL.createObjectURL = vi.fn().mockReturnValue('blob:usage')
  URL.revokeObjectURL = vi.fn()
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await downloadCsv('/api/v1/usage/export', 'usage.csv')
  expect(click).toHaveBeenCalledOnce(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:usage')
})
