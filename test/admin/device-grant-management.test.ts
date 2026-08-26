import { describe, expect, it, vi } from 'vitest'
import { createExclusiveAsyncRequestGate, createRequestLifecycle, deviceGrantQuery, grantActions, grantExpiryPayload, grantStatusLabel } from '../../apps/admin/src/device-grants.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

describe('device grant administration helpers', () => {
  it('offers reversible actions for disabled grants and no actions for deleted grants', () => {
    expect(grantActions({ status: 'DISABLED' })).toEqual(['enable', 'edit-expiry', 'delete'])
    expect(grantActions({ status: 'DELETED' })).toEqual([])
  })

  it('maps the permanent option to a null expiry', () => {
    expect(grantExpiryPayload({ permanent: true, expiresAt: '2026-12-31T00:00' })).toEqual({ expiresAt: null })
  })

  it('converts a local expiry input to ISO and rejects an empty dated expiry', () => {
    expect(grantExpiryPayload({ permanent: false, expiresAt: '2026-12-31T00:00' }).expiresAt).toBe(new Date('2026-12-31T00:00').toISOString())
    expect(() => grantExpiryPayload({ permanent: false, expiresAt: '' })).toThrow('请选择有效期')
  })

  it('builds encoded grouped-list filters', () => {
    expect(deviceGrantQuery({ status: 'EXPIRED', q: '张 三', limit: 50, offset: 0 }))
      .toBe('status=EXPIRED&q=%E5%BC%A0+%E4%B8%89&limit=50&offset=0')
  })

  it('labels and exposes only valid actions for every derived grant status', () => {
    const cases = [
      ['AVAILABLE', '待绑定', ['disable', 'edit-expiry', 'delete']],
      ['BOUND', '已绑定', ['disable', 'edit-expiry', 'delete']],
      ['DISABLED', '已禁用', ['enable', 'edit-expiry', 'delete']],
      ['EXPIRED', '已过期', ['disable', 'edit-expiry', 'delete']],
      ['DELETED', '已删除', []]
    ] as const
    for (const [status, label, actions] of cases) {
      expect(grantStatusLabel(status)).toBe(label)
      expect(grantActions({ status })).toEqual(actions)
    }
  })

  it('rejects late user-detail GET and POST effects after a route change or unmount', async () => {
    const lifecycle = createRequestLifecycle()
    const userOneRequest = lifecycle.next()
    const oldGet = deferred<void>()
    const oldPost = deferred<void>()
    const applied: string[] = []
    const completeGet = oldGet.promise.then(() => { if (lifecycle.isCurrent(userOneRequest)) applied.push('old-user') })
    const completePost = oldPost.promise.then(() => { if (lifecycle.isCurrent(userOneRequest)) applied.push('old-user-secret') })
    const userTwoRequest = lifecycle.next()
    oldGet.resolve()
    oldPost.resolve()
    await Promise.all([completeGet, completePost])
    if (lifecycle.isCurrent(userTwoRequest)) applied.push('new-user')
    lifecycle.dispose()
    if (lifecycle.isCurrent(userTwoRequest)) applied.push('after-unmount')

    expect(applied).toEqual(['new-user'])
  })

  it('runs one create request at a time and releases after success or failure', async () => {
    const pending = vi.fn()
    const gate = createExclusiveAsyncRequestGate(pending)
    const firstRequest = deferred<string>()
    const first = gate.run(() => firstRequest.promise)
    const blocked = await gate.run(async () => 'second')

    expect(blocked).toBeNull()
    expect(gate.pending).toBe(true)
    firstRequest.resolve('created')
    expect(await first).toBe('created')
    expect(gate.pending).toBe(false)
    await expect(gate.run(async () => { throw new Error('conflict') })).rejects.toThrow('conflict')
    expect(gate.pending).toBe(false)
    expect(await gate.run(async () => 'retry')).toBe('retry')
    expect(pending.mock.calls.map(([value]) => value)).toEqual([true, false, true, false, true, false])
  })
})
